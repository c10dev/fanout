import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refreshStats } from '../src/core/posting.ts';
import type { Account } from '../src/core/store.ts';
import type { PostInput, Target } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { bluesky } from '../src/providers/bluesky.ts';
import { facebook } from '../src/providers/facebook.ts';
import { instagram } from '../src/providers/instagram.ts';
import { mastodon } from '../src/providers/mastodon.ts';
import { x } from '../src/providers/x.ts';
import { youtube } from '../src/providers/youtube.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const NOW = new Date('2026-10-17T03:00:00Z');
const target = (platform: string, remoteId: string): Target & { remoteId: string } => ({ id: 't', postId: 'p', platform, account: 'main', options: {}, state: 'published', warnings: [], attempts: 1, updatedAt: '', remoteId });
const acct = (platform: string, credentials: Record<string, unknown>): Account => ({ platform, name: 'main', credentials, profile: {} });

describe('provider stats', () => {
  it('YouTube reads statistics', async () => {
    const { fetch, calls } = mockFetch([['GET', '/videos?part=statistics&id=V', () => json({ items: [{ statistics: { viewCount: '1234', likeCount: '56', commentCount: '7' } }] })]]);
    const s = await youtube.stats!({ ctx: makeCtx(fetch).ctx, account: acct('youtube', { accessToken: 'A' }), target: target('youtube', 'V') });
    assert.deepEqual(s, { views: 1234, likes: 56, comments: 7 });
    assert.equal(calls[0]!.headers.authorization, 'Bearer A');
  });

  it('Instagram and Facebook read likes and comments with the page token', async () => {
    const ig = mockFetch([['GET', '/M?', () => json({ like_count: 10, comments_count: 2 })]]);
    const env = makeCtx(ig.fetch);
    env.store.setApp('meta', { appId: 'a', appSecret: 's' });
    const s1 = await instagram.stats!({ ctx: env.ctx, account: acct('instagram', { pageToken: 'PT', igUserId: 'IG' }), target: target('instagram', 'M') });
    assert.deepEqual([s1.likes, s1.comments], [10, 2]);
    const fb = mockFetch([['GET', '/R?', () => json({ likes: { summary: { total_count: 4 } }, comments: { summary: { total_count: 1 } } })]]);
    const env2 = makeCtx(fb.fetch);
    env2.store.setApp('meta', { appId: 'a', appSecret: 's' });
    const s2 = await facebook.stats!({ ctx: env2.ctx, account: acct('facebook', { pageToken: 'PT', pageId: 'P' }), target: target('facebook', 'R') });
    assert.deepEqual([s2.likes, s2.comments], [4, 1]);
    assert.match(new URL(fb.calls[0]!.url).searchParams.get('fields')!, /likes\.summary\(true\)/);
  });

  it('X reads public metrics and is marked as billed', async () => {
    assert.ok(x.statsCost);
    const { fetch } = mockFetch([['GET', '/2/tweets/T?tweet.fields=public_metrics', () => json({ data: { public_metrics: { impression_count: 900, like_count: 30, reply_count: 3, retweet_count: 4, quote_count: 1 } } })]]);
    const s = await x.stats!({ ctx: makeCtx(fetch).ctx, account: acct('x', { accessToken: 'A' }), target: target('x', 'T') });
    assert.deepEqual(s, { views: 900, likes: 30, comments: 3, shares: 5 });
  });

  it('Bluesky reads counts from the public AppView without auth', async () => {
    const { fetch, calls } = mockFetch([['GET', 'public.api.bsky.app/xrpc/app.bsky.feed.getPosts', () => json({ posts: [{ likeCount: 8, replyCount: 1, repostCount: 2, quoteCount: 1 }] })]]);
    const s = await bluesky.stats!({ ctx: makeCtx(fetch).ctx, account: acct('bluesky', {}), target: target('bluesky', 'at://did/app.bsky.feed.post/k') });
    assert.deepEqual([s.likes, s.comments, s.shares], [8, 1, 3]);
    assert.equal(calls[0]!.headers.authorization, undefined);
  });

  it('Mastodon reads status counters', async () => {
    const { fetch } = mockFetch([['GET', '/api/v1/statuses/S', () => json({ favourites_count: 5, replies_count: 2, reblogs_count: 1 })]]);
    const s = await mastodon.stats!({ ctx: makeCtx(fetch).ctx, account: acct('mastodon', { instance: 'https://m.example', token: 'T' }), target: target('mastodon', 'S') });
    assert.deepEqual([s.likes, s.comments, s.shares], [5, 2, 1]);
  });
});

describe('refreshStats', () => {
  const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };

  it('fetches published targets, skips the rest and paid platforms, and keeps the event log untouched', async () => {
    let fail = false;
    const { fetch } = mockFetch([
      ['GET', '/api/v1/statuses/S', () => (fail ? json({ error: 'boom' }, 500) : json({ favourites_count: 5, replies_count: 0, reblogs_count: 0 }))],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.saveAccount({ platform: 'mastodon', name: 'main', credentials: { instance: 'https://m.example', token: 'T' }, profile: {} });
    store.saveAccount({ platform: 'x', name: 'main', credentials: {}, profile: {} });
    const { post, targets } = store.createPost(POST, [
      { platform: 'mastodon', account: 'main', options: {} },
      { platform: 'x', account: 'main', options: {} },
      { platform: 'tiktok', account: 'main', options: {} },
    ]);
    const [md, xt, tt] = targets.map((t) => t.id) as [string, string, string];
    for (const [id, remote] of [[md, 'S'], [xt, 'T']] as const) {
      store.transition(id, 'uploading');
      store.transition(id, 'published', { remoteId: remote });
    }
    store.transition(tt, 'uploading');
    store.transition(tt, 'handed_off', { remoteId: 'pub' });
    const eventsBefore = store.events(md).length;

    const results = await refreshStats(ctx, providerMap(), post.id);
    const by = Object.fromEntries(results.map((r) => [r.platform, r]));
    assert.equal(by.mastodon!.stats!.likes, 5);
    assert.match(by.x!.skipped!, /요금/);
    assert.match(by.tiktok!.skipped!, /앱에서 마무리/);
    assert.equal(store.getTarget(md)!.stats!.likes, 5);
    assert.equal(store.events(md).length, eventsBefore);

    fail = true;
    const again = await refreshStats(ctx, providerMap(), post.id, { platform: 'mastodon' });
    assert.equal(again[0]!.stats!.likes, 5, 'keeps the last good numbers');
    assert.match(again[0]!.stats!.note!, /가져오지 못함/);
  });
});
