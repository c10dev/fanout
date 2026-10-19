import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refreshStats } from '../src/core/posting.ts';
import { refreshDueStats, statsTrend } from '../src/core/stats.ts';
import type { PostInput } from '../src/core/types.ts';
import { Worker } from '../src/core/worker.ts';
import { providerMap } from '../src/providers/index.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: 'd', tags: [], captions: [], containsSyntheticMedia: false };
const NOW = new Date('2026-10-17T03:00:00Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3600_000).toISOString();
const yt = { accessToken: 'A', refreshToken: 'R', expiresAt: NOW.getTime() + 3_600_000 };

function published(routes: Parameters<typeof mockFetch>[0], platforms = ['youtube']) {
  const { fetch, calls } = mockFetch(routes);
  const env = makeCtx(fetch, () => NOW);
  for (const p of platforms) env.store.saveAccount({ platform: p, name: 'main', credentials: yt, profile: {} });
  const { post, targets } = env.store.createPost(POST, platforms.map((platform) => ({ platform, account: 'main', options: {} })));
  for (const [i, t] of targets.entries()) {
    env.store.transition(t.id, 'uploading');
    env.store.transition(t.id, 'published', { remoteId: `V${i}` });
  }
  return { ...env, calls, postId: post.id, ids: targets.map((t) => t.id) };
}

describe('stats history', () => {
  it('records successful readings only', async () => {
    let fail = false;
    const { ctx, store, postId, ids } = published([
      ['GET', '/videos?part=statistics', () => (fail ? json({ error: { message: 'backend' } }, 503) : json({ items: [{ statistics: { viewCount: '10', likeCount: '2', commentCount: '1' } }] }))],
    ]);
    await refreshStats(ctx, providerMap(), postId);
    fail = true;
    await refreshStats(ctx, providerMap(), postId);
    assert.deepEqual(store.statsHistory(ids[0]!), [{ at: NOW.toISOString(), views: 10, likes: 2, comments: 1, shares: undefined }]);
    assert.match(store.getTarget(ids[0]!)!.stats!.note ?? '', /가져오지 못함/);
  });

  it('trend is the change since the latest reading at least a day old', () => {
    const { store, ids } = published([]);
    const id = ids[0]!;
    store.recordStats(id, { fetchedAt: ago(30), views: 50, likes: 1 });
    assert.equal(statsTrend(store, id, NOW), undefined, 'one reading is not a trend');
    store.recordStats(id, { fetchedAt: ago(25), views: 100, likes: 4 });
    store.recordStats(id, { fetchedAt: ago(1), views: 340, likes: 10 });
    assert.deepEqual(statsTrend(store, id, NOW), { since: ago(25), views: 240, likes: 6 });

    const young = published([]);
    young.store.recordStats(young.ids[0]!, { fetchedAt: ago(5), views: 1 });
    young.store.recordStats(young.ids[0]!, { fetchedAt: ago(1), views: 9 });
    assert.equal(statsTrend(young.store, young.ids[0]!, NOW), undefined, 'no reading from a day ago yet');
  });

  it('refreshes due targets once per post and platform, skipping paid and fresh ones', async () => {
    const { ctx, store, ids, postId } = published([], ['youtube', 'x']);
    const calls: string[] = [];
    const refresh = async (p: string, platform: string) => void calls.push(`${p}/${platform}`);
    assert.equal(await refreshDueStats(ctx, providerMap(), refresh, { everyMs: 6 * 3600_000 }), 1);
    assert.deepEqual(calls, [`${postId}/youtube`], 'X charges for reads, so it is never automatic');

    store.saveStats(ids[0]!, { fetchedAt: ago(1), views: 1 });
    calls.length = 0;
    assert.equal(await refreshDueStats(ctx, providerMap(), refresh, { everyMs: 6 * 3600_000 }), 0, 'read an hour ago');
    store.saveStats(ids[0]!, { fetchedAt: ago(7), views: 1 });
    assert.equal(await refreshDueStats(ctx, providerMap(), refresh, { everyMs: 6 * 3600_000 }), 1);
  });

  it('stops following posts older than the window', async () => {
    let now = new Date(NOW.getTime() - 40 * 86_400_000);
    const env = makeCtx(mockFetch([]).fetch, () => now);
    const { targets } = env.store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }]);
    env.store.transition(targets[0]!.id, 'uploading');
    env.store.transition(targets[0]!.id, 'published', { remoteId: 'OLD' });
    now = NOW;
    let calls = 0;
    assert.equal(await refreshDueStats(env.ctx, providerMap(), async () => void calls++, { everyMs: 6 * 3600_000 }), 0);
    assert.equal(calls, 0);
  });

  it('the worker records a reading per due target', async () => {
    const { ctx, store, ids, calls } = published([['GET', '/videos?part=statistics', () => json({ items: [{ statistics: { viewCount: '7' } }] })]]);
    const worker = new Worker({ ctx, providers: providerMap() });
    assert.equal(await worker.statsTick(), 1);
    assert.equal(store.statsHistory(ids[0]!).length, 1);
    assert.equal(await worker.statsTick(), 0, 'not due again until it is six hours old');
    assert.equal(calls.filter((c) => c.url.includes('part=statistics')).length, 1);
  });
});

describe('stats history, seventh review fixes', () => {
  it('platforms that are never read do not starve the queue', async () => {
    const { fetch } = mockFetch([]);
    const env = makeCtx(fetch, () => NOW);
    for (let i = 0; i < 60; i++) {
      const { targets } = env.store.createPost(POST, [{ platform: i % 2 ? 'tiktok' : 'x', account: 'main', options: {} }]);
      env.store.transition(targets[0]!.id, 'uploading');
      env.store.transition(targets[0]!.id, 'published', { remoteId: `N${i}` });
    }
    const { post, targets } = env.store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }]);
    env.store.transition(targets[0]!.id, 'uploading');
    env.store.transition(targets[0]!.id, 'published', { remoteId: 'Y' });
    const seen: string[] = [];
    // X charges for reads; a platform without stats (TikTok stands in) is never read either.
    const providers = providerMap();
    providers.set('tiktok', { ...providers.get('tiktok')!, stats: undefined });
    assert.equal(await refreshDueStats(env.ctx, providers, async (p, platform) => void seen.push(`${p}/${platform}`), { everyMs: 6 * 3600_000 }), 1);
    assert.deepEqual(seen, [`${post.id}/youtube`]);
  });

  it('a target with no connected account leaves the queue once read', async () => {
    const { fetch } = mockFetch([]);
    const env = makeCtx(fetch, () => NOW);
    const { post, targets } = env.store.createPost(POST, [{ platform: 'youtube', account: 'gone', options: {} }]);
    env.store.transition(targets[0]!.id, 'uploading');
    env.store.transition(targets[0]!.id, 'published', { remoteId: 'Y' });
    await refreshStats(env.ctx, providerMap(), post.id);
    assert.equal(env.store.statsDue(ago(24 * 30), ago(6), ['youtube']).length, 0);
  });

  it('the baseline may be days old', () => {
    const { store, ids } = published([]);
    store.recordStats(ids[0]!, { fetchedAt: ago(80), views: 10 });
    store.recordStats(ids[0]!, { fetchedAt: ago(1), views: 25 });
    assert.deepEqual(statsTrend(store, ids[0]!, NOW), { since: ago(80), views: 15 });
  });
});

describe('stats window', () => {
  it('follows a platform added recently to an old post', async () => {
    let now = new Date(NOW.getTime() - 46 * 86_400_000);
    const env = makeCtx(mockFetch([]).fetch, () => now);
    const { post } = env.store.createPost(POST, []);
    now = NOW;
    const [t] = env.store.addTargets(post.id, [{ platform: 'youtube', account: 'main', options: {} }]);
    env.store.transition(t!.id, 'uploading');
    env.store.transition(t!.id, 'published', { remoteId: 'NEW' });
    let calls = 0;
    assert.equal(await refreshDueStats(env.ctx, providerMap(), async () => void calls++, { everyMs: 6 * 3600_000 }), 1);
  });
});

describe('views series for the chart', () => {
  it('needs two readings, keeps the latest, and thins to the limit evenly', async () => {
    const { viewsSeries } = await import('../src/core/stats.ts');
    const now = new Date('2026-10-19T00:00:00Z');
    const env = makeCtx(undefined, () => now);
    const { targets } = env.store.createPost({ mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false }, [{ platform: 'youtube', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    const at = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
    env.store.recordStats(id, { fetchedAt: at(10), views: 5 });
    assert.equal(viewsSeries(env.store, id, now), undefined);
    for (let i = 0; i < 100; i++) env.store.recordStats(id, { fetchedAt: at(600 - i * 6), views: i * 10 });
    env.store.recordStats(id, { fetchedAt: at(1), likes: 3 }); // no views: left out
    const s = viewsSeries(env.store, id, now, 30, 24)!;
    assert.equal(s.length, 24);
    assert.equal(s.at(-1)!.views, 990, 'the latest reading with views');
    assert.ok(s.every((p, i) => i === 0 || Date.parse(p.at) > Date.parse(s[i - 1]!.at)), 'in time order');
  });
});
