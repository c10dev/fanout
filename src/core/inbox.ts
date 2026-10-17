// Watch folder ("inbox"): drop a video into a folder and fanout posts it to the platforms set in that
// folder's fanout.watch.json, with optional per-video overrides in a sidecar <video>.json.
//
// Pure planning lives here (config parsing, templating, deciding targets); the CLI owns the loop.

import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { msg } from './i18n.ts';
import { fileHash, type MediaInfo } from './media.ts';
import { assessMedia, createScheduledPost, describePrior, priorPosts } from './posting.ts';
import type { Provider } from './provider.ts';
import type { Store } from './store.ts';
import type { CaptionFile, Post, PostInput, Target, TargetInput } from './types.ts';

export const CONFIG_FILE = 'fanout.watch.json';
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];

/** Shared by the folder config and the sidecar; the sidecar wins field by field. */
export interface WatchFields {
  /** Targets as "platform" or "platform:account". */
  to?: string[];
  title?: string;
  description?: string;
  tags?: string[];
  /** Provider option objects keyed by platform, e.g. { youtube: { privacy: 'public', madeForKids: false } }. */
  options?: Record<string, Record<string, unknown>>;
  /** Template variables, e.g. { artist: 'NewJeans', song: 'Ditto' } → "{artist} - {song}". */
  vars?: Record<string, string>;
  ai?: boolean;
  /** ISO-8601 time to publish at. */
  at?: string;
  thumbnail?: string;
  /** language → subtitle file, relative to the watched folder. */
  captions?: Record<string, string>;
}

export interface WatchConfig extends WatchFields {
  /**
   * What to do with a platform whose limits the video breaks in a way transcoding cannot fix (e.g. a
   * 2-minute video for Facebook Reels): "skip" posts to the rest, "fail" rejects the whole video.
   */
  onBlocked?: 'skip' | 'fail';
  /**
   * The same video (by content) already went to a platform account: "skip" leaves that target out
   * (default — a copied file shouldn't post twice), "post" posts again anyway.
   */
  onDuplicate?: 'skip' | 'post';
  /**
   * Daily posting times ("HH:MM", this machine's local time). A video without its own `at` is
   * scheduled for the next slot no other post already takes, so a batch dropped at once goes out one
   * per slot instead of all together.
   */
  slots?: string[];
}

export class WatchConfigError extends Error {}

export interface Plan {
  input: PostInput;
  targets: TargetInput[];
  /** Platforms dropped because the video cannot be posted there, with the reason. */
  skipped: Array<{ platform: string; reason: string }>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkFields(raw: Record<string, unknown>, where: string): WatchFields {
  const strArray = (k: string) => {
    const v = raw[k];
    if (v === undefined) return;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new WatchConfigError(msg('{where}: "{k}"는 문자열 배열이어야 합니다', { where, k }));
  };
  const str = (k: string) => {
    if (raw[k] !== undefined && typeof raw[k] !== 'string') throw new WatchConfigError(msg('{where}: "{k}"는 문자열이어야 합니다', { where, k }));
  };
  const strMap = (k: string) => {
    const v = raw[k];
    if (v === undefined) return;
    if (!isRecord(v) || Object.values(v).some((x) => typeof x !== 'string')) throw new WatchConfigError(msg('{where}: "{k}"는 문자열 값만 가진 객체여야 합니다', { where, k }));
  };
  strArray('to');
  strArray('tags');
  for (const k of ['title', 'description', 'at', 'thumbnail']) str(k);
  strMap('vars');
  strMap('captions');
  if (raw.ai !== undefined && typeof raw.ai !== 'boolean') throw new WatchConfigError(msg('{where}: "ai"는 true 또는 false', { where }));
  if (raw.options !== undefined && (!isRecord(raw.options) || Object.values(raw.options).some((o) => !isRecord(o)))) {
    throw new WatchConfigError(msg('{where}: "options"는 { 플랫폼: { 옵션 } } 형태여야 합니다', { where }));
  }
  if (typeof raw.at === 'string' && Number.isNaN(Date.parse(raw.at))) throw new WatchConfigError(msg('{where}: "at"은 ISO-8601 시각이어야 합니다', { where }));
  return raw as WatchFields;
}

function readJson(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new WatchConfigError(msg('{file}: JSON을 읽을 수 없습니다 ({err})', { file: basename(path), err: (err as Error).message }));
  }
  if (!isRecord(parsed)) throw new WatchConfigError(msg('{file}: 최상위가 객체여야 합니다', { file: basename(path) }));
  return parsed;
}

export function loadWatchConfig(dir: string): WatchConfig {
  const path = join(dir, CONFIG_FILE);
  if (!existsSync(path)) throw new WatchConfigError(msg('{path} 가 없습니다. fanout watch --init {dir} 로 예시를 만드세요', { path, dir }));
  const raw = readJson(path);
  const config = checkFields(raw, CONFIG_FILE) as WatchConfig;
  if (raw.onBlocked !== undefined && raw.onBlocked !== 'skip' && raw.onBlocked !== 'fail') {
    throw new WatchConfigError(msg('{file}: "onBlocked"는 "skip" 또는 "fail"', { file: CONFIG_FILE }));
  }
  // A typo here must not quietly mean "post duplicates".
  if (raw.onDuplicate !== undefined && raw.onDuplicate !== 'skip' && raw.onDuplicate !== 'post') {
    throw new WatchConfigError(msg('{file}: "onDuplicate"는 "skip" 또는 "post"', { file: CONFIG_FILE }));
  }
  if (!config.to?.length) throw new WatchConfigError(msg('{file}: "to"에 올릴 곳을 하나 이상 적으세요 (예: ["youtube", "tiktok"])', { file: CONFIG_FILE }));
  if (raw.slots !== undefined) {
    if (!Array.isArray(raw.slots) || !raw.slots.length || raw.slots.some((s) => typeof s !== 'string' || !SLOT.test(s))) {
      throw new WatchConfigError(msg('{file}: "slots"는 "HH:MM" 시각의 배열이어야 합니다 (예: ["12:00", "19:00"])', { file: CONFIG_FILE }));
    }
    // Every slotted video is a scheduled YouTube upload, and YouTube schedules only public videos.
    const youtube = config.to.some((s) => s.split(':')[0] === 'youtube');
    const privacy = config.options?.youtube?.privacy;
    if (youtube && privacy !== 'public') {
      throw new WatchConfigError(msg('{file}: "slots"를 쓰면 YouTube 영상은 예약 게시가 되는데, YouTube 예약은 public만 됩니다. options.youtube.privacy를 "public"으로 하거나 slots를 빼세요 (지금: {privacy})', { file: CONFIG_FILE, privacy: privacy == null ? msg('없음') : String(privacy) }));
    }
  }
  return config;
}

const SLOT = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Leave room for platforms that refuse schedules too close (Facebook 10 min, Mastodon 5). */
const SLOT_LEAD_MS = 15 * 60_000;
const SLOT_HORIZON_DAYS = 120;

/**
 * The next daily slot at least 15 minutes ahead that no live post is already scheduled at. Slots are
 * in this machine's local time (set TZ in a container).
 */
export function nextFreeSlot(slots: string[], taken: ReadonlySet<string>, now: Date): string {
  const times = [...new Set(slots)].map((s) => s.split(':').map(Number) as [number, number]);
  for (let day = 0; day < SLOT_HORIZON_DAYS; day++) {
    const candidates = times
      .map(([h, m]) => {
        const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, h, m, 0, 0);
        // A time that doesn't exist that day (skipped by a daylight-saving change) is no slot.
        return at.getHours() === h && at.getMinutes() === m ? at : undefined;
      })
      .filter((at): at is Date => Boolean(at))
      .sort((a, b) => a.getTime() - b.getTime());
    for (const at of candidates) {
      if (at.getTime() - now.getTime() < SLOT_LEAD_MS) continue;
      const iso = at.toISOString();
      if (!taken.has(iso)) return iso;
    }
  }
  throw new WatchConfigError(msg('앞으로 {days}일 동안 빈 예약 슬롯이 없습니다', { days: SLOT_HORIZON_DAYS }));
}

/** Sidecar next to the video: "clip.mp4" → "clip.json" (or "clip.mp4.json"). */
export function sidecarPath(videoPath: string): string | undefined {
  const stem = videoPath.slice(0, -extname(videoPath).length);
  return [`${stem}.json`, `${videoPath}.json`].find((p) => existsSync(p));
}

export function loadSidecar(videoPath: string): WatchFields {
  const path = sidecarPath(videoPath);
  return path ? checkFields(readJson(path), basename(path)) : {};
}

/** Replace {key} with vars[key]; unknown keys are an error so typos don't get published. */
export function render(template: string, vars: Record<string, string>, field: string): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new WatchConfigError(msg('{field}: 템플릿 변수 {{key}}의 값이 없습니다 (vars에 넣으세요)', { field, key }));
    return v;
  });
}

function renderDeep(value: unknown, vars: Record<string, string>, field: string): unknown {
  if (typeof value === 'string') return render(value, vars, field);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars, field));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, vars, `${field}.${k}`)]));
  return value;
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Merge folder config + sidecar into a post and its targets for one video. Platforms the video cannot
 * go to are skipped or rejected according to `onBlocked`.
 */
export function planPost(args: {
  videoPath: string;
  dir: string;
  config: WatchConfig;
  sidecar: WatchFields;
  media: MediaInfo;
  providers: Map<string, Provider>;
  now: Date;
}): Plan {
  const { videoPath, dir, config, sidecar, media, providers, now } = args;
  const name = basename(videoPath, extname(videoPath));
  const vars: Record<string, string> = { name, date: localDate(now), ...config.vars, ...sidecar.vars };

  const titleTemplate = sidecar.title ?? config.title ?? '{name}';
  const title = render(titleTemplate, vars, 'title').trim();
  if (!title) throw new WatchConfigError(msg('제목이 비어 있습니다'));
  vars.title = title;

  const tags = [...new Set([...(config.tags ?? []), ...(sidecar.tags ?? [])].map((t) => render(t, vars, 'tags').trim()).filter(Boolean))];
  vars.tags = tags.map((t) => `#${t.replace(/\s+/g, '')}`).join(' ');
  const description = render(sidecar.description ?? config.description ?? '', vars, 'description');

  const fromDir = (p: string) => resolve(dir, p);
  const thumbnail = sidecar.thumbnail ?? config.thumbnail;
  const captionsMap = { ...config.captions, ...sidecar.captions };
  const captions: CaptionFile[] = Object.entries(captionsMap).map(([language, p]) => ({ language, path: fromDir(p) }));
  for (const c of captions) if (!existsSync(c.path)) throw new WatchConfigError(msg('자막 파일 없음: {path}', { path: c.path }));
  if (thumbnail && !existsSync(fromDir(thumbnail))) throw new WatchConfigError(msg('썸네일 파일 없음: {path}', { path: fromDir(thumbnail) }));

  const at = sidecar.at ?? config.at;
  const input: PostInput = {
    mediaPath: videoPath,
    title,
    description,
    tags,
    thumbnailPath: thumbnail ? fromDir(thumbnail) : undefined,
    captions,
    containsSyntheticMedia: sidecar.ai ?? config.ai ?? false,
    scheduledAt: at ? new Date(at).toISOString() : undefined,
  };

  const wanted = (sidecar.to ?? config.to ?? []).map((spec) => {
    const [platform = '', account = 'main'] = spec.trim().split(':');
    if (!providers.has(platform)) throw new WatchConfigError(msg('알 수 없는 플랫폼: {platform} (가능: {providers})', { platform, providers: [...providers.keys()].join(', ') }));
    return { platform, account };
  });
  if (!wanted.length) throw new WatchConfigError(msg('올릴 곳(to)이 없습니다'));

  const assessments = new Map(assessMedia(media, wanted.map((w) => providers.get(w.platform)!)).map((a) => [a.platform, a]));
  const skipped: Plan['skipped'] = [];
  const targets: TargetInput[] = [];
  for (const w of wanted) {
    const a = assessments.get(w.platform)!;
    if (a.verdict === 'blocked') {
      const reason = a.violations.filter((v) => !v.fixable).map((v) => v.message).join(' / ');
      if ((config.onBlocked ?? 'skip') === 'fail') throw new WatchConfigError(msg('{platform}에 올릴 수 없는 영상입니다: {reason}', { platform: w.platform, reason }));
      skipped.push({ platform: w.platform, reason });
      continue;
    }
    const options = { ...config.options?.[w.platform], ...sidecar.options?.[w.platform] };
    targets.push({ platform: w.platform, account: w.account, options: renderDeep(options, vars, `options.${w.platform}`) as Record<string, unknown> });
  }
  if (!targets.length) throw new WatchConfigError(msg('올릴 수 있는 플랫폼이 없습니다: {skipped}', { skipped: skipped.map((s) => `${s.platform} (${s.reason})`).join(' / ') }));
  return { input, targets, skipped };
}

// ── Folder scanning ────────────────────────────────────────────────

export interface FileSeen {
  size: number;
  mtimeMs: number;
}

/**
 * A file is ready once its size and mtime have not changed between two scans and it is at least
 * `settleMs` old, so we don't pick up a video that is still being copied or exported.
 */
export class Scanner {
  private seen = new Map<string, FileSeen>();
  private readonly dir: string;
  private readonly settleMs: number;
  private readonly now: () => number;
  constructor(dir: string, settleMs: number, now: () => number = Date.now) {
    this.dir = dir;
    this.settleMs = settleMs;
    this.now = now;
  }

  /** `requireTwoScans: false` is for one-shot runs (cron), where only the age check applies. */
  ready(requireTwoScans = true): string[] {
    const out: string[] = [];
    const present = new Set<string>();
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      if (!VIDEO_EXTENSIONS.includes(extname(entry.name).toLowerCase())) continue;
      const path = join(this.dir, entry.name);
      present.add(path);
      const st = statSync(path);
      const prev = this.seen.get(path);
      this.seen.set(path, { size: st.size, mtimeMs: st.mtimeMs });
      const stable = !requireTwoScans || (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs);
      if (stable && st.size > 0 && this.now() - st.mtimeMs >= this.settleMs) out.push(path);
    }
    for (const p of this.seen.keys()) if (!present.has(p)) this.seen.delete(p);
    return out.sort();
  }

  forget(path: string): void {
    this.seen.delete(path);
  }
}

/** Move a file into dir/sub, adding " (2)", " (3)"… if the name is taken. Returns the new path. */
/** Where `path` would land in `dir/sub` without overwriting anything: "clip.mp4", "clip (2).mp4", … */
export function freePath(path: string, dir: string, sub: string): string {
  const destDir = join(dir, sub);
  const ext = extname(path);
  const stem = basename(path, ext);
  let dest = join(destDir, basename(path));
  for (let i = 2; existsSync(dest); i++) dest = join(destDir, `${stem} (${i})${ext}`);
  return dest;
}

export function moveInto(path: string, dir: string, sub: string, dest = freePath(path, dir, sub)): string {
  mkdirSync(join(dir, sub), { recursive: true });
  renameSync(path, dest);
  return dest;
}

/** Move a video and its sidecar together. Returns the video's new path. */
export function moveVideo(videoPath: string, dir: string, sub: string, dest?: string): string {
  const side = sidecarPath(videoPath);
  dest = moveInto(videoPath, dir, sub, dest);
  if (side) {
    // Keep the sidecar paired with the (possibly renamed) video: "clip (2).mp4" ↔ "clip (2).json".
    let pairedSide = dest.slice(0, -extname(dest).length) + '.json';
    for (let i = 2; existsSync(pairedSide); i++) pairedSide = `${dest}.${i}.json`;
    renameSync(side, pairedSide);
  }
  return dest;
}

export function writeError(videoPathInFailed: string, message: string): void {
  writeFileSync(`${videoPathInFailed}.error.txt`, `${new Date().toISOString()}\n${message}\n`);
}

export type IngestResult =
  | { ok: true; postId: string; movedTo: string; plan: Plan }
  | { ok: false; error: string; movedTo: string };

/**
 * Turn one ready video into a post. On success the video (and sidecar) move to posted/ and the post
 * points at that path; on any planning error they move to failed/ with a .error.txt next to them,
 * so nothing is picked up twice and nothing fails silently.
 */
export async function ingest(args: {
  dir: string;
  config: WatchConfig;
  videoPath: string;
  providers: Map<string, Provider>;
  store: Store;
  probe: (path: string) => Promise<MediaInfo>;
  now: Date;
}): Promise<IngestResult> {
  const { dir, config, videoPath, providers, store, now } = args;
  let plan: Plan;
  let media: MediaInfo;
  try {
    media = await args.probe(videoPath);
    plan = planPost({ videoPath, dir, config, sidecar: loadSidecar(videoPath), media, providers, now });
  } catch (err) {
    // ffprobe failures are long; its last line ("…: Invalid data found when processing input") says enough.
    const detail = (err as Error).message.trim().split('\n').pop()?.replace(/^.*?:\s(?=[^:]+$)/, '') ?? '';
    const error = err instanceof WatchConfigError ? err.message : msg('영상을 읽을 수 없습니다: {detail}', { detail });
    const movedTo = moveVideo(videoPath, dir, 'failed');
    writeError(movedTo, error);
    return { ok: false, error, movedTo };
  }
  plan.input.mediaHash = await fileHash(videoPath);
  if ((config.onDuplicate ?? 'skip') === 'skip') {
    const prior = priorPosts(store, plan.input.mediaHash, plan.targets);
    const fresh = plan.targets.filter((t) => !prior.has(`${t.platform}/${t.account}`));
    for (const t of plan.targets) {
      const before = prior.get(`${t.platform}/${t.account}`)?.[0];
      if (before) plan.skipped.push({ platform: t.platform, reason: describePrior(before) });
    }
    if (!fresh.length) {
      const error = msg('이미 올린 영상이라 건너뜁니다 (다시 올리려면 onDuplicate: "post"): {skipped}', { skipped: plan.skipped.map((s) => `${s.platform} — ${s.reason}`).join(' / ') });
      const failedTo = moveVideo(videoPath, dir, 'failed');
      writeError(failedTo, error);
      return { ok: false, error, movedTo: failedTo };
    }
    plan.targets = fresh;
  }
  // The post will point into posted/: make sure the video can actually go there first.
  try {
    mkdirSync(join(dir, 'posted'), { recursive: true });
    accessSync(join(dir, 'posted'), fsConstants.W_OK);
  } catch (err) {
    throw new Error(msg('{dir} 에 쓸 수 없습니다: {err}', { dir: join(dir, 'posted'), err: (err as Error).message }));
  }
  // Pick the slot and create the post in one transaction, so two watchers can't take the same slot.
  let created: { postId: string; movedTo: string } | undefined;
  try {
    created = store.transaction(() => {
      if (!plan.input.scheduledAt && config.slots?.length) {
        plan.input.scheduledAt = nextFreeSlot(config.slots, new Set(store.scheduledTimes(now.toISOString())), now);
      }
      // Now that the time is known, catch what the upload would only find out later (e.g. YouTube
      // schedules only public videos) and treat it like a platform the video can't go to.
      const draft: Post = { ...plan.input, id: 'plan', createdAt: now.toISOString() };
      const kept: TargetInput[] = [];
      for (const t of plan.targets) {
        const target: Target = { id: 'plan', postId: 'plan', platform: t.platform, account: t.account, options: t.options, state: 'queued', warnings: [], attempts: 0, updatedAt: draft.createdAt };
        const errors = providers.get(t.platform)!.validate(draft, target, media).filter((i) => i.severity === 'error').map((i) => i.message);
        if (!errors.length) kept.push(t);
        else if ((config.onBlocked ?? 'skip') === 'fail') throw new WatchConfigError(`${t.platform}: ${errors.join(' / ')}`);
        else plan.skipped.push({ platform: t.platform, reason: errors.join(' / ') });
      }
      if (!kept.length) throw new WatchConfigError(msg('올릴 수 있는 플랫폼이 없습니다: {skipped}', { skipped: plan.skipped.map((s) => `${s.platform} (${s.reason})`).join(' / ') }));
      plan.targets = kept;
      // The post points at where the video is about to go; files move only once the post is
      // committed, so a refused write leaves the video and its sidecar where they were.
      const movedTo = freePath(videoPath, dir, 'posted');
      plan.input.mediaPath = movedTo;
      return { postId: createScheduledPost(store, providers, plan.input, plan.targets).post.id, movedTo };
    });
    try {
      moveVideo(videoPath, dir, 'posted', created.movedTo);
    } catch (err) {
      // The post exists but its file didn't move (e.g. the video vanished, a sync tool renamed it):
      // call the post off rather than leave targets queued for a file that isn't there.
      for (const t of store.targetsForPost(created.postId)) if (t.state === 'queued') store.transition(t.id, 'canceled', {}, 'video could not be moved into posted/');
      throw new Error(msg('게시물을 만들었지만 영상을 posted/ 로 옮기지 못해 취소했습니다: {err}', { err: (err as Error).message }));
    }
  } catch (err) {
    if (!(err instanceof WatchConfigError)) throw err;
    const movedTo = moveVideo(videoPath, dir, 'failed');
    writeError(movedTo, err.message);
    return { ok: false, error: err.message, movedTo };
  }
  return { ok: true, postId: created.postId, movedTo: created.movedTo, plan };
}

const EXAMPLE_OPTIONS: Record<string, Record<string, unknown>> = {
  // Unlisted until the folder has been tried once; switch to "public" when happy.
  youtube: { privacy: 'unlisted', madeForKids: false, categoryId: '22' },
  tiktok: { mode: 'inbox' },
  instagram: { shareToFeed: true },
  facebook: {},
};

/**
 * Example fanout.watch.json for `fanout watch --init`. Targets the accounts actually connected
 * (preferring one named "main"), so the file works as written; falls back to `<platform>:main`.
 */
export function exampleConfig(accounts: ReadonlyArray<{ platform: string; name: string }>): WatchConfig {
  const platforms = Object.keys(EXAMPLE_OPTIONS);
  const connected = platforms.filter((p) => accounts.some((a) => a.platform === p));
  const chosen = connected.length ? connected : platforms;
  return {
    to: chosen.map((p) => `${p}:${defaultAccountName(accounts, p)}`),
    title: '{name}',
    description: '{title}\n\n{tags}',
    tags: ['shorts'],
    onBlocked: 'skip',
    options: Object.fromEntries(chosen.map((p) => [p, EXAMPLE_OPTIONS[p]!])),
  };
}

/** "main" if connected, else the only connected account, else "main". */
export function defaultAccountName(accounts: ReadonlyArray<{ platform: string; name: string }>, platform: string): string {
  const names = accounts.filter((a) => a.platform === platform).map((a) => a.name);
  if (names.includes('main') || names.length !== 1) return 'main';
  return names[0]!;
}
