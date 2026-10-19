import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { extractFrame, fileHash, probe as realProbe, withCoverMoment, type MediaInfo } from '../core/media.ts';
import { accountLabel, addTargets, appReady, assessMedia, cancelTarget, changeVisibility, commentInbox, createScheduledPost, editPost, fetchComments, hideComment, MaybeDuplicateError, MaybeLiveError, mayBeDuplicate, planAddTargets, previewPost, refreshStats, removeTarget, replyToComment, retryTarget, suggestCrossPosts, withTimeout } from '../core/posting.ts';
import { applyPrune, formatBytes, planPrune } from '../core/prune.ts';
import { ProviderError } from '../core/errors.ts';
import { msg, translate, translateDeep, type Lang } from '../core/i18n.ts';
import { DEFAULT_EVENTS, detectFormat, eventsToSave, KNOWN_EVENTS, notifyConfig, send as sendWebhook, validWebhookUrl, type NotifyConfig, type NotifyEvent } from '../core/notify.ts';
import type { Provider, ProviderContext } from '../core/provider.ts';
import type { RunnerDeps } from '../core/runner.ts';
import { Worker } from '../core/worker.ts';
import { isTerminal } from '../core/state.ts';
import { statsTrend, viewsSeries } from '../core/stats.ts';
import type { PostInput, Target, TargetInput, TargetState } from '../core/types.ts';
import { isShort } from '../providers/youtube.ts';
import { ACCOUNT_NAME } from '../core/store.ts';
import { disconnectAccount, signInExpiry } from '../core/accounts.ts';
import { computeCalendar } from '../core/calendar.ts';
import { computeInsights, validTimeZone } from '../core/insights.ts';
import { suggestTimes } from '../core/slots.ts';
import { retryFirstComment } from '../core/followup.ts';
import { readLimits } from '../core/limits.ts';
import { addLiveChecks } from '../core/livepreview.ts';
import { ASSET_RULES, type AssetKind } from '../core/assets.ts';

export interface DashboardOptions {
  ctx: ProviderContext;
  providers: Map<string, Provider>;
  host?: string;
  port?: number;
  /** Required on every /api request as `x-fanout-token`. Random per start unless given. */
  token?: string;
  /** Extra Host header values to accept besides loopback (e.g. "fanout.lan:8780"). */
  allowedHosts?: string[];
  workerIntervalMs?: number;
  /** How often the worker re-reads stats of recent posts; 0 turns it off. Default 6 hours. */
  statsEveryMs?: number;
  /**
   * Treat a non-loopback bind as local. Only for containers whose published port is bound to the
   * host's 127.0.0.1 (e.g. `-p 127.0.0.1:8780:8780`), where nothing else can reach the server.
   */
  assumeLocal?: boolean;
  /** Days to keep finished originals and transcodes; null turns automatic cleanup off. Default 7. */
  pruneDays?: number | null;
  /** Test seams. */
  probe?: (path: string) => Promise<MediaInfo>;
  ensureVariant?: RunnerDeps['ensureVariant'];
  pollIntervalMs?: number;
}

const PUBLIC_DIR = join(import.meta.dirname, 'public');
const STATIC: Record<string, string> = {
  '/app.js': 'text/javascript; charset=utf-8',
  '/i18n.js': 'text/javascript; charset=utf-8',
  '/style.css': 'text/css; charset=utf-8',
};
const MEDIA_ID = /^[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
/** Thumbnail and caption uploads: YouTube accepts JPEG/PNG up to 2MB and these caption formats. */
const ASSET_KINDS = {
  thumbnail: { ext: new Set<string>(ASSET_RULES.thumbnail.exts), maxBytes: ASSET_RULES.thumbnail.maxBytes },
  caption: { ext: new Set<string>(ASSET_RULES.caption.exts), maxBytes: ASSET_RULES.caption.maxBytes },
} as const;
const JSON_LIMIT = 1024 * 1024;
const PRUNE_INTERVAL_MS = 6 * 3600_000;
/** Token-connect form for providers that don't declare their own fields (Meta). */
const DEFAULT_CONNECT_FIELDS = [
  { key: 'token', label: msg('액세스 토큰'), secret: true },
  { key: 'page', label: msg('페이지 ID (선택)'), secret: false, optional: true },
];
const OAUTH_TTL_MS = 10 * 60_000;

interface PendingOAuth {
  platform: string;
  name: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  /** The dashboard's language when connecting started: the callback's error goes back in it. */
  lang: Lang;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** The language each request asked for (x-fanout-lang); responses are translated on the way out. */
const responseLang = new WeakMap<ServerResponse, Lang>();

function requestLang(req: IncomingMessage): Lang {
  return req.headers['x-fanout-lang'] === 'en' ? 'en' : 'ko';
}

/** Token check in constant time (digests make the lengths equal). */
function sameToken(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== 'string') return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(token));
}

/** URL path segments and header values: malformed percent-encoding is the client's error, not a 500. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, msg('잘못된 주소 인코딩입니다'));
  }
}

/** For a page load with no dashboard header: the browser's first language, as the dashboard picks it. */
function browserLang(req: IncomingMessage): Lang {
  return String(req.headers['accept-language'] ?? 'en').trim().toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

function send(res: ServerResponse, status: number, body: unknown): void {
  let out = body;
  try {
    out = translateDeep(body, responseLang.get(res) ?? 'ko');
  } catch {
    // An untranslatable response still goes out, in Korean.
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(out));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > JSON_LIMIT) throw new HttpError(413, msg('요청 본문이 너무 큽니다'));
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, msg('JSON 형식이 아닙니다'));
  }
}

interface Preset {
  name: string;
  targets: TargetInput[];
  tags: string[];
  description: string;
  /** A first comment used again and again ("link in bio"). */
  firstComment?: string;
}

/**
 * Choices the platforms require the creator to make for each post, with no default: TikTok's
 * privacy, interaction, commercial-content and music-consent fields (Content Sharing Guidelines)
 * and YouTube's visibility and made-for-kids answer. Presets never carry them.
 */
const PER_POST_OPTIONS: Record<string, string[]> = {
  tiktok: ['privacyLevel', 'allowComment', 'allowDuet', 'allowStitch', 'brandOrganic', 'brandedContent', 'musicConsent'],
  youtube: ['privacy', 'madeForKids'],
};

export function presetOptions(platform: string, options: unknown): Record<string, unknown> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return {};
  const drop = new Set(PER_POST_OPTIONS[platform] ?? []);
  return Object.fromEntries(Object.entries(options).filter(([k]) => !drop.has(k)));
}

/** Presets saved before per-post choices were stripped still hold them; clean on the way out too. */
function cleanPreset(p: Preset): Preset {
  return { ...p, targets: p.targets.map((t) => ({ ...t, options: presetOptions(t.platform, t.options) })) };
}

/** The first comment from a request: text up to 10,000 characters, or none. */
function firstComment(value: unknown): { firstComment?: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string') throw new HttpError(400, msg('첫 댓글은 글자여야 합니다'));
  const text = value.trim();
  if ([...text].length > 10_000) throw new HttpError(400, msg('첫 댓글은 10000자까지입니다'));
  return text ? { firstComment: text } : {};
}

interface CreatePostBody {
  mediaId?: string;
  title?: string;
  description?: string;
  tags?: string[];
  scheduledAt?: string;
  containsSyntheticMedia?: boolean;
  /** Posted as a comment once the video is out, where the platform allows. */
  firstComment?: string;
  targets?: TargetInput[];
  /** From POST /api/assets/thumbnail. */
  thumbnailId?: string;
  /** Or a frame of the video, in seconds, as the thumbnail (and the Instagram/TikTok cover). */
  thumbnailAt?: number;
  /** From POST /api/assets/caption. */
  captions?: Array<{ language?: string; assetId?: string }>;
}

/**
 * Local dashboard: static page + JSON API + an in-process worker that drives queued targets.
 * Binds to loopback by default; every API call needs the per-start token, and Host headers are
 * checked so a hostile web page can't reach it through DNS rebinding.
 */
export class Dashboard {
  readonly #opts: DashboardOptions;
  readonly #deps: RunnerDeps;
  readonly #token: string;
  readonly #mediaDir: string;
  #server?: Server;
  #pruneTimer?: NodeJS.Timeout;
  #allowedHosts = new Set<string>();
  readonly #worker: Worker;
  readonly #pendingOAuth = new Map<string, PendingOAuth>();

  constructor(opts: DashboardOptions) {
    this.#opts = opts;
    this.#token = opts.token ?? randomBytes(24).toString('base64url');
    this.#mediaDir = join(opts.ctx.home, 'media');
    this.#deps = { ctx: opts.ctx, providers: opts.providers, probe: opts.probe, ensureVariant: opts.ensureVariant };
    this.#worker = new Worker(this.#deps, { intervalMs: opts.workerIntervalMs, pollIntervalMs: opts.pollIntervalMs, statsEveryMs: opts.statsEveryMs });
  }

  get token(): string {
    return this.#token;
  }

  async start(): Promise<string> {
    const host = this.#opts.host ?? '127.0.0.1';
    mkdirSync(this.#mediaDir, { recursive: true, mode: 0o700 });
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : err instanceof ProviderError ? 400 : 500;
        if (status === 500) this.#opts.ctx.log.warn(`dashboard: ${err instanceof Error ? err.stack : String(err)}`);
        if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : String(err) });
        else res.end();
      });
    });
    // Large video uploads can take longer than Node's default 5-minute request timeout.
    this.#server.requestTimeout = 0;
    await new Promise<void>((r) => this.#server!.listen(this.#opts.port ?? 8780, host, r));
    const port = (this.#server.address() as AddressInfo).port;
    for (const h of ['127.0.0.1', 'localhost', '[::1]']) this.#allowedHosts.add(`${h}:${port}`);
    if (!isLoopback(host)) this.#allowedHosts.add(`${host}:${port}`);
    for (const h of this.#opts.allowedHosts ?? []) this.#allowedHosts.add(h);

    this.#worker.start();
    if (this.#opts.pruneDays !== null) {
      this.prune();
      this.#pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    }
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
  }

  async stop(): Promise<void> {
    this.#worker.stop();
    clearInterval(this.#pruneTimer);
    // Drop in-flight requests first so a long upload can't hold Ctrl+C; interrupted work resumes next start.
    this.#server?.closeAllConnections();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
  }

  /** Wait for in-flight runner work (tests). */
  async idle(): Promise<void> {
    await this.#worker.idle();
  }

  /** Delete finished originals and stale transcodes under the fanout home (see planPrune). */
  prune(): void {
    try {
      const items = planPrune(this.#opts.ctx.home, this.#opts.ctx.store, { days: this.#opts.pruneDays ?? 7, now: this.#opts.ctx.now() });
      if (items.length) this.#opts.ctx.log.info(msg('정리: 파일 {items}개, {formatBytes}', { items: items.length, formatBytes: formatBytes(applyPrune(items)) }));
    } catch (err) {
      this.#opts.ctx.log.warn(msg('정리 실패: {err}', { err: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Run due targets now instead of waiting for the next worker interval. */
  tick(): void {
    this.#worker.tick();
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    responseLang.set(res, requestLang(req));
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (!this.#allowedHosts.has(req.headers.host ?? '')) throw new HttpError(421, msg('허용되지 않은 Host: {host}', { host: req.headers.host }));

    const url = new URL(req.url ?? '/', 'http://local');
    const method = req.method ?? 'GET';

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return this.#page(res);
    // Liveness for Docker/monitors: no token, no data.
    if (method === 'GET' && url.pathname === '/healthz') {
      // 503 once the background worker keeps failing, so a health check sees it.
      const worker = this.#worker.health();
      return send(res, worker.ok ? 200 : 503, worker.ok ? { ok: true } : { ok: false, worker });
    }
    if (method === 'GET' && STATIC[url.pathname]) {
      res.writeHead(200, { 'content-type': STATIC[url.pathname]!, 'cache-control': 'no-cache' });
      res.end(readFileSync(join(PUBLIC_DIR, url.pathname.slice(1))));
      return;
    }
    if (method === 'GET' && url.pathname.startsWith('/oauth/') && url.pathname.endsWith('/callback')) return this.#oauthCallback(req, res, url);
    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
    if (!sameToken(req.headers['x-fanout-token'], this.#token)) throw new HttpError(401, msg('대시보드 토큰이 필요합니다'));

    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    if (method === 'GET' && parts[0] === 'overview') return send(res, 200, this.#overview());
    if (method === 'GET' && parts[0] === 'comment-inbox' && !parts[1]) {
      const days = Number(url.searchParams.get('days') ?? 7);
      return send(res, 200, await commentInbox(this.#opts.ctx, this.#opts.providers, { days: days > 0 ? Math.min(days, 90) : 7 }));
    }
    if (method === 'GET' && parts[0] === 'calendar' && !parts[1]) {
      const tz = url.searchParams.get('tz') || undefined;
      if (tz && !validTimeZone(tz)) throw new HttpError(400, msg('알 수 없는 시간대입니다: {tz} (예: Asia/Seoul)', { tz }));
      const locale = url.searchParams.get('lang') === 'en' ? 'en-US' : 'ko-KR';
      return send(res, 200, computeCalendar(this.#opts.ctx.store, this.#opts.ctx.now(), { weeks: Number(url.searchParams.get('weeks') ?? 1) || 1, offset: Number(url.searchParams.get('offset') ?? 0) || 0, timeZone: tz, locale }));
    }
    if (method === 'GET' && parts[0] === 'best-times' && !parts[1]) {
      // ?accounts=youtube/main,tiktok/brand — read-only: suggests, schedules nothing.
      const accounts = (url.searchParams.get('accounts') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20)
        .map((s) => {
          const i = s.indexOf('/');
          return { platform: i > 0 ? s.slice(0, i) : s, account: i > 0 ? s.slice(i + 1) : 'main' };
        });
      if (!accounts.length) throw new HttpError(400, msg('accounts 가 필요합니다 (예: youtube/main,tiktok/main)'));
      const tz = url.searchParams.get('tz') || undefined;
      if (tz && !validTimeZone(tz)) throw new HttpError(400, msg('알 수 없는 시간대입니다: {tz} (예: Asia/Seoul)', { tz }));
      const locale = url.searchParams.get('lang') === 'en' ? 'en-US' : 'ko-KR';
      return send(res, 200, suggestTimes(this.#opts.ctx.store, this.#opts.ctx.now(), { accounts, timeZone: tz, locale, count: Number(url.searchParams.get('count') ?? 3) || 3 }));
    }
    if (method === 'GET' && parts[0] === 'insights' && !parts[1]) {
      const days = Number(url.searchParams.get('days') ?? 30);
      const locale = url.searchParams.get('lang') === 'en' ? 'en-US' : 'ko-KR';
      const tz = url.searchParams.get('tz') || undefined;
      if (tz && !validTimeZone(tz)) throw new HttpError(400, msg('알 수 없는 시간대입니다: {tz} (예: Asia/Seoul)', { tz }));
      const window = days > 0 ? Math.min(days, 365) : 30;
      // Probes originals: only when asked for, not on every dashboard load.
      const suggestions = url.searchParams.get('suggestions') === '1' ? await suggestCrossPosts(this.#opts.ctx, this.#opts.providers, { days: window, probe: this.#opts.probe }) : undefined;
      return send(res, 200, { ...computeInsights(this.#opts.ctx.store, this.#opts.ctx.now(), { days: window, locale, timeZone: tz }), suggestions });
    }
    if (method === 'GET' && parts[0] === 'limits' && !parts[1]) return send(res, 200, { accounts: await readLimits(this.#opts.ctx, this.#opts.providers, url.searchParams.get('platform') ?? undefined) });
    if (parts[0] === 'presets') return send(res, 200, await this.#presets(method, parts[1] ? decode(parts[1]) : undefined, req));
    if (method === 'POST' && parts[0] === 'media' && parts.length === 1) return send(res, 201, await this.#upload(req));
    // Whether an uploaded video is still here (a draft kept in the browser asks before using it).
    if (method === 'GET' && parts[0] === 'media' && parts[1] && parts.length === 2) {
      const id = decode(parts[1]);
      if (!MEDIA_ID.test(id) || !existsSync(join(this.#mediaDir, id))) throw new HttpError(404, msg('올린 영상이 서버에 없습니다. 다시 올려 주세요'));
      return send(res, 200, { id });
    }
    if (method === 'POST' && parts[0] === 'assets' && (parts[1] === 'thumbnail' || parts[1] === 'caption')) return send(res, 201, await this.#uploadAsset(req, parts[1]));
    if (method === 'GET' && parts[0] === 'posts' && parts.length === 1) {
      return send(res, 200, this.#listPosts(Number(url.searchParams.get('limit') ?? 20), url.searchParams.get('q') ?? undefined, url.searchParams.get('scheduled') === '1'));
    }
    if (method === 'POST' && parts[0] === 'posts' && parts.length === 1) return send(res, 201, await this.#createPost(req));
    if (method === 'POST' && parts[0] === 'preview' && parts.length === 1) return send(res, 200, await this.#preview(req));
    if (method === 'GET' && parts[0] === 'posts' && parts[1] && parts.length === 2) return send(res, 200, this.#postDetail(parts[1]));
    if (method === 'POST' && parts[0] === 'targets' && parts[1] && parts[2] === 'retry') {
      const body = await readJson<{ confirmedNotPosted?: unknown }>(req).catch(() => ({}) as { confirmedNotPosted?: unknown });
      try {
        return send(res, 200, this.#retry(parts[1], body.confirmedNotPosted === true));
      } catch (err) {
        // As for cancel: the dashboard asks the user to check the platform, then sends confirmedNotPosted.
        if (err instanceof MaybeDuplicateError) return send(res, 409, { error: err.message, needsConfirm: true });
        throw err;
      }
    }
    if (method === 'POST' && parts[0] === 'targets' && parts[1] && parts[2] === 'first-comment') {
      const body = await readJson<{ confirmedNotPosted?: unknown }>(req).catch(() => ({}) as { confirmedNotPosted?: unknown });
      try {
        return send(res, 200, { followup: await retryFirstComment(this.#opts.ctx, this.#opts.providers, decode(parts[1]), body.confirmedNotPosted === true) });
      } catch (err) {
        const e = err as Error & { needsConfirm?: boolean };
        return send(res, 409, { error: e.message, ...(e.needsConfirm ? { needsConfirm: true } : {}) });
      }
    }
    if (method === 'POST' && parts[0] === 'targets' && parts[1] && parts[2] === 'cancel') {
      try {
        const body = await readJson<{ confirmedNotPosted?: unknown }>(req).catch(() => ({}) as { confirmedNotPosted?: unknown });
        return send(res, 200, this.#publicTarget(cancelTarget(this.#opts.ctx.store, parts[1], { confirmedNotPosted: body.confirmedNotPosted === true })));
      } catch (err) {
        // The dashboard asks the user to check the platform, then sends confirmedNotPosted.
        if (err instanceof MaybeLiveError) return send(res, 409, { error: err.message, needsConfirm: true });
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    }
    if (method === 'POST' && parts[0] === 'targets' && parts[1] && parts[2] === 'visibility') {
      const body = await readJson<{ visibility?: string; publishAt?: string }>(req);
      try {
        return send(res, 200, this.#publicTarget(await changeVisibility(this.#opts.ctx, this.#opts.providers, parts[1], String(body.visibility ?? ''), body.publishAt || undefined)));
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    }
    if (method === 'POST' && parts[0] === 'targets' && parts[1] && parts[2] === 'remove') {
      try {
        return send(res, 200, this.#publicTarget(await removeTarget(this.#opts.ctx, this.#opts.providers, parts[1])));
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    }
    if (method === 'POST' && parts[0] === 'targets' && parts[1] && parts[2] === 'hide-comment') {
      const body = await readJson<{ commentId?: unknown; hidden?: unknown }>(req);
      if (typeof body.commentId !== 'string') throw new HttpError(400, msg('commentId가 필요합니다'));
      try {
        await hideComment(this.#opts.ctx, this.#opts.providers, parts[1], body.commentId, body.hidden !== false);
        return send(res, 200, { ok: true });
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    }
    if (method === 'POST' && parts[0] === 'targets' && parts[1] && parts[2] === 'reply') {
      const body = await readJson<{ commentId?: unknown; text?: unknown }>(req);
      if (typeof body.commentId !== 'string' || typeof body.text !== 'string') throw new HttpError(400, msg('commentId와 text가 필요합니다'));
      try {
        return send(res, 200, await replyToComment(this.#opts.ctx, this.#opts.providers, parts[1], body.commentId, body.text));
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    }
    if (method === 'GET' && parts[0] === 'posts' && parts[1] && parts[2] === 'comments') {
      if (!this.#opts.ctx.store.getPost(parts[1])) throw new HttpError(404, msg('게시물이 없습니다'));
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 100);
      return send(res, 200, { results: await fetchComments(this.#opts.ctx, this.#opts.providers, parts[1], limit) });
    }
    if (parts[0] === 'posts' && parts[1] && parts[2] === 'media' && parts.length === 3 && method === 'GET') return send(res, 200, await this.#postMedia(parts[1]));
    if (method === 'POST' && parts[0] === 'posts' && parts[1] && parts[2] === 'targets' && (parts.length === 3 || (parts.length === 4 && parts[3] === 'preview'))) {
      const body = await readJson<{ targets?: Array<{ platform?: unknown; account?: unknown; options?: unknown }> }>(req);
      const targets = (Array.isArray(body.targets) ? body.targets : []).map((t) => ({
        platform: String(t?.platform ?? ''),
        account: String(t?.account ?? 'main'),
        options: t?.options && typeof t.options === 'object' ? (t.options as Record<string, unknown>) : {},
      }));
      for (const t of targets) {
        if (!this.#opts.providers.has(t.platform)) throw new HttpError(400, msg('알 수 없는 플랫폼: {platform}', { platform: t.platform }));
        if (!this.#opts.ctx.store.getAccount(t.platform, t.account)) throw new HttpError(400, msg('연결되지 않은 계정: {platform}/{account}', { platform: t.platform, account: t.account }));
      }
      const post = this.#opts.ctx.store.getPost(parts[1]);
      if (!post) throw new HttpError(404, msg('게시물이 없습니다'));
      try {
        const media = existsSync(post.mediaPath) ? await (this.#opts.probe ?? realProbe)(post.mediaPath) : undefined;
        if (parts[3] === 'preview') {
          const { preview } = planAddTargets(this.#opts.ctx.store, this.#opts.providers, post.id, targets, media!);
          await addLiveChecks(this.#opts.ctx, this.#opts.providers, preview, { input: post, targets, media: media! });
          return send(res, 200, { targets: preview });
        }
        const created = addTargets(this.#opts.ctx.store, this.#opts.providers, post.id, targets, media!);
        this.tick();
        return send(res, 201, { targets: created.map((t) => this.#publicTarget(t)) });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    }
    if (method === 'POST' && parts[0] === 'posts' && parts[1] && parts[2] === 'edit') {
      const body = await readJson<{ title?: string; description?: string; tags?: string[] }>(req);
      if (!this.#opts.ctx.store.getPost(parts[1])) throw new HttpError(404, msg('게시물이 없습니다'));
      const patch = {
        ...(typeof body.title === 'string' ? { title: body.title.trim() } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(Array.isArray(body.tags) ? { tags: body.tags.map((t) => String(t).trim()).filter(Boolean) } : {}),
      };
      if (patch.title !== undefined && !patch.title) throw new HttpError(400, msg('제목을 입력하세요'));
      return send(res, 200, { results: await editPost(this.#opts.ctx, this.#opts.providers, parts[1], patch) });
    }
    if (method === 'POST' && parts[0] === 'posts' && parts[1] && parts[2] === 'stats') {
      const body = await readJson<{ includePaid?: boolean; platform?: string }>(req);
      if (!this.#opts.ctx.store.getPost(parts[1])) throw new HttpError(404, msg('게시물이 없습니다'));
      return send(res, 200, { results: await refreshStats(this.#opts.ctx, this.#opts.providers, parts[1], { includePaid: Boolean(body.includePaid), platform: body.platform }) });
    }

    // Settings: app secrets and account tokens, local dashboards only.
    if (['settings', 'apps', 'connect', 'accounts', 'doctor', 'notify'].includes(parts[0] ?? '')) this.#requireSettings();
    if (parts[0] === 'notify') return send(res, 200, await this.#notify(method, parts[1], req));
    if (method === 'GET' && parts[0] === 'settings') return send(res, 200, this.#settings(req));
    if (method === 'PUT' && parts[0] === 'apps' && parts[1]) return send(res, 200, this.#saveApp(parts[1], await readJson(req)));
    if (method === 'POST' && parts[0] === 'connect' && parts[1]) return send(res, 200, await this.#connect(req, parts[1], await readJson(req)));
    if (method === 'DELETE' && parts[0] === 'accounts' && parts[1] && parts[2]) return send(res, 200, await this.#disconnect(parts[1], decode(parts[2])));
    if (method === 'GET' && parts[0] === 'accounts' && parts[1] && parts[2] && parts[3] === 'rules' && parts.length === 4) return send(res, 200, await this.#accountRules(parts[1], decode(parts[2])));
    if (method === 'GET' && parts[0] === 'accounts' && parts[1] && parts[2] && parts[3] === 'playlists' && parts.length === 4) return send(res, 200, await this.#playlists(parts[1], decode(parts[2])));
    if (method === 'POST' && parts[0] === 'doctor' && parts[1]) return send(res, 200, await this.#doctor(parts[1], await readJson(req)));
    throw new HttpError(404, 'not found');
  }

  #page(res: ServerResponse): void {
    // Embed the token only for a purely local dashboard with a generated token. Anything reachable
    // another way (extra allowed hosts, e.g. behind a proxy) asks the user to paste it.
    const local = this.#localOnly && !this.#opts.token;
    const embed = local ? this.#token : '';
    const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8').replace('__FANOUT_TOKEN__', embed);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    res.end(html);
  }

  /** Settings handle app secrets and tokens, so only a loopback-only dashboard exposes them. */
  get settingsEnabled(): boolean {
    return this.#localOnly;
  }

  /** Reachable only from this machine: loopback bind (or an assumed-local container) and no extra hosts. */
  get #localOnly(): boolean {
    return (isLoopback(this.#opts.host ?? '127.0.0.1') || Boolean(this.#opts.assumeLocal)) && !this.#opts.allowedHosts?.length;
  }

  #requireSettings(): void {
    if (!this.settingsEnabled) {
      throw new HttpError(403, msg('설정 화면은 127.0.0.1 전용입니다. 이 서버에서 터미널로 fanout app set / connect 를 쓰세요'));
    }
  }

  #provider(id: string): Provider {
    const p = this.#opts.providers.get(id);
    if (!p) throw new HttpError(404, msg('알 수 없는 플랫폼: {id}', { id }));
    return p;
  }


  #redirectUri(req: IncomingMessage, platform: string): string {
    return `http://${req.headers.host}/oauth/${platform}/callback`;
  }

  #settings(req: IncomingMessage) {
    const { store } = this.#opts.ctx;
    const accounts = store.listAccounts();
    const apps = new Map<string, { key: string; platforms: string[]; guide: string; fields: unknown[] }>();
    for (const p of this.#opts.providers.values()) {
      const key = p.appKey ?? p.id;
      const existing = apps.get(key);
      if (existing) {
        existing.platforms.push(p.id);
        continue;
      }
      const config = store.getApp<Record<string, unknown>>(key) ?? {};
      apps.set(key, {
        key,
        platforms: [p.id],
        guide: p.setupGuide(),
        // Secrets never leave the server; the form only learns whether one is stored.
        fields: p.appFields.map((f) => ({
          ...f,
          set: config[f.key] !== undefined && config[f.key] !== '',
          value: f.secret ? undefined : (config[f.key] as string | undefined),
        })),
      });
    }
    return {
      apps: [...apps.values()],
      platforms: [...this.#opts.providers.values()].map((p) => ({
        id: p.id,
        displayName: p.displayName,
        appKey: p.appKey ?? p.id,
        appConfigured: appReady(store, p),
        connectMethod: p.connectMethod,
        connectFields: p.connectMethod === 'token' ? (p.connectFields ?? DEFAULT_CONNECT_FIELDS) : undefined,
        redirectUri: p.connectMethod === 'oauth' ? this.#redirectUri(req, p.id) : undefined,
        accounts: accounts.filter((a) => a.platform === p.id).map((a) => {
          // When the sign-in itself ends (refresh token lifetime), so a reconnect can come first.
          const expiry = signInExpiry(this.#opts.ctx, this.#opts.providers, a.platform, a.name);
          return { name: a.name, label: accountLabel(a.profile, a.name), ...(expiry ? { signInExpiresAt: new Date(expiry.expiresAt).toISOString(), expiresSoon: expiry.soon } : {}) };
        }),
      })),
    };
  }

  #saveApp(key: string, body: { values?: Record<string, unknown>; clientJson?: string }) {
    const provider = [...this.#opts.providers.values()].find((p) => (p.appKey ?? p.id) === key);
    if (!provider) throw new HttpError(404, msg('알 수 없는 앱: {key}', { key }));
    const { store } = this.#opts.ctx;
    const config: Record<string, unknown> = { ...(store.getApp(key) ?? {}) };
    if (body.clientJson) {
      // Google's downloaded client file: { installed: {...} } or { web: {...} }.
      let parsed: Record<string, { client_id?: string; client_secret?: string }>;
      try {
        parsed = JSON.parse(body.clientJson) as typeof parsed;
      } catch {
        throw new HttpError(400, msg('JSON 파일을 읽을 수 없습니다'));
      }
      const inner = parsed.installed ?? parsed.web;
      if (!inner?.client_id) throw new HttpError(400, msg('client_id가 있는 Google OAuth JSON이 아닙니다'));
      if (!parsed.installed) throw new HttpError(400, msg('"데스크톱 앱" 유형 OAuth 클라이언트 JSON이어야 합니다 (installed)'));
      config.clientId = inner.client_id;
      config.clientSecret = inner.client_secret;
    }
    for (const f of provider.appFields) {
      const raw = body.values?.[f.key];
      if (raw === undefined) continue;
      const v = String(raw).trim();
      if (v) config[f.key] = v;
      // An empty secret means "keep the stored one"; an empty optional field clears it.
      else if (!f.secret && f.optional) delete config[f.key];
    }
    const missing = provider.appFields.filter((f) => !f.optional && !config[f.key]).map((f) => f.label);
    if (missing.length) throw new HttpError(400, msg('필수 항목이 비어 있습니다: {missing}', { missing: missing.join(', ') }));
    store.setApp(key, config);
    return { ok: true };
  }

  async #connect(req: IncomingMessage, platform: string, body: Record<string, unknown>) {
    const provider = this.#provider(platform);
    const name = String(body.name ?? 'main').trim();
    if (!ACCOUNT_NAME.test(name)) throw new HttpError(400, msg('계정 이름은 영문·숫자·-·_ 32자 이내'));

    if (provider.connectMethod === 'oauth') {
      const redirectUri = this.#redirectUri(req, platform);
      const start = provider.oauthBegin!(this.#opts.ctx, redirectUri);
      const now = Date.now();
      for (const [k, v] of this.#pendingOAuth) if (v.expiresAt < now) this.#pendingOAuth.delete(k);
      this.#pendingOAuth.set(start.state, { platform, name, verifier: start.verifier, redirectUri, expiresAt: now + OAUTH_TTL_MS, lang: requestLang(req) });
      return { authorizeUrl: start.url };
    }

    const fields = provider.connectFields ?? DEFAULT_CONNECT_FIELDS;
    const flags: Record<string, string | undefined> = {};
    for (const f of fields) {
      const v = typeof body[f.key] === 'string' ? (body[f.key] as string).trim() : '';
      if (!v && !f.optional) throw new HttpError(400, msg('{label}을(를) 입력하세요', { label: f.label }));
      flags[f.key] = v || undefined;
    }
    const account = await provider.connect(this.#opts.ctx, name, flags);
    this.#opts.ctx.store.saveAccount(account);
    return { account: { name, label: accountLabel(account.profile, name) } };
  }

  async #oauthCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const back = (params: Record<string, string>) => {
      res.writeHead(303, { location: `/?${new URLSearchParams({ view: 'settings', ...params })}`, 'cache-control': 'no-store' });
      res.end();
    };
    const state = url.searchParams.get('state') ?? '';
    const pending = this.#pendingOAuth.get(state);
    // The platform redirects here without the dashboard's header: use the language the connect started in.
    const lang = pending?.lang ?? browserLang(req);
    if (!this.settingsEnabled) return back({ oauthError: translate(msg('설정 화면은 127.0.0.1 전용입니다'), lang) });
    const platform = url.pathname.split('/')[2] ?? '';
    this.#pendingOAuth.delete(state);
    if (!pending || pending.platform !== platform || pending.expiresAt < Date.now()) {
      return back({ oauthError: translate(msg('연결 요청이 만료됐거나 올바르지 않습니다. 다시 연결을 눌러 주세요'), lang), platform });
    }
    try {
      const provider = this.#provider(platform);
      const account = await provider.oauthFinish!(this.#opts.ctx, pending.name, url.searchParams, pending.redirectUri, pending.verifier);
      this.#opts.ctx.store.saveAccount(account);
      back({ connected: `${platform}/${pending.name}` });
    } catch (err) {
      back({ oauthError: translate(err instanceof Error ? err.message : String(err), pending.lang), platform });
    }
  }

  /**
   * Named form presets (targets, their options, tags, description) so frequent posters don't re-pick
   * everything. Stored in the encrypted apps table under "presets"; only references accounts by name.
   */
  async #presets(method: string, name: string | undefined, req: IncomingMessage) {
    const { store } = this.#opts.ctx;
    const all = () => (store.getApp<{ items?: Preset[] }>('presets')?.items ?? []).map(cleanPreset);
    if (method === 'GET' && !name) return { presets: all() };
    if (!name || !/^.{1,40}$/u.test(name.trim())) throw new HttpError(400, msg('프리셋 이름은 1~40자'));
    const key = name.trim();
    if (method === 'DELETE') {
      store.setApp('presets', { items: all().filter((p) => p.name !== key) });
      return { presets: all() };
    }
    if (method === 'PUT') {
      const body = await readJson<Partial<Preset>>(req);
      const targets = (Array.isArray(body.targets) ? body.targets : [])
        .filter((t) => t && this.#opts.providers.has(String(t.platform)))
        .map((t) => ({ platform: String(t.platform), account: String(t.account ?? 'main'), options: presetOptions(String(t.platform), t.options) }));
      if (!targets.length) throw new HttpError(400, msg('올릴 곳을 하나 이상 고른 뒤 저장하세요'));
      const preset: Preset = {
        name: key,
        targets,
        tags: Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [],
        description: typeof body.description === 'string' ? body.description : '',
        ...firstComment(body.firstComment),
      };
      store.setApp('presets', { items: [...all().filter((p) => p.name !== key), preset].sort((a, b) => a.name.localeCompare(b.name)) });
      return { presets: all() };
    }
    throw new HttpError(404, 'not found');
  }

  /** Webhook settings. The URL itself is a secret, so only its host goes back to the browser. */
  async #notify(method: string, action: string | undefined, req: IncomingMessage) {
    const { ctx } = this.#opts;
    const describe = () => {
      const c = notifyConfig(ctx);
      return c
        ? {
            configured: true,
            host: new URL(c.url).host,
            // What the user picked (if anything) vs. what the URL suggests, so the form never turns a
            // guess into a saved choice.
            format: c.format,
            detectedFormat: detectFormat(c.url),
            events: c.events ?? DEFAULT_EVENTS,
            fromEnv: Boolean(process.env.FANOUT_WEBHOOK_URL),
          }
        : { configured: false, events: DEFAULT_EVENTS };
    };
    if (method === 'GET') return describe();
    if (method === 'DELETE') {
      ctx.store.setApp('notify', {});
      return describe();
    }
    if (method === 'POST' && action === 'test') {
      const c = notifyConfig(ctx);
      if (!c) throw new HttpError(400, msg('알림 주소가 없습니다'));
      const format = c.format ?? detectFormat(c.url);
      const text = msg('🔔 fanout 알림 테스트입니다');
      await sendWebhook(ctx, c, format === 'slack' ? { text } : format === 'discord' ? { content: text } : { event: 'test', text }).catch((err: Error) => {
        throw new HttpError(502, msg('보내지 못했습니다: {message}', { message: err.message }));
      });
      return { sent: true };
    }
    if (method === 'PUT') {
      const body = await readJson<{ url?: string; events?: string[]; format?: string }>(req);
      const saved = ctx.store.getApp<NotifyConfig>('notify') ?? ({} as Partial<NotifyConfig>);
      const url = body.url?.trim() || saved.url;
      if (!url || !validWebhookUrl(url)) throw new HttpError(400, msg('올바른 https:// webhook 주소를 넣으세요'));
      const known: readonly string[] = KNOWN_EVENTS;
      const events = (body.events ?? []).filter((e) => known.includes(e)) as NotifyEvent[];
      if (!events.length) throw new HttpError(400, msg('알릴 상태를 하나 이상 고르세요'));
      const format = body.format && ['slack', 'discord', 'json'].includes(body.format) ? (body.format as NotifyConfig['format']) : undefined;
      const picked = eventsToSave(events);
      ctx.store.setApp('notify', { url, ...(picked ? { events: picked } : {}), ...(format ? { format } : {}) });
      return describe();
    }
    throw new HttpError(404, 'not found');
  }

  /** The account's playlists (YouTube), for picking one instead of pasting its id. */
  async #playlists(platform: string, name: string) {
    const provider = this.#provider(platform);
    const account = this.#opts.ctx.store.getAccount(platform, name);
    if (!account) throw new HttpError(404, msg('해당 계정이 없습니다'));
    return { playlists: provider.listPlaylists ? await provider.listPlaylists({ ctx: withTimeout(this.#opts.ctx), account }) : [] };
  }

  /** The account's own posting rules (TikTok creator_info), for shaping the post form. */
  async #accountRules(platform: string, name: string) {
    const provider = this.#provider(platform);
    const account = this.#opts.ctx.store.getAccount(platform, name);
    if (!account) throw new HttpError(404, msg('해당 계정이 없습니다'));
    if (!provider.accountRules) return { rules: null };
    return { rules: await provider.accountRules({ ctx: withTimeout(this.#opts.ctx), account }) };
  }

  async #disconnect(platform: string, name: string) {
    this.#provider(platform);
    const done = await disconnectAccount(this.#opts.ctx, this.#opts.providers, platform, name);
    if (!done) throw new HttpError(404, msg('해당 계정이 없습니다'));
    return { ok: true, ...done };
  }

  async #doctor(platform: string, body: { account?: string; live?: boolean }) {
    const provider = this.#provider(platform);
    const name = body.account ?? 'main';
    const account = this.#opts.ctx.store.getAccount(platform, name);
    if (!account) throw new HttpError(404, msg('{platform}/{name} 계정이 연결되지 않았습니다', { platform, name }));
    try {
      return { checks: await provider.doctor({ ctx: this.#opts.ctx, account, live: Boolean(body.live) }) };
    } catch (err) {
      return { checks: [{ name: msg('점검 중 오류'), status: 'fail', detail: err instanceof Error ? err.message : String(err) }] };
    }
  }

  #overview() {
    const { store } = this.#opts.ctx;
    const accounts = store.listAccounts();
    return {
      settingsEnabled: this.settingsEnabled,
      platforms: [...this.#opts.providers.values()].map((p) => ({
        id: p.id,
        displayName: p.displayName,
        capabilities: p.capabilities,
        appConfigured: appReady(store, p),
        accounts: accounts
          .filter((a) => a.platform === p.id)
          .map((a) => ({ name: a.name, label: accountLabel(a.profile, a.name) })),
      })),
    };
  }

  async #upload(req: IncomingMessage) {
    const name = decode(String(req.headers['x-filename'] ?? 'video.mp4'));
    const ext = extname(name).toLowerCase();
    if (!VIDEO_EXT.has(ext)) throw new HttpError(415, msg('지원하지 않는 확장자: {ext}', { ext: ext || msg('(없음)') }));
    const id = `${randomUUID()}${ext}`;
    const path = join(this.#mediaDir, id);
    await pipeline(req, createWriteStream(path, { mode: 0o600 }));
    let media: MediaInfo;
    try {
      media = await (this.#opts.probe ?? realProbe)(path);
    } catch (err) {
      rmSync(path, { force: true });
      throw new HttpError(422, msg('영상으로 읽을 수 없습니다: {err}', { err: err instanceof Error ? err.message.split('\n')[0] : String(err) }));
    }
    return { id, name, media: { ...media, path: undefined }, isShort: isShort(media), assessments: assessMedia(media, this.#opts.providers.values()) };
  }

  async #uploadAsset(req: IncomingMessage, kind: AssetKind) {
    const rule = ASSET_KINDS[kind];
    const name = decode(String(req.headers['x-filename'] ?? ''));
    const ext = extname(name).toLowerCase();
    if (!(rule.ext as ReadonlySet<string>).has(ext)) {
      throw new HttpError(415, (kind === 'thumbnail' ? msg('썸네일 형식이 아닙니다: {ext} (가능: {allowed})', { ext: ext || msg('(없음)'), allowed: [...rule.ext].join(', ') }) : msg('자막 형식이 아닙니다: {ext} (가능: {allowed})', { ext: ext || msg('(없음)'), allowed: [...rule.ext].join(', ') })));
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > rule.maxBytes) throw new HttpError(413, (kind === 'thumbnail' ? msg('썸네일은 {mb}MB 이하여야 합니다', { mb: rule.maxBytes / 1024 / 1024 }) : msg('자막은 {mb}MB 이하여야 합니다', { mb: rule.maxBytes / 1024 / 1024 })));
    const id = `${randomUUID()}${ext}`;
    const path = join(this.#mediaDir, id);
    let size = 0;
    const out = createWriteStream(path, { mode: 0o600 });
    try {
      await pipeline(
        req,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > rule.maxBytes) throw new HttpError(413, msg('파일이 너무 큽니다'));
            yield chunk;
          }
        },
        out,
      );
    } catch (err) {
      rmSync(path, { force: true });
      throw err;
    }
    return { id, name, kind, bytes: size };
  }

  #assetPath(id: unknown, kind: AssetKind): string {
    const ext = extname(String(id)).toLowerCase();
    const path = join(this.#mediaDir, String(id));
    if (typeof id !== 'string' || !MEDIA_ID.test(id) || !(ASSET_KINDS[kind].ext as ReadonlySet<string>).has(ext) || !existsSync(path)) {
      throw new HttpError(400, (kind === 'thumbnail' ? msg('썸네일 파일을 다시 올려 주세요 ({id})', { id: String(id) }) : msg('자막 파일을 다시 올려 주세요 ({id})', { id: String(id) })));
    }
    return path;
  }

  /** Validate a create/preview body into post input and targets (shared by both endpoints). */
  #parsePost(body: CreatePostBody): { input: PostInput; targets: TargetInput[] } {
    if (!body.mediaId || !MEDIA_ID.test(body.mediaId) || !existsSync(join(this.#mediaDir, body.mediaId))) {
      throw new HttpError(400, msg('먼저 영상을 업로드하세요 (mediaId 없음)'));
    }
    if (!body.title?.trim()) throw new HttpError(400, msg('제목을 입력하세요'));
    if (!body.targets?.length) throw new HttpError(400, msg('올릴 플랫폼을 하나 이상 고르세요'));
    if (body.scheduledAt && Number.isNaN(Date.parse(body.scheduledAt))) throw new HttpError(400, msg('예약 시각 형식이 잘못됐습니다'));
    const { store } = this.#opts.ctx;
    for (const t of body.targets) {
      if (!this.#opts.providers.has(t.platform)) throw new HttpError(400, msg('알 수 없는 플랫폼: {platform}', { platform: t.platform }));
      if (!store.getAccount(t.platform, t.account)) throw new HttpError(400, msg('연결되지 않은 계정: {platform}/{account}', { platform: t.platform, account: t.account }));
    }
    const input: PostInput = {
      mediaPath: join(this.#mediaDir, body.mediaId),
      title: body.title.trim(),
      description: body.description ?? '',
      tags: (body.tags ?? []).map((t) => String(t).trim()).filter(Boolean),
      thumbnailPath: body.thumbnailId ? this.#assetPath(body.thumbnailId, 'thumbnail') : undefined,
      captions: (body.captions ?? []).map((c) => {
        const language = String(c.language ?? '').trim();
        if (!/^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) throw new HttpError(400, msg('자막 언어 코드가 올바르지 않습니다: {language} (예: ko, en, ja)', { language: language || msg('(비어 있음)') }));
        return { language, path: this.#assetPath(c.assetId, 'caption') };
      }),
      containsSyntheticMedia: Boolean(body.containsSyntheticMedia),
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt).toISOString() : undefined,
      ...firstComment(body.firstComment),
    };
    const targets = body.targets.map((t) => ({ platform: t.platform, account: t.account, options: t.options ?? {} }));
    return { input, targets };
  }

  /** A frame of the video as the thumbnail, when the form asks for one (same file for preview and post). */
  async #withFrame(body: CreatePostBody, parsed: { input: PostInput; targets: TargetInput[] }): Promise<{ input: PostInput; targets: TargetInput[] }> {
    if (body.thumbnailAt === undefined || body.thumbnailAt === null) return parsed;
    if (typeof body.thumbnailAt !== 'number') throw new HttpError(400, msg('썸네일 장면은 초 단위 숫자로 넣으세요'));
    if (body.thumbnailId) throw new HttpError(400, msg('썸네일 이미지와 장면 중 하나만 고르세요'));
    const media = await (this.#opts.probe ?? realProbe)(parsed.input.mediaPath);
    const thumbnailPath = await extractFrame(media, body.thumbnailAt, this.#mediaDir).catch((err: Error) => {
      throw new HttpError(400, err.message);
    });
    return { input: { ...parsed.input, thumbnailPath }, targets: withCoverMoment(parsed.targets, body.thumbnailAt) };
  }

  /** Who and how each target would post, plus every error/warning preflight would raise. Creates nothing. */
  async #preview(req: IncomingMessage) {
    const body = await readJson<CreatePostBody>(req);
    const { input, targets } = await this.#withFrame(body, this.#parsePost(body));
    input.mediaHash = await fileHash(input.mediaPath);
    const media = await (this.#opts.probe ?? realProbe)(input.mediaPath);
    const previews = previewPost(this.#opts.ctx.store, this.#opts.providers, input, targets, media);
    await addLiveChecks(this.#opts.ctx, this.#opts.providers, previews, { input, targets, media });
    return { targets: previews };
  }

  async #createPost(req: IncomingMessage) {
    const body = await readJson<CreatePostBody>(req);
    const { input, targets } = await this.#withFrame(body, this.#parsePost(body));
    input.mediaHash = await fileHash(input.mediaPath);
    const created = createScheduledPost(this.#opts.ctx.store, this.#opts.providers, input, targets);
    this.tick();
    return { post: this.#publicPost(created.post), targets: created.targets.map((t) => this.#publicTarget(t)) };
  }

  #listPosts(limit: number, query?: string, scheduled = false) {
    const { store } = this.#opts.ctx;
    const n = Math.min(Math.max(Math.floor(limit) || 20, 1), 300);
    // Upcoming only: what is still to go out, soonest first.
    const posts = scheduled ? store.listScheduled(this.#opts.ctx.now().toISOString(), n) : store.listPosts(n, query?.slice(0, 100));
    return posts.map((p) => ({
      post: this.#publicPost(p),
      targets: store.targetsForPost(p.id).map((t) => this.#publicTarget(t)),
    }));
  }

  #postDetail(id: string) {
    const { store } = this.#opts.ctx;
    const post = store.getPost(id);
    if (!post) throw new HttpError(404, msg('게시물이 없습니다'));
    return {
      post: this.#publicPost(post),
      targets: store.targetsForPost(id).map((t) => ({ ...this.#publicTarget(t), events: store.events(t.id) })),
    };
  }

  #retry(targetId: string, confirmedNotPosted: boolean) {
    const t = this.#opts.ctx.store.getTarget(targetId);
    if (!t) throw new HttpError(404, msg('대상이 없습니다'));
    if (t.state !== 'failed' && t.state !== 'needs_reauth') throw new HttpError(409, msg('{state} 상태는 다시 시도할 수 없습니다', { state: t.state }));
    const next = retryTarget(this.#opts.ctx.store, targetId, 'manual retry', { confirmedNotPosted });
    this.tick();
    return this.#publicTarget(next);
  }

  /** Never expose local filesystem paths to the browser. */
  #publicPost<P extends { mediaPath: string; thumbnailPath?: string; captions: unknown[] }>(p: P) {
    const { mediaPath, thumbnailPath, captions, ...rest } = p;
    return {
      ...rest,
      mediaName: mediaPath.split('/').pop(),
      // Platforms can be added while the original is still on disk (see prune).
      canAddTargets: existsSync(mediaPath),
      hasThumbnail: Boolean(thumbnailPath),
      captionLanguages: (captions as Array<{ language: string }>).map((c) => c.language),
    };
  }

  /** The post's video in the shape an upload returns, to load it back into the form and add platforms. */
  async #postMedia(id: string) {
    const post = this.#opts.ctx.store.getPost(id);
    if (!post) throw new HttpError(404, msg('게시물이 없습니다'));
    if (!existsSync(post.mediaPath)) throw new HttpError(409, msg('원본 영상이 이미 정리돼 없습니다. 새 게시물로 올리세요'));
    const media = await (this.#opts.probe ?? realProbe)(post.mediaPath);
    return {
      name: post.mediaPath.split('/').pop(),
      media: { ...media, path: undefined },
      isShort: isShort(media),
      assessments: assessMedia(media, this.#opts.providers.values()),
      post: this.#publicPost(post),
      onPost: this.#opts.ctx.store.targetsForPost(id).map((t) => ({ platform: t.platform, account: t.account, state: t.state })),
    };
  }

  /** When a published but still private target is due to go public (a native schedule, or one set later). */
  #goesPublicAt(t: Target): string | undefined {
    if (t.state !== 'published') return undefined;
    const now = this.#opts.ctx.now().getTime();
    const later = (at: unknown) => (typeof at === 'string' && Date.parse(at) > now ? at : undefined);
    if (t.options.privacy === 'private' && later(t.options.publishAt)) return t.options.publishAt as string;
    // Uploaded with a schedule the platform holds itself: private until then, whatever was asked.
    // (A visibility change since records publishAt, null when there is none, and ends that.)
    if (this.#opts.providers.get(t.platform)?.capabilities.nativeSchedule && t.options.publishAt === undefined) return later(this.#opts.ctx.store.getPost(t.postId)?.scheduledAt);
    return undefined;
  }

  /** Per target, keyed on its latest reading and the day: the board asks every few seconds. */
  #viewsCache = new Map<string, { key: string; value: { start: string; points: Array<[number, number]> } | undefined }>();

  /** Views of the last 30 days for the board's small chart: seconds since the first point, and views. */
  #views30d(t: Target) {
    const now = this.#opts.ctx.now();
    const key = `${t.stats?.fetchedAt ?? ''}|${now.toISOString().slice(0, 10)}`;
    const hit = this.#viewsCache.get(t.id);
    if (hit?.key === key) return hit.value;
    const series = viewsSeries(this.#opts.ctx.store, t.id, now);
    const start = series ? Date.parse(series[0]!.at) : 0;
    const value = series ? { start: series[0]!.at, points: series.map((p) => [Math.round((Date.parse(p.at) - start) / 1000), p.views] as [number, number]) } : undefined;
    if (this.#viewsCache.size > 5000) this.#viewsCache.clear();
    this.#viewsCache.set(t.id, { key, value });
    return value;
  }

  #publicTarget(t: Target) {
    const { resume: _r, ...rest } = t;
    const provider = this.#opts.providers.get(t.platform);
    return {
      ...rest,
      terminal: isTerminal(t.state),
      statsCost: provider?.statsCost,
      removable: t.state === 'published' && Boolean(provider?.remove),
      // Retrying it could post it twice: the dashboard asks the user to check the platform first.
      mayBeDuplicate: Boolean(mayBeDuplicate(t)),
      visibilities: t.state === 'published' && provider?.setVisibility ? provider.visibilities : undefined,
      goesPublicAt: this.#goesPublicAt(t),
      trend: t.stats ? statsTrend(this.#opts.ctx.store, t.id, this.#opts.ctx.now()) : undefined,
      views30d: t.stats ? this.#views30d(t) : undefined,
    };
  }
}
