import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { probe as realProbe, type MediaInfo } from '../core/media.ts';
import { assessMedia, createScheduledPost } from '../core/posting.ts';
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
const JSON_LIMIT = 1024 * 1024;

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
  #allowedHosts = new Set<string>();
  #running = new Set<Promise<unknown>>();

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
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) this.#opts.ctx.log.warn(`dashboard: ${err instanceof Error ? err.stack : String(err)}`);
        if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : String(err) });
        else res.end();
      });
    });
    await new Promise<void>((r) => this.#server!.listen(this.#opts.port ?? 8780, host, r));
    const port = (this.#server.address() as AddressInfo).port;
    for (const h of ['127.0.0.1', 'localhost', '[::1]']) this.#allowedHosts.add(`${h}:${port}`);
    if (!isLoopback(host)) this.#allowedHosts.add(`${host}:${port}`);
    for (const h of this.#opts.allowedHosts ?? []) this.#allowedHosts.add(h);

    this.#timer = setInterval(() => this.tick(), this.#opts.workerIntervalMs ?? 15_000);
    this.tick();
    return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    // Drop in-flight requests first so a long upload can't hold Ctrl+C; interrupted work resumes next start.
    this.#server?.closeAllConnections();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
  }

  /** Wait for in-flight runner work (tests). */
  async idle(): Promise<void> {
    while (this.#running.size) await Promise.all(this.#running);
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
    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
    if (req.headers['x-fanout-token'] !== this.#token) throw new HttpError(401, '대시보드 토큰이 필요합니다');

    const parts = url.pathname.split('/').filter(Boolean).slice(1);
    if (method === 'GET' && parts[0] === 'overview') return send(res, 200, this.#overview());
    if (method === 'POST' && parts[0] === 'media' && parts.length === 1) return send(res, 201, await this.#upload(req));
    if (method === 'GET' && parts[0] === 'posts' && parts.length === 1) return send(res, 200, this.#listPosts(Number(url.searchParams.get('limit') ?? 20)));
    if (method === 'POST' && parts[0] === 'posts' && parts.length === 1) return send(res, 201, await this.#createPost(req));
    if (method === 'GET' && parts[0] === 'posts' && parts[1]) return send(res, 200, this.#postDetail(parts[1]));
    if (method === 'POST' && parts[0] === 'targets' && parts[1] && parts[2] === 'retry') return send(res, 200, this.#retry(parts[1]));
    throw new HttpError(404, 'not found');
  }

  #page(res: ServerResponse): void {
    // Embed the token only for a purely local dashboard with a generated token. Anything reachable
    // another way (extra allowed hosts, e.g. behind a proxy) asks the user to paste it.
    const local = isLoopback(this.#opts.host ?? '127.0.0.1') && !this.#opts.allowedHosts?.length && !this.#opts.token;
    const embed = local ? this.#token : '';
    const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8').replace('__FANOUT_TOKEN__', embed);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    res.end(html);
  }

  #overview() {
    const { store } = this.#opts.ctx;
    const accounts = store.listAccounts();
    return {
      platforms: [...this.#opts.providers.values()].map((p) => ({
        id: p.id,
        displayName: p.displayName,
        capabilities: p.capabilities,
        appConfigured: Boolean(store.getApp(p.appKey ?? p.id)),
        accounts: accounts
          .filter((a) => a.platform === p.id)
          .map((a) => {
            const pr = a.profile as Record<string, string | undefined>;
            return { name: a.name, label: pr.channelTitle ?? (pr.username ? `@${pr.username}` : undefined) ?? pr.pageName ?? pr.displayName ?? a.name };
          }),
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
      captions: [],
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
    const { mediaPath, thumbnailPath: _t, captions: _c, ...rest } = p;
    return { ...rest, mediaName: mediaPath.split('/').pop() };
  }

  #publicTarget(t: Target) {
    const { resume: _r, ...rest } = t;
    return { ...rest, terminal: isTerminal(t.state) };
  }
}
