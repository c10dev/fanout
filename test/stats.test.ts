import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refreshStats } from '../src/core/posting.ts';
import { refreshDueStats } from '../src/core/stats.ts';
import { flushNotifications } from '../src/core/notify.ts';
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
    // A token known to lack the Analytics scope: views/likes/comments only, and no Analytics call.
    const s = await youtube.stats!({ ctx: makeCtx(fetch).ctx, account: acct('youtube', { accessToken: 'A', scope: 'https://www.googleapis.com/auth/youtube.force-ssl' }), target: target('youtube', 'V') });
    assert.deepEqual({ ...s, note: undefined }, { views: 1234, likes: 56, comments: 7, note: undefined });
    assert.match(s.note!, /yt-analytics\.readonly/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers.authorization, 'Bearer A');
  });

  describe('YouTube Analytics', () => {
    const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly';
    const statistics: Parameters<typeof mockFetch>[0][number] = ['GET', '/videos?part=statistics&id=V', () => json({ items: [{ statistics: { viewCount: '1234' } }] })];
    const read = async (report: () => Response, prev?: Target['stats']) => {
      const { fetch, calls } = mockFetch([statistics, ['GET', 'youtubeanalytics.googleapis.com/v2/reports', report]]);
      const s = await youtube.stats!({ ctx: makeCtx(fetch, () => NOW).ctx, account: acct('youtube', { accessToken: 'A', scope: SCOPE }), target: { ...target('youtube', 'V'), stats: prev } });
      return { s, calls };
    };

    it('adds watch time, average view duration and %, and subscribers gained for the video', async () => {
      const { s, calls } = await read(() =>
        json({
          columnHeaders: [{ name: 'estimatedMinutesWatched' }, { name: 'averageViewDuration' }, { name: 'averageViewPercentage' }, { name: 'subscribersGained' }],
          rows: [[90, 42, 61.27, 3]],
        }),
      );
      assert.deepEqual(s, { views: 1234, watchTimeSec: 5400, avgWatchSec: 42, avgViewPct: 61.3, subscribersGained: 3 });
      const q = new URL(calls[1]!.url).searchParams;
      assert.deepEqual([q.get('ids'), q.get('filters'), q.get('endDate')], ['channel==MINE', 'video==V', '2026-10-16']);
      assert.equal(q.get('metrics'), 'estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained');
    });

    it('says when there is nothing yet, or the API is not enabled', async () => {
      assert.match((await read(() => json({ columnHeaders: [] }))).s.note!, /하루 이틀/);
      const off = await read(() => json({ error: { code: 403, message: 'not enabled', errors: [{ reason: 'accessNotConfigured' }] } }, 403));
      assert.match(off.s.note!, /YouTube Analytics API를 사용 설정/);
      assert.equal(off.s.views, 1234, 'the basic numbers are still there');
    });

    it('names the real problem, and keeps the last numbers whatever it is', async () => {
      const prev = { fetchedAt: '', watchTimeSec: 600, avgWatchSec: 30 };
      const err = (reason: string, message = 'denied') => () => json({ error: { code: 403, message, errors: [{ reason }] } }, 403);
      const granted = await read(err('insufficientPermissions'), prev);
      assert.match(granted.s.note!, /권한이 있는데도/, 'reconnecting would not help: the scope is there');
      assert.equal(granted.s.watchTimeSec, 600);
      assert.match((await read(err('forbidden'))).s.note!, /이 채널의 분석 데이터/);
      assert.match((await read(err('PERMISSION_DENIED', 'YouTube Analytics API has not been used in project 1 before or it is disabled'))).s.note!, /사용 설정/);
      assert.equal((await read(() => json({ columnHeaders: [] }), prev)).s.avgWatchSec, 30, 'no rows yet: keep');
    });

    it('keeps the last analytics on a passing failure', async () => {
      const prev = { fetchedAt: '', watchTimeSec: 600, avgWatchSec: 30, avgViewPct: 50, subscribersGained: 1 };
      const { s } = await read(() => json({ error: { code: 500, message: 'backend' } }, 500), prev);
      assert.deepEqual([s.watchTimeSec, s.avgWatchSec, s.avgViewPct, s.subscribersGained, s.views], [600, 30, 50, 1, 1234]);
      assert.match(s.note!, /지난 값/);
    });
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

  it('Instagram and Facebook add views from insights when the token allows it', async () => {
    const ig = mockFetch([
      ['GET', '/M/insights', () => json({ data: [{ name: 'views', period: 'lifetime', values: [{ value: 321 }] }, { name: 'shares', period: 'lifetime', values: [{ value: 5 }] }] })],
      ['GET', '/M?', () => json({ like_count: 10, comments_count: 2 })],
    ]);
    const env = makeCtx(ig.fetch);
    env.store.setApp('meta', { appId: 'a', appSecret: 's' });
    assert.deepEqual(await instagram.stats!({ ctx: env.ctx, account: acct('instagram', { pageToken: 'PT' }), target: target('instagram', 'M') }), { views: 321, likes: 10, comments: 2, shares: 5 });
    assert.equal(new URL(ig.calls.find((c) => c.url.includes('/insights'))!.url).searchParams.get('metric'), 'views,shares');

    const fb = mockFetch([
      ['GET', '/R/video_insights', () => json({ data: [{ name: 'fb_reels_total_plays', period: 'lifetime', values: [{ value: 900 }] }] })],
      ['GET', '/R?', () => json({ likes: { summary: { total_count: 4 } }, comments: { summary: { total_count: 1 } } })],
    ]);
    const env2 = makeCtx(fb.fetch);
    env2.store.setApp('meta', { appId: 'a', appSecret: 's' });
    assert.deepEqual(await facebook.stats!({ ctx: env2.ctx, account: acct('facebook', { pageToken: 'PT' }), target: target('facebook', 'R') }), { views: 900, likes: 4, comments: 1 });
  });

  it('adds reach, saves and watch time from a second insights call, and survives it failing', async () => {
    const row = (name: string, value: number) => ({ name, period: 'lifetime', values: [{ value }] });
    const ig = mockFetch([
      [
        'GET',
        '/M/insights',
        (c) =>
          new URL(c.url).searchParams.get('metric') === 'views,shares'
            ? json({ data: [row('views', 321), row('shares', 5)] })
            : json({ data: [row('reach', 250), row('saved', 12), row('ig_reels_avg_watch_time', 4321), row('ig_reels_video_view_total_time', 1_387_000)] }),
      ],
      ['GET', '/M?', () => json({ like_count: 10, comments_count: 2 })],
    ]);
    const env = makeCtx(ig.fetch);
    env.store.setApp('meta', { appId: 'a', appSecret: 's' });
    assert.deepEqual(await instagram.stats!({ ctx: env.ctx, account: acct('instagram', { pageToken: 'PT' }), target: target('instagram', 'M') }), {
      views: 321, likes: 10, comments: 2, shares: 5, reach: 250, saves: 12, avgWatchSec: 4.3, watchTimeSec: 1387,
    });

    // A metric this reel doesn't have fails only the deeper call: plays, likes and comments stay.
    const fb = mockFetch([
      [
        'GET',
        '/R/video_insights',
        (c) =>
          new URL(c.url).searchParams.get('metric') === 'fb_reels_total_plays'
            ? json({ data: [row('fb_reels_total_plays', 900)] })
            : json({ error: { code: 100, message: '(#100) The value must be a valid insights metric' } }, 400),
      ],
      ['GET', '/R?', () => json({ likes: { summary: { total_count: 4 } }, comments: { summary: { total_count: 1 } } })],
    ]);
    const env2 = makeCtx(fb.fetch);
    env2.store.setApp('meta', { appId: 'a', appSecret: 's' });
    assert.deepEqual(await facebook.stats!({ ctx: env2.ctx, account: acct('facebook', { pageToken: 'PT' }), target: target('facebook', 'R') }), { views: 900, likes: 4, comments: 1 });
  });

  it('a passing failure of the second insights call keeps the last reach and saves', async () => {
    const row = (name: string, value: number) => ({ name, period: 'lifetime', values: [{ value }] });
    const ig = mockFetch([
      ['GET', '/M/insights', (c) => (new URL(c.url).searchParams.get('metric') === 'views,shares' ? json({ data: [row('views', 400), row('shares', 6)] }) : json({ error: { code: 4, message: '(#4) Application request limit reached' } }, 400))],
      ['GET', '/M?', () => json({ like_count: 11, comments_count: 3 })],
    ]);
    const env = makeCtx(ig.fetch);
    env.store.setApp('meta', { appId: 'a', appSecret: 's' });
    const before = { ...target('instagram', 'M'), stats: { views: 321, reach: 250, saves: 12, avgWatchSec: 4.3, fetchedAt: '2026-10-17T00:00:00Z' } };
    const s = await instagram.stats!({ ctx: env.ctx, account: acct('instagram', { pageToken: 'PT' }), target: before });
    assert.deepEqual([s.views, s.reach, s.saves, s.avgWatchSec], [400, 250, 12, 4.3]);
  });

  it('without the insights permission, likes and comments still come back with a note', async () => {
    const ig = mockFetch([
      ['GET', '/M/insights', () => json({ error: { code: 10, message: '(#10) Application does not have permission for this action' } }, 403)],
      ['GET', '/M?', () => json({ like_count: 10, comments_count: 2 })],
    ]);
    const env = makeCtx(ig.fetch);
    env.store.setApp('meta', { appId: 'a', appSecret: 's' });
    const s = await instagram.stats!({ ctx: env.ctx, account: acct('instagram', { pageToken: 'PT' }), target: target('instagram', 'M') });
    assert.deepEqual([s.views, s.likes, s.comments], [undefined, 10, 2]);
    assert.match(s.note ?? '', /instagram_manage_insights/);
  });

  it('a rate-limited insights read keeps the last views', async () => {
    const ig = mockFetch([
      ['GET', '/M/insights', () => json({ error: { code: 4, message: 'Application request limit reached' } }, 400)],
      ['GET', '/M?', () => json({ like_count: 11, comments_count: 2 })],
    ]);
    const env = makeCtx(ig.fetch);
    env.store.setApp('meta', { appId: 'a', appSecret: 's' });
    const before = { ...target('instagram', 'M'), stats: { views: 321, shares: 5, likes: 10, fetchedAt: '2026-10-16T00:00:00Z' } };
    const s = await instagram.stats!({ ctx: env.ctx, account: acct('instagram', { pageToken: 'PT' }), target: before });
    assert.deepEqual([s.views, s.shares, s.likes], [321, 5, 11]);
  });

  it('a metric the media does not have drops the views instead of keeping stale ones', async () => {
    const ig = mockFetch([
      ['GET', '/M/insights', () => json({ error: { code: 100, message: 'The Media Insights API does not support the views metric for this media' } }, 400)],
      ['GET', '/M?', () => json({ like_count: 11, comments_count: 2 })],
    ]);
    const env = makeCtx(ig.fetch);
    env.store.setApp('meta', { appId: 'a', appSecret: 's' });
    const before = { ...target('instagram', 'M'), stats: { views: 321, fetchedAt: '2026-10-16T00:00:00Z' } };
    assert.equal((await instagram.stats!({ ctx: env.ctx, account: acct('instagram', { pageToken: 'PT' }), target: before })).views, undefined);
  });

  it('a timed-out insights read keeps the last views', async () => {
    const ig = mockFetch([
      [
        'GET',
        '/M/insights',
        () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
      ],
      ['GET', '/M?', () => json({ like_count: 11, comments_count: 2 })],
    ]);
    const env = makeCtx(ig.fetch);
    env.store.setApp('meta', { appId: 'a', appSecret: 's' });
    const before = { ...target('instagram', 'M'), stats: { views: 321, shares: 5, fetchedAt: '2026-10-16T00:00:00Z' } };
    assert.equal((await instagram.stats!({ ctx: env.ctx, account: acct('instagram', { pageToken: 'PT' }), target: before })).views, 321);
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
    assert.match(by.tiktok!.skipped!, /연결된 계정이 없습니다/, 'a hand-off is looked for, but needs the account');
    assert.equal(store.getTarget(md)!.stats!.likes, 5);
    assert.equal(store.events(md).length, eventsBefore);

    fail = true;
    const again = await refreshStats(ctx, providerMap(), post.id, { platform: 'mastodon' });
    assert.equal(again[0]!.stats!.likes, 5, 'keeps the last good numbers');
    assert.match(again[0]!.stats!.note!, /가져오지 못함/);
  });
});

describe('finding a TikTok post finished in the app', () => {
  const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };
  const T0 = Date.parse('2026-10-17T03:00:00Z');
  const video = (id: string, at: number, duration = 30) => ({ id, create_time: Math.floor(at / 1000), duration, share_url: `https://www.tiktok.com/@c10e2/video/${id}?is_from_webapp=1` });
  type Status = { status: string; publicaly_available_post_id?: string[] } | 'gone';
  function setup(opts: { status?: () => Status; pages?: () => Array<{ videos: unknown[]; has_more?: boolean; cursor?: number }>; now?: number; durations?: number[] } = {}) {
    let clock = T0;
    const status = opts.status ?? (() => 'gone' as Status);
    const { fetch, calls } = mockFetch([
      // Raw text so a 19-digit id arrives as a JSON number, as TikTok sends it.
      ['POST', '/v2/post/publish/status/fetch/', () => {
        const st = status();
        if (st === 'gone') return json({ error: { code: 'invalid_params', message: 'publish id not found' } }, 400);
        const ids = (st.publicaly_available_post_id ?? []).join(',');
        return new Response(`{"data":{"status":"${st.status}","publicaly_available_post_id":[${ids}]},"error":{"code":"ok"}}`);
      }],
      ['POST', '/v2/video/list/', (c) => {
        const pages = (opts.pages ?? (() => [{ videos: [] }]))();
        const cursor = JSON.parse(String(c.body)).cursor;
        const page: { videos: unknown[]; has_more?: boolean; cursor?: number } = pages[cursor === undefined ? 0 : Number(cursor)] ?? { videos: [] };
        return json({ data: { videos: page.videos, has_more: page.has_more ?? false, cursor: page.cursor }, error: { code: 'ok' } });
      }],
      ['POST', '/v2/video/query/', (c) => {
        const id = JSON.parse(String(c.body)).filters.video_ids[0];
        return json({ data: { videos: [{ id, share_url: `https://www.tiktok.com/@c10e2/video/${id}`, view_count: 10, like_count: 2, comment_count: 1, share_count: 0 }] }, error: { code: 'ok' } });
      }],
    ]);
    const env = makeCtx(fetch, () => new Date(clock));
    env.store.saveAccount({ platform: 'tiktok', name: 'main', credentials: { accessToken: 'A', refreshToken: 'R', expiresAt: T0 + 1e10, refreshExpiresAt: T0 + 1e11, openId: 'o', scope: 'user.info.basic,video.upload,video.list' }, profile: {} });
    const ids: string[] = [];
    let post!: { id: string };
    for (const [n, d] of (opts.durations ?? [30.4]).entries()) {
      const created = env.store.createPost(POST, [{ platform: 'tiktok', account: 'main', options: {} }]);
      if (n === 0) post = created.post;
      const id = created.targets[0]!.id;
      env.store.transition(id, 'uploading', { resume: { publishId: `v_inbox_file~${n}`, durationSec: d } });
      // fanout notices the hand-off a while after the upload (the worker was busy).
      clock = T0 + 20 * 60_000;
      env.store.transition(id, 'handed_off', { remoteId: `v_inbox_file~${n}` });
      clock = T0;
      ids.push(id);
    }
    clock = opts.now ?? T0 + 3600_000;
    return { ...env, calls, post, id: ids[0]!, ids };
  }

  it('links exactly the post the draft became, from its own status (19 digits intact)', async () => {
    // Two hand-offs of the same length: the status still names the right one.
    const { ctx, store, post, id, calls } = setup({ status: () => ({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7412345678901234567'] }), durations: [30, 30] });
    const [r] = await refreshStats(ctx, providerMap(), post.id);
    const t = store.getTarget(id)!;
    assert.deepEqual([t.state, t.remoteId, t.remoteUrl], ['published', '7412345678901234567', 'https://www.tiktok.com/@c10e2/video/7412345678901234567']);
    assert.equal(r!.stats!.views, 10);
    assert.ok(!calls.some((c) => c.url.includes('/video/list/')), 'no guessing from the list');
  });

  it('waits while the draft is still in the inbox, and refuses a draft that made several posts', async () => {
    const inbox = setup({ status: () => ({ status: 'SEND_TO_USER_INBOX' }), pages: () => [{ videos: [video('7400000000000000002', T0 + 60_000)] }] });
    const [r] = await refreshStats(inbox.ctx, providerMap(), inbox.post.id);
    assert.match(r!.skipped!, /수신함/);
    assert.equal(inbox.store.getTarget(inbox.id)!.state, 'handed_off');
    assert.ok(!inbox.calls.some((c) => c.url.includes('/video/list/')));
    const many = setup({ status: () => ({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7400000000000000002', '7400000000000000003'] }) });
    assert.match((await refreshStats(many.ctx, providerMap(), many.post.id))[0]!.skipped!, /2개 만들어져/);
  });

  it('falls back to the video list only when the status is gone, and only without a same-length twin', async () => {
    // Posted 5 minutes after the upload, i.e. before fanout noticed the hand-off: still found.
    const one = setup({ pages: () => [{ videos: [video('7400000000000000002', T0 + 5 * 60_000), video('7400000000000000001', T0 - 86_400_000)] }] });
    await refreshStats(one.ctx, providerMap(), one.post.id);
    assert.equal(one.store.getTarget(one.id)!.remoteId, '7400000000000000002');

    const twins = setup({ durations: [30, 30.8], pages: () => [{ videos: [video('7400000000000000002', T0 + 60_000)] }] });
    assert.match((await refreshStats(twins.ctx, providerMap(), twins.post.id))[0]!.skipped!, /같은 길이/);
    assert.equal(twins.store.getTarget(twins.id)!.state, 'handed_off');
  });

  it('pages through the list until it is past the upload', async () => {
    const newer = Array.from({ length: 20 }, (_, i) => video(`75000000000000000${String(i).padStart(2, '0')}`, T0 + 7200_000 - i * 1000, 12));
    const { ctx, store, post, id, calls } = setup({
      now: T0 + 3 * 3600_000,
      pages: () => [{ videos: newer, has_more: true, cursor: 1 }, { videos: [video('7400000000000000002', T0 + 60_000), video('7400000000000000001', T0 - 86_400_000)], has_more: true, cursor: 2 }],
    });
    await refreshStats(ctx, providerMap(), post.id);
    assert.equal(store.getTarget(id)!.remoteId, '7400000000000000002');
    assert.equal(calls.filter((c) => c.url.includes('/video/list/')).length, 2, 'stops once past the upload');
  });

  it('stops looking after two weeks, and the background refresh includes hand-offs', async () => {
    const old = setup({ now: T0 + 15 * 86_400_000 });
    const [r] = await refreshStats(old.ctx, providerMap(), old.post.id);
    assert.match(r!.skipped!, /14일/);
    assert.equal(old.calls.length, 0);

    const fresh = setup();
    const seen: string[] = [];
    await refreshDueStats(fresh.ctx, providerMap(), async (p, platform) => void seen.push(`${p}/${platform}`), { everyMs: 6 * 3600_000 });
    assert.deepEqual(seen, [`${fresh.post.id}/tiktok`]);
  });
});

describe('Meta copyright check after publish', () => {
  const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };
  const blocked = {
    copyright_check_information: {
      status: { status: 'complete', matches_found: true },
      copyright_matches: [{ content_title: 'Ditto', owner_copyright_policy: { name: 'Label', actions: [{ action: 'TRACK' }, { action: 'BLOCK', geos: ['South Korea', 'Japan'] }, { action: 'MUTE' }] } }],
    },
  };
  it('turns a block or mute into the target\'s warnings once, then stops asking', async () => {
    let info: unknown = { copyright_check_information: { status: { status: 'in_progress' } } };
    const { fetch, calls } = mockFetch([
      ['GET', 'copyright_check_information', () => json(info)],
      ['GET', '/R?', () => json({ likes: { summary: { total_count: 4 } }, comments: { summary: { total_count: 1 } } })],
      ['POST', 'hooks.example', () => json({})],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    store.setApp('notify', { url: 'https://hooks.example/x' });
    store.saveAccount({ platform: 'facebook', name: 'main', credentials: { pageToken: 'PT', pageId: 'P' }, profile: {} });
    const { post, targets } = store.createPost(POST, [{ platform: 'facebook', account: 'main', options: {} }]);
    store.transition(targets[0]!.id, 'uploading');
    store.transition(targets[0]!.id, 'published', { remoteId: 'R' });
    const read = async () => (await refreshStats(ctx, providerMap(), post.id))[0]!.stats!;
    assert.equal((await read()).copyright, undefined, 'still checking');
    info = blocked;
    const s = await read();
    assert.equal(s.copyright, 'matched');
    assert.deepEqual(store.getTarget(targets[0]!.id)!.warnings, ['저작권 일치 "Ditto": 차단 (South Korea, Japan)', '저작권 일치 "Ditto": 음소거 (모든 지역)']);
    const before = calls.filter((c) => c.url.includes('copyright_check_information')).length;
    await read();
    assert.equal(calls.filter((c) => c.url.includes('copyright_check_information')).length, before, 'finished: not asked again');
    assert.equal(store.getTarget(targets[0]!.id)!.warnings.length, 2, 'not repeated');
    await flushNotifications();
    const hooks = calls.filter((c) => c.url.includes('hooks.example')).map((c) => JSON.parse(String(c.body)));
    assert.deepEqual(hooks.map((h) => h.event), ['alert', 'alert'], 'one notification per alert, once');
  });

  it('a clear check and an unreadable field cost nothing', async () => {
    for (const reply of [() => json({ copyright_check_information: { status: { status: 'completed', matches_found: false } } }), () => json({ error: { message: 'nonexisting field', code: 100 } }, 400)]) {
      const { fetch } = mockFetch([
        ['GET', 'copyright_check_information', reply],
        ['GET', '/M?', () => json({ like_count: 10, comments_count: 2 })],
      ]);
      const env = makeCtx(fetch);
      env.store.setApp('meta', { appId: 'a', appSecret: 's' });
      const s = await instagram.stats!({ ctx: env.ctx, account: acct('instagram', { pageToken: 'PT', igUserId: 'IG' }), target: target('instagram', 'M') });
      assert.deepEqual([s.likes, s.alerts], [10, undefined]);
    }
  });
});
