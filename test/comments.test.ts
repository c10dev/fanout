import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchComments, withTimeout } from '../src/core/posting.ts';
import type { Account } from '../src/core/store.ts';
import type { PostInput, Target } from '../src/core/types.ts';
import { bluesky } from '../src/providers/bluesky.ts';
import { facebook } from '../src/providers/facebook.ts';
import { providerMap } from '../src/providers/index.ts';
import { instagram } from '../src/providers/instagram.ts';
import { htmlToText, mastodon } from '../src/providers/mastodon.ts';
import { youtube } from '../src/providers/youtube.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const target = (platform: string, remoteId: string): Target & { remoteId: string } => ({ id: 't', postId: 'p', platform, account: 'main', options: {}, state: 'published', warnings: [], attempts: 1, updatedAt: '', remoteId });
const acct = (platform: string, credentials: Record<string, unknown>): Account => ({ platform, name: 'main', credentials, profile: {} });

describe('provider comments', () => {
  it('YouTube: newest comment threads, and comments-off is just empty', async () => {
    let disabled = false;
    const { fetch, calls } = mockFetch([
      ['GET', '/commentThreads', () =>
        disabled
          ? json({ error: { code: 403, message: 'disabled', errors: [{ reason: 'commentsDisabled' }] } }, 403)
          : json({ items: [{ id: 'C1', snippet: { totalReplyCount: 2, topLevelComment: { snippet: { authorDisplayName: '팬', textOriginal: '좋아요!', publishedAt: '2026-10-17T01:00:00Z', likeCount: 3 } } } }] })],
    ]);
    const args = { ctx: makeCtx(fetch).ctx, account: acct('youtube', { accessToken: 'A' }), target: target('youtube', 'V'), limit: 20 };
    const [c] = await youtube.comments!(args);
    assert.deepEqual(c, { id: 'C1', author: '팬', text: '좋아요!', at: '2026-10-17T01:00:00Z', likes: 3, replies: 2, url: 'https://www.youtube.com/watch?v=V&lc=C1' });
    assert.match(calls[0]!.url, /order=time/);
    disabled = true;
    assert.deepEqual(await youtube.comments!(args), []);
  });

  it('Facebook and Instagram read comments with the page token', async () => {
    const fb = mockFetch([['GET', '/R/comments', () => json({ data: [{ id: 'c', message: 'hi', created_time: '2026-10-17T00:00:00+0000', like_count: 1, from: { name: 'Kim' } }] })]]);
    const e1 = makeCtx(fb.fetch);
    e1.store.setApp('meta', { appId: 'a', appSecret: 's' });
    const [f] = await facebook.comments!({ ctx: e1.ctx, account: acct('facebook', { pageToken: 'PT' }), target: target('facebook', 'R'), limit: 10 });
    assert.deepEqual([f!.author, f!.text, f!.likes], ['Kim', 'hi', 1]);
    assert.equal(new URL(fb.calls[0]!.url).searchParams.get('order'), 'reverse_chronological');
    const ig = mockFetch([['GET', '/M/comments', () => json({ data: [{ id: 'i', text: 'wow', username: 'fan', timestamp: '2026-10-17T00:00:00+0000', like_count: 2 }] })]]);
    const e2 = makeCtx(ig.fetch);
    e2.store.setApp('meta', { appId: 'a', appSecret: 's' });
    const [i] = await instagram.comments!({ ctx: e2.ctx, account: acct('instagram', { pageToken: 'PT' }), target: target('instagram', 'M'), limit: 10 });
    assert.deepEqual([i!.author, i!.text], ['@fan', 'wow']);
  });

  it('Bluesky reads direct replies from the public thread, newest first', async () => {
    const reply = (uri: string, at: string, text: string) => ({ post: { uri, author: { handle: 'a.bsky.social', displayName: 'A' }, record: { text, createdAt: at }, likeCount: 1, replyCount: 0 } });
    const { fetch, calls } = mockFetch([['GET', 'app.bsky.feed.getPostThread', () => json({ thread: { replies: [reply('at://d/app.bsky.feed.post/1', '2026-10-17T01:00:00Z', 'old'), reply('at://d/app.bsky.feed.post/2', '2026-10-17T02:00:00Z', 'new'), { notFound: true }] } })]]);
    const out = await bluesky.comments!({ ctx: makeCtx(fetch).ctx, account: acct('bluesky', {}), target: target('bluesky', 'at://me/app.bsky.feed.post/x'), limit: 10 });
    assert.deepEqual(out.map((c) => c.text), ['new', 'old']);
    assert.equal(out[0]!.url, 'https://bsky.app/profile/a.bsky.social/post/2');
    assert.equal(new URL(calls[0]!.url).searchParams.get('depth'), '1');
  });

  it('Mastodon keeps only direct replies and turns HTML into text', async () => {
    const { fetch } = mockFetch([['GET', '/api/v1/statuses/S/context', () => json({
      descendants: [
        { id: '1', in_reply_to_id: 'S', content: '<p>안녕 &amp; <b>반가워</b></p><p>둘째 줄</p>', created_at: '2026-10-17T01:00:00Z', favourites_count: 1, account: { acct: 'a@m', display_name: 'A' }, url: 'u1' },
        { id: '2', in_reply_to_id: '1', content: '<p>nested</p>', created_at: '2026-10-17T02:00:00Z', account: { acct: 'b' } },
      ],
    })]]);
    const out = await mastodon.comments!({ ctx: makeCtx(fetch).ctx, account: acct('mastodon', { instance: 'https://m.example', token: 'T' }), target: target('mastodon', 'S'), limit: 10 });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.text, '안녕 & 반가워\n\n둘째 줄');
    assert.equal(htmlToText('a<br>b &lt;3'), 'a\nb <3');
  });
});

describe('fetchComments', () => {
  it('reads published targets and explains the rest', async () => {
    const { fetch } = mockFetch([['GET', '/api/v1/statuses/S/context', () => json({ descendants: [] })], ['GET', '/2/tweets', () => json({})]]);
    const { ctx, store } = makeCtx(fetch);
    store.saveAccount({ platform: 'mastodon', name: 'main', credentials: { instance: 'https://m.example', token: 'T' }, profile: {} });
    const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };
    const { post, targets } = store.createPost(POST, [
      { platform: 'mastodon', account: 'main', options: {} },
      { platform: 'x', account: 'main', options: {} },
      { platform: 'youtube', account: 'main', options: {} },
    ]);
    for (const t of targets.slice(0, 2)) {
      store.transition(t.id, 'uploading');
      store.transition(t.id, 'published', { remoteId: 'S' });
    }
    const by = Object.fromEntries((await fetchComments(ctx, providerMap(), post.id)).map((r) => [r.platform, r]));
    assert.deepEqual(by.mastodon!.comments, []);
    assert.match(by.x!.skipped!, /아직 가져올 수 없습니다/);
    assert.match(by.youtube!.skipped!, /게시된 대상이 아닙니다/);
  });
});

describe('withTimeout', () => {
  it('aborts a request that never answers', async () => {
    const hanging = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const { ctx } = makeCtx(hanging);
    const t0 = Date.now();
    await assert.rejects(withTimeout(ctx, 50).fetch('https://never.example/'), (e: Error) => e.name === 'TimeoutError');
    assert.ok(Date.now() - t0 < 2000);
  });
});
