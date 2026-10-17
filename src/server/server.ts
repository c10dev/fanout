import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { probe as realProbe, type MediaInfo } from '../core/media.ts';
import { assessMedia, createScheduledPost } from '../core/posting.ts';
import { applyPrune, formatBytes, planPrune } from '../core/prune.ts';
import { ProviderError } from '../core/errors.ts';
import type { Provider, ProviderContext } from '../core/provider.ts';
import { settle, type RunnerDeps } from '../core/runner.ts';
import { isTerminal } from '../core/state.ts';
import type { PostInput, Target, TargetInput } from '../core/types.ts';
import { isShort } from '../providers/youtube.ts';

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
  '/style.css': 'text/css; charset=utf-8',
};
const MEDIA_ID = /^[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
/** Thumbnail and caption uploads: YouTube accepts JPEG/PNG up to 2MB and these caption formats. */
const ASSET_KINDS = {
  thumbnail: { ext: new Set(['.jpg', '.jpeg', '.png']), maxBytes: 2 * 1024 * 1024 },
  caption: { ext: new Set(['.srt', '.vtt', '.sbv', '.scc', '.ttml', '.dfxp']), maxBytes: 5 * 1024 * 1024 },
} as const;
type AssetKind = keyof typeof ASSET_KINDS;
const JSON_LIMIT = 1024 * 1024;
const PRUNE_INTERVAL_MS = 6 * 3600_000;
const ACCOUNT_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const OAUTH_TTL_MS = 10 * 60_000;

interface PendingOAuth {
  platform: string;
  name: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
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

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > JSON_LIMIT) throw new HttpError(413, '요청 본문이 너무 큽니다');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'JSON 형식이 아닙니다');
  }
}

interface CreatePostBody {
  mediaId?: string;
  title?: string;
  description?: string;
  tags?: string[];
  scheduledAt?: string;
  containsSyntheticMedia?: boolean;
  targets?: TargetInput[];
  /** From POST /api/assets/thumbnail. */
  thumbnailId?: string;
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
  readonly #busyPlatforms = new Set<string>();
  #server?: Server;
  #timer?: NodeJS.Timeout;
  #pruneTimer?: NodeJS.Timeout;
  #allowedHosts = new Set<string>();
  #running = new Set<Promise<unknown>>();
  readonly #pendingOAuth = new Map<string, PendingOAuth>();

  constructor(opts: DashboardOptions) {
    this.#opts = opts;
    this.#token = opts.token ?? randomBytes(24).toString('base64url');
    this.#mediaDir = join(opts.ctx.home, 'media');
    this.#deps = { ctx: opts.ctx, providers: opts.providers, probe: opts.probe, ensureVariant: opts.ensureVariant };
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

    this.#timer = setInterval(() => this.tick(), this.#opts.workerIntervalMs ?? 15_000);
    if (this.#opts.pruneDays !== null) {
      this.prune();
      this.#pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    }
    this.tick();
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    clearInterval(this.#pruneTimer);
    // Drop in-flight requests first so a long upload can't hold Ctrl+C; interrupted work resumes next start.
    this.#server?.closeAllConnections();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
  }

  /** Wait for in-flight runner work (tests). */
  async idle(): Promise<void> {
    while (this.#running.size) await Promise.all(this.#running);
  }

  /** Delete finished originals and stale transcodes under the fanout home (see planPrune). */
  prune(): void {
    try {
      const items = planPrune(this.#opts.ctx.home, this.#opts.ctx.store, { days: this.#opts.pruneDays ?? 7, now: this.#opts.ctx.now() });
      if (items.length) this.#opts.ctx.log.info(`정리: 파일 ${items.length}개, ${formatBytes(applyPrune(items))}`);
    } catch (err) {
      this.#opts.ctx.log.warn(`정리 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Start one runner per idle platform over its due targets; platforms never upload two at once. */
  tick(): void {
    const byPlatform = new Map<string, string[]>();
    for (const t of this.#opts.ctx.store.workableTargets()) {
      if (this.#busyPlatforms.has(t.platform)) continue;
      byPlatform.set(t.platform, [...(byPlatform.get(t.platform) ?? []), t.id]);
    }
    for (const [platform, ids] of byPlatform) {
      this.#busyPlatforms.add(platform);
      const run = settle(this.#deps, ids, { pollIntervalMs: this.#opts.pollIntervalMs ?? 10_000, timeoutMs: 10 * 60_000 })
        .catch((err: unknown) => this.#opts.ctx.log.warn(`worker(${platform}): ${String(err)}`))
        .finally(() => {
          this.#busyPlatforms.delete(platform);
          this.#running.delete(run);
        });
      this.#running.add(run);
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (!this.#allowedHosts.has(req.headers.host ?? '')) throw new HttpError(421, `허용되지 않은 Host: ${req.headers.host}`);

    const url = new URL(req.url ?? '/', 'http://local');
    const method = req.method ?? 'GET';

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return this.#page(res);
    if (method === 'GET' && STATIC[url.pathname]) {
      res.writeHead(200, { 'content-type': STATIC[url.pathname]!, 'cache-control': 'no-cache' });
      res.end(readFileSync(join(PUBLIC_DIR, url.pathname.slice(1))));
      return;
    }
    if (method === 'GET' && url.pathname.startsWith('/oauth/') && url.pathname.endsWith('/callback')) return this.#oauthCallback(req, res, url);
    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
    if (req.headers['x-fanout-token'] !== this.#token) throw new HttpError(401, '대시보드 토큰이 필요합니다');

    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    if (method === 'GET' && parts[0] === 'overview') return send(res, 200, this.#overview());
    if (method === 'POST' && parts[0] === 'media' && parts.length === 1) return send(res, 201, await this.#upload(req));
    if (method === 'POST' && parts[0] === 'assets' && (parts[1] === 'thumbnail' || parts[1] === 'caption')) return send(res, 201, await this.#uploadAsset(req, parts[1]));
    if (method === 'GET' && parts[0] === 'posts' && parts.length === 1) return send(res, 200, this.#listPosts(Number(url.searchParams.get('limit') ?? 20)));
    if (method === 'POST' && parts[0] === 'posts' && parts.length === 1) return send(res, 201, await this.#createPost(req));
    if (method === 'GET' && parts[0] === 'posts' && parts[1]) return send(res, 200, this.#postDetail(parts[1]));
    if (method === 'POST' && parts[0] === 'targets' && parts[1] && parts[2] === 'retry') return send(res, 200, this.#retry(parts[1]));

    // Settings: app secrets and account tokens, local dashboards only.
    if (['settings', 'apps', 'connect', 'accounts', 'doctor'].includes(parts[0] ?? '')) this.#requireSettings();
    if (method === 'GET' && parts[0] === 'settings') return send(res, 200, this.#settings(req));
    if (method === 'PUT' && parts[0] === 'apps' && parts[1]) return send(res, 200, this.#saveApp(parts[1], await readJson(req)));
    if (method === 'POST' && parts[0] === 'connect' && parts[1]) return send(res, 200, await this.#connect(req, parts[1], await readJson(req)));
    if (method === 'DELETE' && parts[0] === 'accounts' && parts[1] && parts[2]) return send(res, 200, this.#disconnect(parts[1], decodeURIComponent(parts[2])));
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
      throw new HttpError(403, '설정 화면은 127.0.0.1 전용입니다. 이 서버에서 터미널로 fanout app set / connect 를 쓰세요');
    }
  }

  #provider(id: string): Provider {
    const p = this.#opts.providers.get(id);
    if (!p) throw new HttpError(404, `알 수 없는 플랫폼: ${id}`);
    return p;
  }

  #accountLabel(profile: Record<string, unknown>, name: string): string {
    const pr = profile as Record<string, string | undefined>;
    return pr.channelTitle ?? (pr.username ? `@${pr.username}` : undefined) ?? pr.pageName ?? pr.displayName ?? name;
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
        appConfigured: Boolean(store.getApp(p.appKey ?? p.id)),
        connectMethod: p.connectMethod,
        redirectUri: p.connectMethod === 'oauth' ? this.#redirectUri(req, p.id) : undefined,
        accounts: accounts.filter((a) => a.platform === p.id).map((a) => ({ name: a.name, label: this.#accountLabel(a.profile, a.name) })),
      })),
    };
  }

  #saveApp(key: string, body: { values?: Record<string, unknown>; clientJson?: string }) {
    const provider = [...this.#opts.providers.values()].find((p) => (p.appKey ?? p.id) === key);
    if (!provider) throw new HttpError(404, `알 수 없는 앱: ${key}`);
    const { store } = this.#opts.ctx;
    const config: Record<string, unknown> = { ...(store.getApp(key) ?? {}) };
    if (body.clientJson) {
      // Google's downloaded client file: { installed: {...} } or { web: {...} }.
      let parsed: Record<string, { client_id?: string; client_secret?: string }>;
      try {
        parsed = JSON.parse(body.clientJson) as typeof parsed;
      } catch {
        throw new HttpError(400, 'JSON 파일을 읽을 수 없습니다');
      }
      const inner = parsed.installed ?? parsed.web;
      if (!inner?.client_id) throw new HttpError(400, 'client_id가 있는 Google OAuth JSON이 아닙니다');
      if (!parsed.installed) throw new HttpError(400, '"데스크톱 앱" 유형 OAuth 클라이언트 JSON이어야 합니다 (installed)');
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
    if (missing.length) throw new HttpError(400, `필수 항목이 비어 있습니다: ${missing.join(', ')}`);
    store.setApp(key, config);
    return { ok: true };
  }

  async #connect(req: IncomingMessage, platform: string, body: { name?: string; token?: string; page?: string }) {
    const provider = this.#provider(platform);
    const name = (body.name ?? 'main').trim();
    if (!ACCOUNT_NAME.test(name)) throw new HttpError(400, '계정 이름은 영문·숫자·-·_ 32자 이내');

    if (provider.connectMethod === 'oauth') {
      const redirectUri = this.#redirectUri(req, platform);
      const start = provider.oauthBegin!(this.#opts.ctx, redirectUri);
      const now = Date.now();
      for (const [k, v] of this.#pendingOAuth) if (v.expiresAt < now) this.#pendingOAuth.delete(k);
      this.#pendingOAuth.set(start.state, { platform, name, verifier: start.verifier, redirectUri, expiresAt: now + OAUTH_TTL_MS });
      return { authorizeUrl: start.url };
    }

    if (!body.token?.trim()) throw new HttpError(400, '액세스 토큰을 붙여넣으세요');
    const account = await provider.connect(this.#opts.ctx, name, { token: body.token.trim(), page: body.page?.trim() || undefined });
    this.#opts.ctx.store.saveAccount(account);
    return { account: { name, label: this.#accountLabel(account.profile, name) } };
  }

  async #oauthCallback(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const back = (params: Record<string, string>) => {
      res.writeHead(303, { location: `/?${new URLSearchParams({ view: 'settings', ...params })}`, 'cache-control': 'no-store' });
      res.end();
    };
    if (!this.settingsEnabled) return back({ oauthError: '설정 화면은 127.0.0.1 전용입니다' });
    const platform = url.pathname.split('/')[2] ?? '';
    const state = url.searchParams.get('state') ?? '';
    const pending = this.#pendingOAuth.get(state);
    this.#pendingOAuth.delete(state);
    if (!pending || pending.platform !== platform || pending.expiresAt < Date.now()) {
      return back({ oauthError: '연결 요청이 만료됐거나 올바르지 않습니다. 다시 연결을 눌러 주세요' });
    }
    try {
      const provider = this.#provider(platform);
      const account = await provider.oauthFinish!(this.#opts.ctx, pending.name, url.searchParams, pending.redirectUri, pending.verifier);
      this.#opts.ctx.store.saveAccount(account);
      back({ connected: `${platform}/${pending.name}` });
    } catch (err) {
      back({ oauthError: err instanceof Error ? err.message : String(err) });
    }
  }

  #disconnect(platform: string, name: string) {
    this.#provider(platform);
    if (!this.#opts.ctx.store.removeAccount(platform, name)) throw new HttpError(404, '해당 계정이 없습니다');
    return { ok: true };
  }

  async #doctor(platform: string, body: { account?: string; live?: boolean }) {
    const provider = this.#provider(platform);
    const name = body.account ?? 'main';
    const account = this.#opts.ctx.store.getAccount(platform, name);
    if (!account) throw new HttpError(404, `${platform}/${name} 계정이 연결되지 않았습니다`);
    try {
      return { checks: await provider.doctor({ ctx: this.#opts.ctx, account, live: Boolean(body.live) }) };
    } catch (err) {
      return { checks: [{ name: '점검 중 오류', status: 'fail', detail: err instanceof Error ? err.message : String(err) }] };
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
        appConfigured: Boolean(store.getApp(p.appKey ?? p.id)),
        accounts: accounts
          .filter((a) => a.platform === p.id)
          .map((a) => ({ name: a.name, label: this.#accountLabel(a.profile, a.name) })),
      })),
    };
  }

  async #upload(req: IncomingMessage) {
    const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'video.mp4'));
    const ext = extname(name).toLowerCase();
    if (!VIDEO_EXT.has(ext)) throw new HttpError(415, `지원하지 않는 확장자: ${ext || '(없음)'}`);
    const id = `${randomUUID()}${ext}`;
    const path = join(this.#mediaDir, id);
    await pipeline(req, createWriteStream(path, { mode: 0o600 }));
    let media: MediaInfo;
    try {
      media = await (this.#opts.probe ?? realProbe)(path);
    } catch (err) {
      rmSync(path, { force: true });
      throw new HttpError(422, `영상으로 읽을 수 없습니다: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    return { id, name, media: { ...media, path: undefined }, isShort: isShort(media), assessments: assessMedia(media, this.#opts.providers.values()) };
  }

  async #uploadAsset(req: IncomingMessage, kind: AssetKind) {
    const rule = ASSET_KINDS[kind];
    const name = decodeURIComponent(String(req.headers['x-filename'] ?? ''));
    const ext = extname(name).toLowerCase();
    if (!(rule.ext as ReadonlySet<string>).has(ext)) {
      throw new HttpError(415, `${kind === 'thumbnail' ? '썸네일' : '자막'} 형식이 아닙니다: ${ext || '(없음)'} (가능: ${[...rule.ext].join(', ')})`);
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (length > rule.maxBytes) throw new HttpError(413, `${kind === 'thumbnail' ? '썸네일' : '자막'}은 ${rule.maxBytes / 1024 / 1024}MB 이하여야 합니다`);
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
            if (size > rule.maxBytes) throw new HttpError(413, '파일이 너무 큽니다');
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
      throw new HttpError(400, `${kind === 'thumbnail' ? '썸네일' : '자막'} 파일을 다시 올려 주세요 (${String(id)})`);
    }
    return path;
  }

  async #createPost(req: IncomingMessage) {
    const body = await readJson<CreatePostBody>(req);
    if (!body.mediaId || !MEDIA_ID.test(body.mediaId) || !existsSync(join(this.#mediaDir, body.mediaId))) {
      throw new HttpError(400, '먼저 영상을 업로드하세요 (mediaId 없음)');
    }
    if (!body.title?.trim()) throw new HttpError(400, '제목을 입력하세요');
    if (!body.targets?.length) throw new HttpError(400, '올릴 플랫폼을 하나 이상 고르세요');
    if (body.scheduledAt && Number.isNaN(Date.parse(body.scheduledAt))) throw new HttpError(400, '예약 시각 형식이 잘못됐습니다');
    const { store } = this.#opts.ctx;
    for (const t of body.targets) {
      if (!this.#opts.providers.has(t.platform)) throw new HttpError(400, `알 수 없는 플랫폼: ${t.platform}`);
      if (!store.getAccount(t.platform, t.account)) throw new HttpError(400, `연결되지 않은 계정: ${t.platform}/${t.account}`);
    }
    const input: PostInput = {
      mediaPath: join(this.#mediaDir, body.mediaId),
      title: body.title.trim(),
      description: body.description ?? '',
      tags: (body.tags ?? []).map((t) => String(t).trim()).filter(Boolean),
      thumbnailPath: body.thumbnailId ? this.#assetPath(body.thumbnailId, 'thumbnail') : undefined,
      captions: (body.captions ?? []).map((c) => {
        const language = String(c.language ?? '').trim();
        if (!/^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) throw new HttpError(400, `자막 언어 코드가 올바르지 않습니다: ${language || '(비어 있음)'} (예: ko, en, ja)`);
        return { language, path: this.#assetPath(c.assetId, 'caption') };
      }),
      containsSyntheticMedia: Boolean(body.containsSyntheticMedia),
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt).toISOString() : undefined,
    };
    const targets = body.targets.map((t) => ({ platform: t.platform, account: t.account, options: t.options ?? {} }));
    const created = createScheduledPost(store, this.#opts.providers, input, targets);
    this.tick();
    return { post: this.#publicPost(created.post), targets: created.targets.map((t) => this.#publicTarget(t)) };
  }

  #listPosts(limit: number) {
    const { store } = this.#opts.ctx;
    return store.listPosts(Math.min(Math.max(limit || 20, 1), 100)).map((p) => ({
      post: this.#publicPost(p),
      targets: store.targetsForPost(p.id).map((t) => this.#publicTarget(t)),
    }));
  }

  #postDetail(id: string) {
    const { store } = this.#opts.ctx;
    const post = store.getPost(id);
    if (!post) throw new HttpError(404, '게시물이 없습니다');
    return {
      post: this.#publicPost(post),
      targets: store.targetsForPost(id).map((t) => ({ ...this.#publicTarget(t), events: store.events(t.id) })),
    };
  }

  #retry(targetId: string) {
    const { store } = this.#opts.ctx;
    const t = store.getTarget(targetId);
    if (!t) throw new HttpError(404, '대상이 없습니다');
    if (t.state !== 'failed' && t.state !== 'needs_reauth') throw new HttpError(409, `${t.state} 상태는 다시 시도할 수 없습니다`);
    const next = store.transition(t.id, 'queued', { attempts: 0, errorCode: undefined, errorMessage: undefined, notBefore: undefined }, 'manual retry');
    this.tick();
    return this.#publicTarget(next);
  }

  /** Never expose local filesystem paths to the browser. */
  #publicPost<P extends { mediaPath: string; thumbnailPath?: string; captions: unknown[] }>(p: P) {
    const { mediaPath, thumbnailPath, captions, ...rest } = p;
    return {
      ...rest,
      mediaName: mediaPath.split('/').pop(),
      hasThumbnail: Boolean(thumbnailPath),
      captionLanguages: (captions as Array<{ language: string }>).map((c) => c.language),
    };
  }

  #publicTarget(t: Target) {
    const { resume: _r, ...rest } = t;
    return { ...rest, terminal: isTerminal(t.state) };
  }
}
