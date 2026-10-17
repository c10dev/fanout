import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkMedia, ensureVariant, parseProbe, probe, transcodeArgs } from '../src/core/media.ts';
import { facebook } from '../src/providers/facebook.ts';
import { instagram } from '../src/providers/instagram.ts';
import { tiktok } from '../src/providers/tiktok.ts';
import { fakeMedia } from './helpers.ts';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('parseProbe', () => {
  it('applies rotation metadata to display dimensions', () => {
    const info = parseProbe('/p.mov', {
      format: { format_name: 'mov,mp4', duration: '12.5', size: '1000', bit_rate: '8000' },
      streams: [
        { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, avg_frame_rate: '30000/1001', side_data_list: [{ rotation: -90 }] },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 },
      ],
    });
    assert.equal(info.video.width, 1080);
    assert.equal(info.video.height, 1920);
    assert.ok(Math.abs(info.video.fps - 29.97) < 0.01);
    assert.equal(info.audio?.sampleRate, 44100);
  });

  it('rejects files without video', () => {
    assert.throws(() => parseProbe('/a.m4a', { streams: [{ codec_type: 'audio' }] }), /no video/);
  });
});

describe('checkMedia', () => {
  it('passes a typical vertical H.264 clip for Reels and TikTok', () => {
    const m = fakeMedia();
    assert.deepEqual(checkMedia(m, instagram.spec), []);
    assert.deepEqual(checkMedia(m, tiktok.spec), []);
    assert.deepEqual(checkMedia(m, facebook.spec), []);
  });

  it('marks codec/fps/sample-rate as fixable and duration/aspect as blocking', () => {
    const m = fakeMedia({ durationSec: 120, audio: { codec: 'aac', sampleRate: 96_000, channels: 2 } }, { codec: 'hevc', fps: 120, width: 1920, height: 1080 });
    const v = checkMedia(m, facebook.spec);
    const byCode = Object.fromEntries(v.map((x) => [x.code, x.fixable]));
    assert.equal(byCode.video_codec, true);
    assert.equal(byCode.fps_high, true);
    assert.equal(byCode.audio_rate, true);
    assert.equal(byCode.duration_long, false);
    assert.equal(byCode.aspect, false);
  });

  it('treats an oversized file as fixable only when a sane bitrate fits', () => {
    const big = fakeMedia({ sizeBytes: 600 * 1024 * 1024, durationSec: 60 });
    assert.equal(checkMedia(big, instagram.spec).find((x) => x.code === 'size')?.fixable, true);
    const hopeless = fakeMedia({ sizeBytes: 600 * 1024 * 1024, durationSec: 3 * 3600 });
    assert.equal(checkMedia(hopeless, { maxBytes: 300 * 1024 * 1024 }).find((x) => x.code === 'size')?.fixable, false);
  });
});

describe('transcodeArgs', () => {
  it('scales, caps fps and resamples audio only as needed', () => {
    const m = fakeMedia({ audio: { codec: 'pcm_s16le', sampleRate: 96_000, channels: 2 } }, { width: 2160, height: 3840, fps: 120 });
    const args = transcodeArgs(m, instagram.spec, '/out.mp4');
    const vf = args[args.indexOf('-vf') + 1];
    assert.equal(vf, 'scale=1080:1920,fps=60');
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
    assert.equal(args[args.indexOf('-ar') + 1], '48000');
    assert.ok(args.includes('-maxrate'));
    assert.equal(args.at(-1), '/out.mp4');
  });

  it('adds no filters when only the codec is wrong', () => {
    const args = transcodeArgs(fakeMedia({}, { codec: 'hevc' }), tiktok.spec, '/o.mp4');
    assert.ok(!args.includes('-vf'));
    assert.ok(!args.includes('-maxrate'));
  });
});

describe('ensureVariant (ffmpeg)', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  it('keeps a compliant original and transcodes a non-compliant one once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fanout-media-'));
    const src = join(dir, 'hevc120.mp4');
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=120:duration=2',
      '-f', 'lavfi', '-i', 'sine=sample_rate=96000:duration=2',
      '-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', '-c:a', 'aac', src,
    ]);
    const info = await probe(src);
    assert.equal(info.video.codec, 'hevc');

    const kept = await ensureVariant(info, { maxBytes: 1e12 }, join(dir, 'variants'));
    assert.equal(kept.transcoded, false);
    assert.equal(kept.path, src);

    const v = await ensureVariant(info, tiktok.spec, join(dir, 'variants'));
    assert.equal(v.transcoded, true);
    const out = await probe(v.path);
    assert.equal(out.video.codec, 'h264');
    assert.ok(out.video.fps <= 60.01);
    assert.deepEqual(checkMedia(out, tiktok.spec), []);

    const again = await ensureVariant(info, tiktok.spec, join(dir, 'variants'));
    assert.equal(again.path, v.path);
  });
});
