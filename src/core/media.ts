import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ProviderError } from './errors.ts';
import { msg } from './i18n.ts';

const run = promisify(execFile);

export interface MediaInfo {
  path: string;
  sizeBytes: number;
  durationSec: number;
  /** ffprobe format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2". */
  container: string;
  /** Overall bitrate in bits/s. */
  bitrate: number;
  video: {
    codec: string;
    /** Display dimensions, after applying rotation metadata. */
    width: number;
    height: number;
    fps: number;
    pixFmt: string;
  };
  audio?: {
    codec: string;
    sampleRate: number;
    channels: number;
  };
}

/** Platform constraints a file must satisfy. Every field is optional; unset means "no limit known". */
export interface MediaSpec {
  maxBytes?: number;
  minDurationSec?: number;
  maxDurationSec?: number;
  containers?: string[];
  videoCodecs?: string[];
  audioCodecs?: string[];
  minFps?: number;
  maxFps?: number;
  /** bits/s */
  maxBitrate?: number;
  maxAudioSampleRate?: number;
  maxLongEdge?: number;
  minShortEdge?: number;
  /** width / height */
  aspect?: { min: number; max: number };
  /** Make a video that isn't vertical 9:16: 'pad' (blurred fill around it) or 'crop' (the centre). */
  fit?: 'pad' | 'crop';
}

export const FITS = ['pad', 'crop'] as const;

/** Vertical 9:16, give or take a little (1080x1920, 720x1280, phone videos a few pixels off). */
export function isVertical(width: number, height: number): boolean {
  return height > 0 && Math.abs(width / height - 9 / 16) <= 0.02;
}

export interface Violation {
  code: string;
  message: string;
  /** True when re-encoding to H.264/AAC MP4 resolves it without changing the content. */
  fixable: boolean;
}

// ── Probe ──────────────────────────────────────────────────────────

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number }>;
}

interface ProbeOutput {
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
  streams?: ProbeStream[];
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !d) return 0;
  return n / d;
}

/** Pure: turn ffprobe JSON into MediaInfo. Exported for tests. */
export function parseProbe(path: string, probe: ProbeOutput): MediaInfo {
  const v = probe.streams?.find((s) => s.codec_type === 'video');
  if (!v) throw new Error(`${path}: no video stream`);
  const a = probe.streams?.find((s) => s.codec_type === 'audio');
  const rotation = Math.abs(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? Number(v.tags?.rotate ?? 0));
  const sideways = rotation % 180 === 90;
  const width = v.width ?? 0;
  const height = v.height ?? 0;
  return {
    path,
    sizeBytes: Number(probe.format?.size ?? 0),
    durationSec: Number(probe.format?.duration ?? 0),
    container: probe.format?.format_name ?? '',
    bitrate: Number(probe.format?.bit_rate ?? 0),
    video: {
      codec: v.codec_name ?? '',
      width: sideways ? height : width,
      height: sideways ? width : height,
      fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
      pixFmt: v.pix_fmt ?? '',
    },
    audio: a
      ? { codec: a.codec_name ?? '', sampleRate: Number(a.sample_rate ?? 0), channels: a.channels ?? 0 }
      : undefined,
  };
}

export async function probe(path: string): Promise<MediaInfo> {
  // The usual case (an original pruned or moved away) says so, instead of ffprobe's command line.
  if (!existsSync(path)) throw new ProviderError('rejected', 'media.missing', msg('영상 파일이 없습니다: {path}', { path }));
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return parseProbe(path, JSON.parse(stdout) as ProbeOutput);
}

// ── Spec check ─────────────────────────────────────────────────────

const MB = 1024 * 1024;

export function checkMedia(info: MediaInfo, spec: MediaSpec): Violation[] {
  const out: Violation[] = [];
  const { video, audio } = info;
  const longEdge = Math.max(video.width, video.height);
  const shortEdge = Math.min(video.width, video.height);
  const ratio = video.height ? video.width / video.height : 0;

  if (spec.minDurationSec !== undefined && info.durationSec < spec.minDurationSec) {
    out.push({ code: 'duration_short', fixable: false, message: msg('길이 {info}s < 최소 {minDurationSec}s', { info: info.durationSec.toFixed(1), minDurationSec: spec.minDurationSec }) });
  }
  if (spec.maxDurationSec !== undefined && info.durationSec > spec.maxDurationSec) {
    out.push({ code: 'duration_long', fixable: false, message: msg('길이 {info}s > 최대 {maxDurationSec}s', { info: info.durationSec.toFixed(1), maxDurationSec: spec.maxDurationSec }) });
  }
  // A fit makes it 9:16, which every vertical platform takes: nothing about the shape is in the way then.
  const fitting = spec.fit !== undefined && !isVertical(video.width, video.height);
  if (fitting) {
    out.push({ code: 'fit', fixable: true, message: spec.fit === 'crop' ? msg('세로 9:16으로 가운데를 잘라 맞춥니다') : msg('세로 9:16으로 맞추고 남는 곳은 흐린 화면으로 채웁니다') });
  }
  if (!fitting && spec.aspect && (ratio < spec.aspect.min - 0.01 || ratio > spec.aspect.max + 0.01)) {
    out.push({
      code: 'aspect',
      fixable: false,
      message: msg('화면비 {width}x{height} ({ratio})가 허용 범위 {spec}–{spec2} 밖', { width: video.width, height: video.height, ratio: ratio.toFixed(3), spec: spec.aspect.min.toFixed(3), spec2: spec.aspect.max.toFixed(3) }),
    });
  }
  if (spec.minShortEdge !== undefined && shortEdge < spec.minShortEdge) {
    out.push({ code: 'resolution_low', fixable: false, message: msg('짧은 변 {shortEdge}px < 최소 {minShortEdge}px', { shortEdge, minShortEdge: spec.minShortEdge }) });
  }
  if (spec.containers && !spec.containers.some((c) => info.container.split(',').includes(c))) {
    out.push({ code: 'container', fixable: true, message: msg('컨테이너 {container} 미지원', { container: info.container }) });
  }
  if (spec.videoCodecs && !spec.videoCodecs.includes(video.codec)) {
    out.push({ code: 'video_codec', fixable: true, message: msg('영상 코덱 {codec} 미지원 ({spec})', { codec: video.codec, spec: spec.videoCodecs.join('/') }) });
  }
  if (audio && spec.audioCodecs && !spec.audioCodecs.includes(audio.codec)) {
    out.push({ code: 'audio_codec', fixable: true, message: msg('오디오 코덱 {codec} 미지원 ({spec})', { codec: audio.codec, spec: spec.audioCodecs.join('/') }) });
  }
  if (audio && spec.maxAudioSampleRate !== undefined && audio.sampleRate > spec.maxAudioSampleRate) {
    out.push({ code: 'audio_rate', fixable: true, message: msg('샘플레이트 {sampleRate}Hz > {maxAudioSampleRate}Hz', { sampleRate: audio.sampleRate, maxAudioSampleRate: spec.maxAudioSampleRate }) });
  }
  if (spec.maxFps !== undefined && video.fps > spec.maxFps + 0.01) {
    out.push({ code: 'fps_high', fixable: true, message: msg('{video}fps > 최대 {maxFps}fps', { video: video.fps.toFixed(2), maxFps: spec.maxFps }) });
  }
  if (spec.minFps !== undefined && video.fps < spec.minFps - 0.01) {
    out.push({ code: 'fps_low', fixable: true, message: msg('{video}fps < 최소 {minFps}fps', { video: video.fps.toFixed(2), minFps: spec.minFps }) });
  }
  if (spec.maxLongEdge !== undefined && longEdge > spec.maxLongEdge) {
    out.push({ code: 'resolution_high', fixable: true, message: msg('긴 변 {longEdge}px > 최대 {maxLongEdge}px', { longEdge, maxLongEdge: spec.maxLongEdge }) });
  }
  if (spec.maxBitrate !== undefined && info.bitrate > spec.maxBitrate) {
    out.push({
      code: 'bitrate',
      fixable: true,
      message: msg('비트레이트 {info}Mbps > {spec}Mbps', { info: (info.bitrate / 1e6).toFixed(1), spec: (spec.maxBitrate / 1e6).toFixed(1) }),
    });
  }
  if (spec.maxBytes !== undefined && info.sizeBytes > spec.maxBytes) {
    // Re-encoding can shrink the file only if a sane bitrate fits the budget.
    const budgetBps = (spec.maxBytes * 8 * 0.95) / Math.max(info.durationSec, 1);
    out.push({
      code: 'size',
      fixable: budgetBps >= 1_000_000,
      message: msg('파일 {info}MB > 최대 {spec}MB', { info: (info.sizeBytes / MB).toFixed(0), spec: (spec.maxBytes / MB).toFixed(0) }),
    });
  }
  return out;
}

// ── Conditional transcode ──────────────────────────────────────────

/**
 * Build ffmpeg args that fix every fixable violation while staying as close to the original as possible.
 * Pure; exported for tests.
 */
export function transcodeArgs(info: MediaInfo, spec: MediaSpec, output: string): string[] {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', info.path];
  const filters: string[] = [];

  const longEdge = Math.max(info.video.width, info.video.height);
  if (spec.fit && !isVertical(info.video.width, info.video.height)) {
    // 1080x1920, or smaller when the platform caps the long edge lower; even sizes for H.264.
    const H = Math.min(1920, spec.maxLongEdge ?? 1920);
    const W = Math.round((H * 9) / 16 / 2) * 2;
    const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
    filters.push(
      spec.fit === 'crop'
        ? `${cover},setsar=1`
        : `split[bg][fg];[bg]${cover},boxblur=20:2[blur];[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease[sharp];[blur][sharp]overlay=(W-w)/2:(H-h)/2,setsar=1`,
    );
  } else if (spec.maxLongEdge !== undefined && longEdge > spec.maxLongEdge) {
    const scale = spec.maxLongEdge / longEdge;
    const w = Math.round((info.video.width * scale) / 2) * 2;
    const h = Math.round((info.video.height * scale) / 2) * 2;
    filters.push(`scale=${w}:${h}`);
  }
  let fps = info.video.fps;
  if (spec.maxFps !== undefined && fps > spec.maxFps) fps = spec.maxFps;
  if (spec.minFps !== undefined && fps < spec.minFps) fps = spec.minFps;
  if (fps !== info.video.fps) filters.push(`fps=${fps}`);
  if (filters.length) args.push('-vf', filters.join(','));

  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-profile:v', 'high');

  let capBps = spec.maxBitrate;
  if (spec.maxBytes !== undefined) {
    const budget = Math.floor((spec.maxBytes * 8 * 0.95) / Math.max(info.durationSec, 1)) - 192_000;
    capBps = capBps === undefined ? budget : Math.min(capBps, budget);
  }
  // A size budget only matters when it is tighter than anything CRF 18 would produce in practice.
  if (capBps !== undefined && capBps < 100_000_000) {
    const v = Math.max(capBps - 192_000, 500_000);
    args.push('-maxrate', String(v), '-bufsize', String(v * 2));
  }

  if (info.audio) {
    const rate = Math.min(info.audio.sampleRate || 48_000, spec.maxAudioSampleRate ?? 48_000);
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', String(rate));
  } else {
    args.push('-an');
  }
  args.push('-movflags', '+faststart', output);
  return args;
}

/**
 * Return a file satisfying `spec`: the original when nothing fixable is wrong, otherwise a cached
 * H.264/AAC MP4 variant under `<variantsDir>`.
 */
export async function ensureVariant(
  info: MediaInfo,
  spec: MediaSpec,
  variantsDir: string,
): Promise<{ path: string; transcoded: boolean; reasons: string[] }> {
  const fixable = checkMedia(info, spec).filter((v) => v.fixable);
  if (!fixable.length) return { path: info.path, transcoded: false, reasons: [] };

  const st = statSync(info.path);
  const key = createHash('sha256')
    .update(JSON.stringify([info.path, st.size, st.mtimeMs, spec]))
    .digest('hex')
    .slice(0, 16);
  mkdirSync(variantsDir, { recursive: true });
  const output = join(variantsDir, `${key}.mp4`);
  const reasons = fixable.map((v) => v.message);
  if (existsSync(output)) return { path: output, transcoded: true, reasons };

  const partial = `${output}.part.mp4`;
  await run('ffmpeg', transcodeArgs(info, spec, partial), { maxBuffer: 16 * 1024 * 1024 });
  renameSync(partial, output);
  return { path: output, transcoded: true, reasons };
}

/**
 * One frame of a video as a JPEG thumbnail (long edge up to 1280 px, well under the 2 MB limit).
 * The name comes from the video and the moment, so asking again reuses it. Returns its path.
 */
export async function extractFrame(info: MediaInfo, atSec: number, dir: string): Promise<string> {
  if (!(atSec >= 0) || atSec > info.durationSec) {
    throw new Error(msg('썸네일 장면은 0초~영상 길이({length}초) 사이여야 합니다', { length: info.durationSec.toFixed(1) }));
  }
  const st = statSync(info.path);
  const key = createHash('sha256').update(JSON.stringify([info.path, st.size, st.mtimeMs, atSec])).digest('hex').slice(0, 16);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const output = join(dir, `frame-${key}.jpg`);
  if (existsSync(output)) return output;
  const partial = `${output}.part.jpg`;
  // A frame right at the end may not exist; step back a little from the very last moment.
  const at = Math.max(0, Math.min(atSec, info.durationSec - 0.05));
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', info.path, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '3', partial]);
  renameSync(partial, output);
  return output;
}

/**
 * The same moment as the cover where a platform picks the cover from the video itself (Instagram
 * thumb_offset, TikTok cover timestamp), unless a target already says otherwise.
 */
export function withCoverMoment<T extends { platform: string; options: Record<string, unknown> }>(targets: T[], atSec: number): T[] {
  const ms = Math.round(atSec * 1000);
  return targets.map((t) => {
    if (t.platform === 'instagram' && t.options.thumbOffsetMs === undefined) return { ...t, options: { ...t.options, thumbOffsetMs: ms } };
    if (t.platform === 'tiktok' && t.options.coverTimestampMs === undefined && t.options.mode === 'direct') return { ...t, options: { ...t.options, coverTimestampMs: ms } };
    return t;
  });
}

/** A tiny vertical test clip for `fanout doctor`. */
export async function makeTestClip(output: string, seconds = 4): Promise<void> {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=1080x1920:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    output,
  ]);
}

const hashCache = new Map<string, string>();

/** SHA-256 of a file's contents (streamed), cached by path + size + mtime. */
export async function fileHash(path: string): Promise<string> {
  const st = statSync(path);
  // The inode too: a different file put in its place (a hard link) isn't the cached one.
  const key = `${path}:${st.ino}:${st.size}:${st.mtimeMs}`;
  const cached = hashCache.get(key);
  if (cached) return cached;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const hex = hash.digest('hex');
  hashCache.set(key, hex);
  return hex;
}
