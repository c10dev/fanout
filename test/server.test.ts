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

  it('accepts thumbnail and caption assets and attaches them to a post', async () => {
    const asset = (kind: string, name: string, bytes: number) =>
      fetch(`${base}/api/assets/${kind}`, { method: 'POST', headers: { ...auth, 'x-filename': encodeURIComponent(name) }, body: Buffer.alloc(bytes, 1) });
    assert.equal((await asset('thumbnail', 'cover.gif', 10)).status, 415);
    assert.equal((await asset('thumbnail', 'huge.png', 3 * 1024 * 1024)).status, 413);
    const thumb = (await (await asset('thumbnail', 'cover.png', 100)).json()) as { id: string };
    const sub = (await (await asset('caption', 'ko.srt', 50)).json()) as { id: string };
    const { id: mediaId } = (await (await upload()).json()) as { id: string };

    const post = (extra: Record<string, unknown>) =>
      fetch(`${base}/api/posts`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ mediaId, title: 'with assets', targets: [{ platform: 'alpha', account: 'main', options: {} }], ...extra }),
      });
    assert.equal((await post({ thumbnailId: sub.id })).status, 400, 'a caption file is not a thumbnail');
    assert.equal((await post({ captions: [{ language: 'korean!', assetId: sub.id }] })).status, 400);

    const res = await post({ thumbnailId: thumb.id, captions: [{ language: 'ko', assetId: sub.id }] });
    assert.equal(res.status, 201);
    const created = (await res.json()) as { post: { id: string; hasThumbnail: boolean; captionLanguages: string[]; thumbnailPath?: string } };
    assert.equal(created.post.hasThumbnail, true);
    assert.deepEqual(created.post.captionLanguages, ['ko']);
    assert.equal(created.post.thumbnailPath, undefined, 'no local paths in responses');
    const stored = env.store.getPost(created.post.id)!;
    assert.match(stored.thumbnailPath ?? '', /\.png$/);
    assert.equal(stored.captions[0]!.language, 'ko');
    await dashboard.idle();
  });

  it('previews a post without creating it', async () => {
    const before = env.store.listPosts(100).length;
    const { id } = (await (await upload()).json()) as { id: string };
    const res = await fetch(`${base}/api/preview`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ mediaId: id, title: 'preview', targets: [{ platform: 'alpha', account: 'main', options: {} }] }),
    });
    assert.equal(res.status, 200);
    const { targets } = (await res.json()) as { targets: Array<{ platform: string; accountLabel: string; verdict: string; errors: string[] }> };
    assert.deepEqual(targets.map((t) => [t.platform, t.accountLabel, t.verdict, t.errors]), [['alpha', '내 채널', 'as_is', []]]);
    assert.equal(env.store.listPosts(100).length, before, 'nothing created');
  });

  it('warns in the preview when the same video already went to that account', async () => {
    const body = (id: string) => JSON.stringify({ mediaId: id, title: 'dup', targets: [{ platform: 'alpha', account: 'main', options: {} }] });
    const first = (await (await upload()).json()) as { id: string };
    await fetch(`${base}/api/posts`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: body(first.id) });
    await dashboard.idle();
    const second = (await (await upload()).json()) as { id: string }; // same bytes as the first upload
    const res = await fetch(`${base}/api/preview`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: body(second.id) });
    const { targets } = (await res.json()) as { targets: Array<{ warnings: string[] }> };
    assert.ok(targets[0]!.warnings.some((w) => w.includes('이미 올렸습니다')));
  });

  it('routes post sub-resources (comments) past the post detail route', async () => {
    const posts = (await (await fetch(`${base}/api/posts`, { headers: auth })).json()) as Array<{ post: { id: string } }>;
    const id = posts[0]!.post.id;
    const res = await fetch(`${base}/api/posts/${id}/comments?limit=5`, { headers: auth });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { results?: unknown[] };
    assert.ok(Array.isArray(body.results), 'comments endpoint, not the post detail');
  });

  it('adds a platform to an existing post', async () => {
    env.store.saveAccount({ platform: 'beta', name: 'main', credentials: {}, profile: {} });
    const { id } = (await (await upload()).json()) as { id: string };
    const json = { ...auth, 'content-type': 'application/json' };
    const created = (await (
      await fetch(`${base}/api/posts`, { method: 'POST', headers: json, body: JSON.stringify({ mediaId: id, title: 'add to me', targets: [{ platform: 'alpha', account: 'main', options: {} }] }) })
    ).json()) as { post: { id: string; canAddTargets: boolean } };
    assert.equal(created.post.canAddTargets, true);
    const add = (suffix: string, platform: string) =>
      fetch(`${base}/api/posts/${created.post.id}/targets${suffix}`, { method: 'POST', headers: json, body: JSON.stringify({ targets: [{ platform, account: 'main', options: {} }] }) });
    const preview = (await (await add('/preview', 'beta')).json()) as { targets: Array<{ platform: string }> };
    assert.deepEqual(preview.targets.map((t) => t.platform), ['beta']);
    assert.equal((await add('', 'alpha')).status, 409, 'alpha is already on the post');
    assert.equal((await add('', 'beta')).status, 201);
    const media = (await (await fetch(`${base}/api/posts/${created.post.id}/media`, { headers: auth })).json()) as { onPost: Array<{ platform: string }>; assessments: unknown[] };
    assert.deepEqual(media.onPost.map((t) => t.platform).sort(), ['alpha', 'beta']);
    assert.ok(Array.isArray(media.assessments));
    // Other tests expect beta to be unconnected.
    env.store.removeAccount('beta', 'main');
  });

  it('lists only upcoming scheduled posts with scheduled=1', async () => {
    const res = await fetch(`${base}/api/posts?scheduled=1&limit=10`, { headers: auth });
    assert.equal(res.status, 200);
    const posts = (await res.json()) as Array<{ post: { scheduledAt?: string } }>;
    assert.ok(posts.every((p) => p.post.scheduledAt && Date.parse(p.post.scheduledAt) >= Date.now() - 60_000));
  });

  it('serves the translations next to the app', async () => {
    const res = await fetch(`${base}/i18n.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
    assert.match(await res.text(), /MESSAGES_EN/);
    assert.match(await (await fetch(`${base}/`)).text(), /<script src="\/i18n\.js" defer><\/script>\s*<script src="\/app\.js"/);
  });

  it('answers in English when the dashboard asks for it, Korean otherwise', async () => {
    const { msg } = await import('../src/core/i18n.ts');
    const { targets } = env.store.createPost({ mediaPath: '/x.mp4', title: '내 영상', description: '', tags: [], captions: [], containsSyntheticMedia: false }, [{ platform: 'alpha', account: 'main', options: {} }]);
    env.store.transition(targets[0]!.id, 'failed', { errorCode: 'x', errorMessage: msg('연결된 계정 없음: {platform}/{account} — fanout connect {platform} 실행', { platform: 'alpha', account: 'main' }) });
    const get = async (lang?: string) =>
      ((await (await fetch(`${base}/api/posts?limit=50`, { headers: { ...auth, ...(lang ? { 'x-fanout-lang': lang } : {}) } })).json()) as Array<{ post: { title: string }; targets: Array<{ id: string; errorMessage?: string }> }>).find(
        (p) => p.targets.some((t) => t.id === targets[0]!.id),
      )!;
    const en = await get('en');
    assert.equal(en.targets[0]!.errorMessage, 'No connected account: alpha/main — run fanout connect alpha');
    assert.equal(en.post.title, '내 영상', 'user content untouched');
    assert.match((await get()).targets[0]!.errorMessage!, /연결된 계정 없음/);
    const denied = await fetch(`${base}/api/posts`, { headers: { 'x-fanout-lang': 'en' } });
    assert.equal(((await denied.json()) as { error: string }).error, 'The dashboard token is required');
  });

  it('validates replies and reports refusals as conflicts', async () => {
    const reply = (id: string, body: unknown) => fetch(`${base}/api/targets/${id}/reply`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await reply('nope', { text: 'hi' })).status, 400);
    const res = await reply('nope', { commentId: 'c', text: 'hi' });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /대상 없음/);
  });

  it('answers malformed percent-encoding with 400, and a wrong token with 401', async () => {
    const res = await fetch(`${base}/api/media`, { method: 'POST', headers: { ...auth, 'x-filename': '%E0%A4%A' }, body: Buffer.alloc(16) });
    assert.equal(res.status, 400);
    assert.equal((await fetch(`${base}/api/posts`, { headers: { 'x-fanout-token': 'x' } })).status, 401);
    assert.equal((await fetch(`${base}/api/posts`, { headers: { 'x-fanout-token': `${auth['x-fanout-token']}x` } })).status, 401);
  });

  it('saves, lists and deletes presets', async () => {
    const put = (name: string, body: unknown) => fetch(`${base}/api/presets/${encodeURIComponent(name)}`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await put('빈 것', { targets: [] })).status, 400);
    assert.equal((await put('숏폼', { targets: [{ platform: 'alpha', account: 'main', options: { x: 1 } }, { platform: 'nope' }], tags: ['kpop'] })).status, 200);
    const list = (await (await fetch(`${base}/api/presets`, { headers: auth })).json()) as { presets: Array<{ name: string; targets: Array<{ platform: string }>; tags: string[] }> };
    assert.deepEqual(list.presets.map((p) => [p.name, p.targets.map((t) => t.platform), p.tags]), [['숏폼', ['alpha'], ['kpop']]]);
    const after = (await (await fetch(`${base}/api/presets/${encodeURIComponent('숏폼')}`, { method: 'DELETE', headers: auth })).json()) as { presets: unknown[] };
    assert.deepEqual(after.presets, []);
  });

  it('keeps preset names and options as written in English, so they can be deleted', async () => {
    const en = { ...auth, 'x-fanout-lang': 'en' };
    // "전체", "썸네일" and "실패" are also whole messages in the catalogue.
    const options = { caption: '오늘의 영상\n썸네일', alt: '실패', spoilerText: '전체' };
    await fetch(`${base}/api/presets/${encodeURIComponent('전체')}`, { method: 'PUT', headers: { ...en, 'content-type': 'application/json' }, body: JSON.stringify({ targets: [{ platform: 'alpha', account: 'main', options }] }) });
    const list = (await (await fetch(`${base}/api/presets`, { headers: en })).json()) as { presets: Array<{ name: string; targets: Array<{ options: unknown }> }> };
    assert.deepEqual(list.presets.map((p) => [p.name, p.targets[0]!.options]), [['전체', options]]);
    const after = (await (await fetch(`${base}/api/presets/${encodeURIComponent(list.presets[0]!.name)}`, { method: 'DELETE', headers: en })).json()) as { presets: unknown[] };
    assert.deepEqual(after.presets, []);
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

    // One that may already be on the platform: 409 needsConfirm, queued only with confirmedNotPosted.
    const made = env.store.createPost({ mediaPath: '/v.mp4', title: 'maybe posted', description: '', tags: [], captions: [], containsSyntheticMedia: false }, [{ platform: 'beta', account: 'main', options: {} }]);
    const maybe = made.targets[0]!.id;
    env.store.transition(maybe, 'uploading');
    env.store.transition(maybe, 'failed', { errorCode: 'beta.maybe_posted' });
    const board = (await (await fetch(`${base}/api/posts?limit=5`, { headers: auth })).json()) as Array<{ targets: Array<{ id: string; mayBeDuplicate?: boolean }> }>;
    assert.equal(board.flatMap((p) => p.targets).find((t) => t.id === maybe)!.mayBeDuplicate, true);
    const held = await fetch(`${base}/api/targets/${maybe}/retry`, { method: 'POST', headers: auth });
    assert.equal(held.status, 409);
    assert.equal(((await held.json()) as { needsConfirm?: boolean }).needsConfirm, true);
    assert.equal(env.store.getTarget(maybe)!.state, 'failed');
    const confirmed = await fetch(`${base}/api/targets/${maybe}/retry`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ confirmedNotPosted: true }) });
    assert.equal(confirmed.status, 200);

    // Cancel works the same way: a target that may be live needs the user's word first.
    const live = env.store.createPost({ mediaPath: '/v.mp4', title: 'maybe live', description: '', tags: [], captions: [], containsSyntheticMedia: false }, [{ platform: 'beta', account: 'main', options: {} }]);
    const liveId = live.targets[0]!.id;
    env.store.transition(liveId, 'uploading');
    env.store.transition(liveId, 'failed', { errorCode: 'beta.maybe_posted' });
    const cancelHeld = await fetch(`${base}/api/targets/${liveId}/cancel`, { method: 'POST', headers: auth });
    assert.equal(cancelHeld.status, 409);
    assert.equal(((await cancelHeld.json()) as { needsConfirm?: boolean }).needsConfirm, true);
    const cancelled = await fetch(`${base}/api/targets/${liveId}/cancel`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ confirmedNotPosted: true }) });
    assert.equal(cancelled.status, 200);
    assert.equal(env.store.getTarget(liveId)!.state, 'canceled');

    const detail = (await (await fetch(`${base}/api/posts/${created.post.id}`, { headers: auth })).json()) as {
      targets: Array<{ events: Array<{ to: string }> }>;
    };
    assert.deepEqual(detail.targets[0]!.events.map((e) => e.to), ['queued', 'uploading', 'failed', 'queued', 'uploading', 'published']);
  });
});
