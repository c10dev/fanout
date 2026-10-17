import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { MediaInfo } from '../src/core/media.ts';
import type { Provider } from '../src/core/provider.ts';
import { Dashboard } from '../src/server/server.ts';
import { fakeMedia, makeCtx } from './helpers.ts';

function fakeProvider(id: string, publish: () => Promise<unknown> = async () => ({ state: 'published', remoteId: 'R', remoteUrl: `https://${id}.example/R` })): Provider {
  return {
    id,
    displayName: id.toUpperCase(),
    capabilities: { nativeSchedule: false, thumbnail: false, captions: false, syntheticMediaFlag: false },
    spec: { maxDurationSec: 60 },
    appFields: [],
    connectMethod: 'token',
    setupGuide: () => '',
    connect: async () => {
      throw new Error('n/a');
    },
    refresh: async (_c, a) => a,
    validate: () => [],
    publish: publish as Provider['publish'],
    poll: async () => ({ state: 'published', remoteId: 'R' }),
    doctor: async () => [],
  };
}

describe('dashboard server', () => {
  const env = makeCtx(globalThis.fetch, () => new Date());
  let probeResult: MediaInfo | Error = fakeMedia({ durationSec: 20 });
  let failNext = false;
  const dashboard = new Dashboard({
    ctx: env.ctx,
    providers: new Map([
      ['alpha', fakeProvider('alpha', async () => {
        if (failNext) {
          failNext = false;
          const { ProviderError } = await import('../src/core/errors.ts');
          throw new ProviderError('rejected', 'alpha.nope', 'refused');
        }
        return { state: 'published', remoteId: 'R', remoteUrl: 'https://alpha.example/R' };
      })],
      ['beta', fakeProvider('beta')],
    ]),
    port: 0,
    token: 'test-token',
    workerIntervalMs: 60_000,
    pollIntervalMs: 1,
    probe: async (path) => {
      if (probeResult instanceof Error) throw probeResult;
      return { ...probeResult, path };
    },
    ensureVariant: async (info) => ({ path: info.path, transcoded: false, reasons: [] }),
  });
  let base = '';
  const auth = { 'x-fanout-token': 'test-token' };

  before(async () => {
    base = (await dashboard.start()).replace(/\/$/, '');
    env.store.saveAccount({ platform: 'alpha', name: 'main', credentials: { secret: 'TOKEN-XYZ' }, profile: { channelTitle: '내 채널' } });
  });
  after(async () => {
    await dashboard.idle();
    await dashboard.stop();
    env.store.close();
  });

  async function upload(name = 'clip.mp4'): Promise<Response> {
    return fetch(`${base}/api/media`, { method: 'POST', headers: { ...auth, 'x-filename': encodeURIComponent(name) }, body: Buffer.alloc(2048, 1) });
  }

  it('serves the page with a strict CSP and keeps an explicit token out of it', async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.match(html, /name="fanout-token" content=""/);
    assert.match(res.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
  });

  it('embeds a generated token only when nothing but loopback can reach it', async () => {
    const page = async (opts: Partial<ConstructorParameters<typeof Dashboard>[0]>) => {
      const d = new Dashboard({ ctx: env.ctx, providers: new Map(), port: 0, workerIntervalMs: 60_000, ...opts });
      const url = await d.start();
      const html = await (await fetch(url)).text();
      await d.stop();
      return { html, token: d.token };
    };
    const local = await page({});
    assert.ok(local.html.includes(`content="${local.token}"`));
    const proxied = await page({ allowedHosts: ['fanout.example:443'] });
    assert.match(proxied.html, /name="fanout-token" content=""/);
  });

  it('requires the token on API calls', async () => {
    assert.equal((await fetch(`${base}/api/overview`)).status, 401);
    assert.equal((await fetch(`${base}/api/overview`, { headers: { 'x-fanout-token': 'wrong' } })).status, 401);
  });

  it('rejects unknown Host headers (DNS rebinding)', async () => {
    const { port } = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/overview', headers: { host: `evil.example:${port}`, ...auth } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 421);
  });

  it('lists platforms and account labels without credentials', async () => {
    const res = await fetch(`${base}/api/overview`, { headers: auth });
    const text = await res.text();
    assert.ok(!text.includes('TOKEN-XYZ'));
    const body = JSON.parse(text) as { platforms: Array<{ id: string; accounts: Array<{ label: string }> }> };
    assert.deepEqual(body.platforms.find((p) => p.id === 'alpha')?.accounts, [{ name: 'main', label: '내 채널' }]);
    assert.deepEqual(body.platforms.find((p) => p.id === 'beta')?.accounts, []);
  });

  it('accepts a video upload and returns per-platform verdicts', async () => {
    const res = await upload();
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string; media: { path?: string }; assessments: Array<{ platform: string; verdict: string }> };
    assert.match(body.id, /\.mp4$/);
    assert.equal(body.media.path, undefined, 'must not leak local paths');
    assert.deepEqual(body.assessments.map((a) => a.verdict), ['as_is', 'as_is']);
  });

  it('refuses non-video extensions and unreadable files', async () => {
    assert.equal((await upload('notes.txt')).status, 415);
    probeResult = new Error('Invalid data found when processing input');
    const before = readdirSync(join(env.home, 'media')).length;
    assert.equal((await upload()).status, 422);
    assert.equal(readdirSync(join(env.home, 'media')).length, before, 'unreadable upload is deleted');
    probeResult = fakeMedia({ durationSec: 20 });
  });

  it('creates a post, runs it in the background and shows the result', async () => {
    const { id } = (await (await upload()).json()) as { id: string };
    const res = await fetch(`${base}/api/posts`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ mediaId: id, title: '대시보드 테스트', tags: ['a'], targets: [{ platform: 'alpha', account: 'main', options: {} }] }),
    });
    assert.equal(res.status, 201);
    await dashboard.idle();
    const posts = (await (await fetch(`${base}/api/posts`, { headers: auth })).json()) as Array<{
      post: Record<string, unknown>;
      targets: Array<Record<string, unknown>>;
    }>;
    const mine = posts.find((p) => p.post.title === '대시보드 테스트')!;
    assert.equal(mine.targets[0]!.state, 'published');
    assert.equal(mine.targets[0]!.remoteUrl, 'https://alpha.example/R');
    assert.equal(mine.post.mediaPath, undefined);
    assert.equal(mine.targets[0]!.resume, undefined);
  });

  it('validates post requests', async () => {
    const post = (body: unknown) => fetch(`${base}/api/posts`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ mediaId: '../../etc/passwd', title: 't', targets: [{ platform: 'alpha', account: 'main' }] })).status, 400);
    const { id } = (await (await upload()).json()) as { id: string };
    const res = await post({ mediaId: id, title: 't', targets: [{ platform: 'beta', account: 'main' }] });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /연결되지 않은 계정/);
  });

  it('retries a failed target and refuses to retry a published one', async () => {
    failNext = true;
    const { id } = (await (await upload()).json()) as { id: string };
    const created = (await (
      await fetch(`${base}/api/posts`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ mediaId: id, title: 'retry me', targets: [{ platform: 'alpha', account: 'main', options: {} }] }),
      })
    ).json()) as { post: { id: string }; targets: Array<{ id: string }> };
    await dashboard.idle();
    const targetId = created.targets[0]!.id;
    assert.equal(env.store.getTarget(targetId)!.state, 'failed');

    const retry = await fetch(`${base}/api/targets/${targetId}/retry`, { method: 'POST', headers: auth });
    assert.equal(retry.status, 200);
    await dashboard.idle();
    assert.equal(env.store.getTarget(targetId)!.state, 'published');
    assert.equal((await fetch(`${base}/api/targets/${targetId}/retry`, { method: 'POST', headers: auth })).status, 409);

    const detail = (await (await fetch(`${base}/api/posts/${created.post.id}`, { headers: auth })).json()) as {
      targets: Array<{ events: Array<{ to: string }> }>;
    };
    assert.deepEqual(detail.targets[0]!.events.map((e) => e.to), ['queued', 'uploading', 'failed', 'queued', 'uploading', 'published']);
  });
});
