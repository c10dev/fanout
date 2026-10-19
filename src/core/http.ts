import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { extname } from 'node:path';
import { ProviderError, kindForStatus } from './errors.ts';
import { msg } from './i18n.ts';
import type { ProviderContext } from './provider.ts';

/** Read a JSON body; turn non-2xx into ProviderError using `describe` to extract platform codes. */
export async function jsonOrThrow<T>(
  res: Response,
  platform: string,
  describe: (body: unknown) => { code?: string; message?: string } = () => ({}),
): Promise<T> {
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const { code, message } = describe(body);
    throw new ProviderError(
      kindForStatus(res.status),
      `${platform}.http_${res.status}`,
      message ?? `${platform} HTTP ${res.status}: ${text.slice(0, 300)}`,
      code,
    );
  }
  return body as T;
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function pkcePair(encoding: 'base64url' | 'hex' = 'base64url'): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48));
  const digest = createHash('sha256').update(verifier).digest();
  return { verifier, challenge: encoding === 'hex' ? digest.toString('hex') : base64url(digest) };
}

export interface LoopbackResult {
  redirectUri: string;
  /** Resolves with the query params of the first request to the callback path. */
  waitForCallback: Promise<URLSearchParams>;
  close(): void;
}

/**
 * Start a one-shot HTTP listener on 127.0.0.1 for an OAuth redirect.
 * `port` 0 picks a free port (Google desktop clients accept any loopback port);
 * platforms that require an exact registered URI need a fixed port.
 */
export async function startLoopback(port = 0, path = '/callback', host = '127.0.0.1'): Promise<LoopbackResult> {
  let resolve!: (p: URLSearchParams) => void;
  const waitForCallback = new Promise<URLSearchParams>((r) => (resolve = r));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(msg('<p>fanout: 인증이 끝났습니다. 이 창을 닫고 터미널로 돌아가세요.</p>'));
    resolve(url.searchParams);
  });
  // A taken port (another connect still waiting) fails the call instead of crashing the process.
  await new Promise<void>((r, j) => server.once('error', j).listen(port, host, r));
  const actual = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://${host}:${actual}${path}`,
    waitForCallback,
    close: () => server.close(),
  };
}

/** The query of a pasted OAuth redirect (it carries `code` or `error`), or undefined for anything else. */
export function redirectParams(text: string): URLSearchParams | undefined {
  try {
    const params = new URL(text.trim()).searchParams;
    return params.has('code') || params.has('error') ? params : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The OAuth redirect, from whichever comes first: the browser reaching the loopback listener, or the
 * redirected address pasted into the terminal. The paste is for a browser on another machine, where
 * 127.0.0.1 is that machine and the redirect ends on an error page. Callers still check `state`.
 */
export async function waitForRedirect(
  waitForCallback: Promise<URLSearchParams>,
  log: (line: string) => void,
  input: NodeJS.ReadableStream = process.stdin,
): Promise<URLSearchParams> {
  log(msg('브라우저가 다른 기기에 있으면, 승인한 뒤 주소창의 전체 URL(…/callback?code=…)을 여기에 붙여넣으세요'));
  const rl = createInterface({ input, terminal: false });
  const pasted = new Promise<URLSearchParams>((resolve) => {
    rl.on('line', (line) => {
      const params = redirectParams(line);
      if (params) resolve(params);
      else if (line.trim()) log(msg('code가 있는 리디렉트 URL이 아닙니다. 주소창의 전체 URL을 붙여넣으세요'));
    });
  });
  try {
    return await Promise.race([waitForCallback, pasted]);
  } finally {
    rl.close();
  }
}

/** Best effort; the URL is always printed too, so a missing opener is fine. */
export function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // ignore
  }
}

/** Read `length` bytes at `offset` from a file. */
export async function readChunk(path: string, offset: number, length: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** MIME type for a thumbnail image by extension; platforms check the part's type, not the file name. */
export function imageMime(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

/** No platform API answer fanout reads comes near this; a hostile instance's endless body stops here. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * `fetch` whose response bodies stop at `maxBytes`: reading more fails instead of filling memory
 * (a self-hosted instance or PDS is anyone's server). Status and headers are untouched.
 */
export function capResponses(inner: typeof fetch, maxBytes = MAX_RESPONSE_BYTES): typeof fetch {
  const tooLarge = () => new ProviderError('rejected', 'http.too_large', msg('응답이 너무 큽니다 ({max}MB 넘음)', { max: maxBytes / 1024 / 1024 }));
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await inner(input, init);
    if (!res.body) return res;
    if (Number(res.headers.get('content-length')) > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw tooLarge();
    }
    let seen = 0;
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, out) {
          seen += chunk.byteLength;
          if (seen > maxBytes) out.error(tooLarge());
          else out.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

/** Generous: only a server that has stopped answering altogether should hit it. */
const ROTATION_TIMEOUT_MS = 120_000;

/**
 * The context for exchanging a single-use refresh token (PeerTube, Bluesky, X). A short deadline
 * from the caller (a 20 s stats read, a poll) is set aside: aborting after the server has rotated
 * the token but before its answer is stored loses the new pair, and the account must be reconnected.
 */
export function rotationContext(ctx: ProviderContext): ProviderContext {
  // Its own signal takes precedence over the caller's short one (posting.withTimeout only adds a
  // signal to requests that bring none).
  return { ...ctx, fetch: ((input, init) => ctx.fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ROTATION_TIMEOUT_MS) })) as typeof fetch };
}

/**
 * A response body as JSON, or `fallback` when it isn't JSON. An error from reading the body itself
 * (a body over the size cap) is not "not JSON": it is thrown, so it doesn't pass for an empty answer.
 */
export async function jsonOr<T>(res: Response, fallback: T): Promise<unknown> {
  return res.json().catch((err: unknown) => {
    if (err instanceof ProviderError) throw err;
    return fallback;
  });
}
