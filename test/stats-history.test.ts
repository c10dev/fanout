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
    assert.equal(calls.length, 1);
  });
});
