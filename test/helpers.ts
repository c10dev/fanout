import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretBox } from '../src/core/crypto.ts';
import type { MediaInfo } from '../src/core/media.ts';
import type { ProviderContext } from '../src/core/provider.ts';
import { Store } from '../src/core/store.ts';

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

/** Ordered fetch mock: each route is [method, url substring, handler]; first match wins, routes are reusable. */
export function mockFetch(routes: Array<[string, string, Handler]>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const call: Call = { method, url, headers, body: init.body };
    calls.push(call);
    const route = routes.find(([m, u]) => m === method && url.includes(u));
    if (!route) throw new Error(`unmocked ${method} ${url}`);
    return route[2](call);
  };
  return { fetch: fn as typeof fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function makeCtx(fetchImpl: typeof fetch = mockFetch([]).fetch, now = () => new Date('2026-10-17T03:00:00Z')) {
  const home = mkdtempSync(join(tmpdir(), 'fanout-test-'));
  const box = new SecretBox(randomBytes(32));
  const store = new Store(join(home, 'fanout.db'), box, now);
  const logs: string[] = [];
  const ctx: ProviderContext = {
    store,
    fetch: fetchImpl,
    now,
    home,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(`WARN ${m}`) },
  };
  return { ctx, store, logs, home };
}

export function fakeMedia(overrides: Partial<MediaInfo> = {}, video: Partial<MediaInfo['video']> = {}): MediaInfo {
  return {
    path: '/tmp/x.mp4',
    sizeBytes: 10 * 1024 * 1024,
    durationSec: 30,
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    bitrate: 5_000_000,
    video: { codec: 'h264', width: 1080, height: 1920, fps: 30, pixFmt: 'yuv420p', ...video },
    audio: { codec: 'aac', sampleRate: 48_000, channels: 2 },
    ...overrides,
  };
}

/** A file of `size` bytes for upload tests. */
export function tempFile(size: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-file-'));
  const path = join(dir, 'video.mp4');
  writeFileSync(path, Buffer.alloc(size, 7));
  return path;
}

/** A server that answers every request with `body` after `ms`, and honours an abort signal. */
export function slowFetch(body: unknown, ms: number): typeof fetch {
  return ((_: unknown, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      setTimeout(() => resolve(json(body)), ms);
    })) as typeof fetch;
}
