import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchComments, hideComment, withTimeout } from '../src/core/posting.ts';
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

describe('hiding comments', () => {
  const NOW = new Date('2026-10-17T03:00:00Z');
  function setup(platform: 'youtube' | 'instagram' | 'facebook', routes: Parameters<typeof mockFetch>[0]) {
    const { fetch, calls } = mockFetch(routes);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('youtube', { clientId: 'c', clientSecret: 's' });
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    const credentials = platform === 'youtube' ? { accessToken: 'A', refreshToken: 'R', expiresAt: NOW.getTime() + 3600_000 } : { pageId: 'PAGE', pageToken: 'PT', igUserId: 'IG' };
    store.saveAccount({ platform, name: 'main', credentials, profile: {} });
    const input: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };
    const { targets } = store.createPost(input, [{ platform, account: 'main', options: {} }]);
    const id = targets[0]!.id;
    store.transition(id, 'uploading');
    store.transition(id, 'published', { remoteId: 'V' });
    return { ctx, calls, id };
  }

  it('YouTube holds a listed comment for review, and publishes it again', async () => {
    const { ctx, calls, id } = setup('youtube', [
      ['GET', '/commentThreads', () => json({ items: [{ id: 'C1', snippet: { topLevelComment: { id: 'C1', snippet: { authorDisplayName: 'x', textDisplay: 'spam', publishedAt: '2026-10-17T00:00:00Z' } } } }] })],
      ['POST', '/comments/setModerationStatus', () => new Response(null, { status: 204 })],
    ]);
    await hideComment(ctx, providerMap(), id, 'C1');
    const hide = new URL(calls.find((c) => c.url.includes('setModerationStatus'))!.url);
    assert.deepEqual([hide.searchParams.get('id'), hide.searchParams.get('moderationStatus')], ['C1', 'heldForReview']);
    await hideComment(ctx, providerMap(), id, 'C1', false);
    assert.equal(new URL(calls.filter((c) => c.url.includes('setModerationStatus'))[1]!.url).searchParams.get('moderationStatus'), 'published');
    // An id that isn't among the post's comments (e.g. from a prompt-injected agent) is refused.
    await assert.rejects(hideComment(ctx, providerMap(), id, 'ELSEWHERE'), /최근 댓글 중에/);
  });

  it('remembers what it hid on YouTube (held comments drop out of the list) and shows only those again', async () => {
    let held = false;
    const { ctx, calls, id } = setup('youtube', [
      ['GET', '/commentThreads', () => json({ items: held ? [] : [{ id: 'C1', snippet: { topLevelComment: { id: 'C1', snippet: { authorDisplayName: 'x', textDisplay: 'spam', publishedAt: '2026-10-17T00:00:00Z' } } } }] })],
      ['POST', '/comments/setModerationStatus', (c) => {
        held = new URL(c.url).searchParams.get('moderationStatus') === 'heldForReview';
        return new Response(null, { status: 204 });
      }],
    ]);
    const providers = providerMap();
    const postId = ctx.store.getTarget(id)!.postId;
    await hideComment(ctx, providers, id, 'C1');
    // Gone from YouTube's list, but still on the board, marked hidden, so it can be shown again.
    const [r] = await fetchComments(ctx, providers, postId);
    assert.deepEqual(r!.comments!.map((c) => [c.id, c.text, c.hidden]), [['C1', 'spam', true]]);
    // A comment YouTube itself held (spam filter) was never hidden by fanout: an agent can't publish it.
    await assert.rejects(hideComment(ctx, providers, id, 'SPAM', false), /fanout이 이 게시물에서 숨긴 댓글만/);
    assert.equal(calls.filter((c) => c.url.includes('setModerationStatus')).length, 1);
    await hideComment(ctx, providers, id, 'C1', false);
    const [again] = await fetchComments(ctx, providers, postId);
    assert.deepEqual(again!.comments!.map((c) => [c.id, c.hidden]), [['C1', false]]);
    assert.deepEqual((ctx.store.getTarget(id)!.resume as { hiddenComments: unknown[] }).hiddenComments, []);
  });

  it('reads Meta\'s own hidden flag, and a missing permission names it', async () => {
    for (const [platform, field, scope] of [['instagram', 'hidden', 'instagram_manage_comments'], ['facebook', 'is_hidden', 'pages_manage_engagement']] as const) {
      const { ctx, id } = setup(platform, [
        ['GET', '/V/comments', () => json({ data: [{ id: 'C1', text: 'a', message: 'a', timestamp: '2026-10-17T00:00:00+0000', created_time: '2026-10-17T00:00:00+0000', [field]: true }] })],
        ['POST', '/C1', () => json({ error: { message: '(#200) Requires permission', type: 'OAuthException', code: 200 } }, 403)],
      ]);
      const [r] = await fetchComments(ctx, providerMap(), ctx.store.getTarget(id)!.postId);
      assert.equal(r!.comments![0]!.hidden, true, platform);
      // Hidden by Meta's filters or another admin, not by fanout: not for an agent to show again.
      await assert.rejects(hideComment(ctx, providerMap(), id, 'C1', false), /fanout이 이 게시물에서 숨긴 댓글만/);
      // Hiding without the permission says which one is missing.
      await assert.rejects(hideComment(ctx, providerMap(), id, 'C1'), (e: Error) => e.message.includes(scope));
    }
  });

  it('a comment deleted since it was hidden leaves the hidden list', async () => {
    let gone = false;
    const { ctx, id } = setup('facebook', [
      ['GET', '/V/comments', () => json({ data: gone ? [] : [{ id: 'C1', message: 'spam', created_time: '2026-10-17T00:00:00+0000' }] })],
      ['POST', '/C1', () => (gone ? json({ error: { message: 'Unsupported post request. Object does not exist', type: 'GraphMethodException', code: 100, error_subcode: 33 } }, 400) : json({ success: true }))],
    ]);
    await hideComment(ctx, providerMap(), id, 'C1');
    gone = true;
    await assert.rejects(hideComment(ctx, providerMap(), id, 'C1', false), /더 이상 없습니다/);
    const [r] = await fetchComments(ctx, providerMap(), ctx.store.getTarget(id)!.postId);
    assert.deepEqual(r!.comments, []);
  });

  it('Instagram and Facebook hide with their own flags', async () => {
    for (const [platform, flag] of [['instagram', 'hide'], ['facebook', 'is_hidden']] as const) {
      const { ctx, calls, id } = setup(platform, [
        ['GET', '/V/comments', () => json({ data: [{ id: 'C1', text: 'spam', message: 'spam', username: 'u', from: { name: 'u' }, timestamp: '2026-10-17T00:00:00+0000', created_time: '2026-10-17T00:00:00+0000' }] })],
        ['POST', '/C1', () => json({ success: true })],
      ]);
      await hideComment(ctx, providerMap(), id, 'C1');
      const body = new URLSearchParams(String(calls.find((c) => c.method === 'POST')!.body));
      assert.equal(body.get(flag), 'true', platform);
    }
  });
});
