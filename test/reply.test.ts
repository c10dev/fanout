import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { replyToComment } from '../src/core/posting.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: 'd', tags: [], captions: [], containsSyntheticMedia: false };

function published(
  platform: string,
  credentials: Record<string, unknown>,
  remote: { remoteId: string; remoteUrl?: string; resume?: Record<string, unknown> },
  routes: Parameters<typeof mockFetch>[0],
  opts: { profile?: Record<string, unknown>; options?: Record<string, unknown> } = {},
) {
  const { fetch, calls } = mockFetch(routes);
  const env = makeCtx(fetch);
  env.store.setApp('meta', { appId: 'a', appSecret: 's' });
  env.store.saveAccount({ platform, name: 'main', credentials, profile: opts.profile ?? {} });
  const { targets } = env.store.createPost(POST, [{ platform, account: 'main', options: opts.options ?? {} }]);
  const id = targets[0]!.id;
  env.store.transition(id, 'uploading');
  env.store.transition(id, 'published', remote);
  return { ...env, calls, id };
}

const yt = { accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3_600_000 };
const ytThreads = () =>
  json({ items: [{ id: 'C1', snippet: { totalReplyCount: 0, topLevelComment: { snippet: { authorDisplayName: 'fan', textDisplay: '좋아요', publishedAt: '2026-10-17T00:00:00Z' } } } }] });
const body = (c: { body?: unknown }) => JSON.parse(String(c.body)) as Record<string, any>;

describe('replying to comments', () => {
  it('YouTube: inserts a reply under the thread and links to it', async () => {
    const { ctx, calls, id } = published('youtube', yt, { remoteId: 'V1' }, [
      ['GET', '/commentThreads', ytThreads],
      ['POST', '/comments?part=snippet', () => json({ id: 'C1.r1' })],
    ]);
    const out = await replyToComment(ctx, providerMap(), id, 'C1', '  고마워요  ');
    assert.deepEqual(out, { id: 'C1.r1', url: 'https://www.youtube.com/watch?v=V1&lc=C1.r1' });
    assert.deepEqual(body(calls.at(-1)!), { snippet: { parentId: 'C1', textOriginal: '고마워요' } });
  });

  it('only answers comments that are on this post', async () => {
    const { ctx, calls, id } = published('youtube', yt, { remoteId: 'V1' }, [['GET', '/commentThreads', ytThreads]]);
    await assert.rejects(replyToComment(ctx, providerMap(), id, 'SOMEONE-ELSES', 'hi'), /최근 댓글 중에 그 댓글이 없습니다/);
    assert.ok(calls.every((c) => c.method === 'GET'));
  });

  it('refuses empty text, unpublished targets and platforms without replies', async () => {
    const { ctx, store, id } = published('youtube', yt, { remoteId: 'V1' }, []);
    await assert.rejects(replyToComment(ctx, providerMap(), id, 'C1', '   '), /내용을 입력/);
    const { targets } = store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }, { platform: 'x', account: 'main', options: {} }]);
    await assert.rejects(replyToComment(ctx, providerMap(), targets[0]!.id, 'C1', 'hi'), /게시된 대상의 댓글에만/);
    store.transition(targets[1]!.id, 'uploading');
    store.transition(targets[1]!.id, 'published', { remoteId: 'T1' });
    await assert.rejects(replyToComment(ctx, providerMap(), targets[1]!.id, 'C1', 'hi'), /답글을 달 수 없습니다/);
  });

  it('a lost response is reported as possibly posted, not retried', async () => {
    let posts = 0;
    const { ctx, id } = published('youtube', yt, { remoteId: 'V1' }, [
      ['GET', '/commentThreads', ytThreads],
      ['POST', '/comments?part=snippet', () => (posts++, json({ error: { message: 'backend' } }, 503))],
    ]);
    await assert.rejects(replyToComment(ctx, providerMap(), id, 'C1', 'hi'), /이미 달렸을 수 있으니/);
    assert.equal(posts, 1);
  });

  it('Facebook: a permission error names the scope to add', async () => {
    const { ctx, id } = published('facebook', { pageId: 'P1', pageToken: 'PT' }, { remoteId: 'R1' }, [
      ['GET', '/R1/comments', () => json({ data: [{ id: 'R1_9', message: 'hi', created_time: '2026-10-17T00:00:00Z' }] })],
      ['POST', '/R1_9/comments', () => json({ error: { code: 200, message: 'Permissions error' } }, 403)],
    ]);
    await assert.rejects(replyToComment(ctx, providerMap(), id, 'R1_9', '감사합니다'), /pages_manage_engagement/);
  });

  it('Instagram: replies through /replies', async () => {
    const { ctx, calls, id } = published('instagram', { pageId: 'P1', pageToken: 'PT', igUserId: 'IG' }, { remoteId: 'M1' }, [
      ['GET', '/M1/comments', () => json({ data: [{ id: 'IC1', text: 'wow', username: 'fan', timestamp: '2026-10-17T00:00:00Z' }] })],
      ['POST', '/IC1/replies', () => json({ id: 'IC1r' })],
    ]);
    assert.equal((await replyToComment(ctx, providerMap(), id, 'IC1', 'thanks')).id, 'IC1r');
    assert.match(String(calls.at(-1)!.body), /message=thanks/);
  });

  it('Mastodon: mentions the commenter, never widens visibility, sends an idempotency key', async () => {
    const md = { instance: 'https://m.example', token: 'T' };
    const { ctx, calls, id } = published(
      'mastodon',
      md,
      { remoteId: 'S1', resume: { instance: 'https://m.example', accountId: 'me' } },
      [
        ['GET', '/api/v1/statuses/S1/context', () => json({ descendants: [{ id: 'S2', in_reply_to_id: 'S1', content: '<p>hi</p>', created_at: '2026-10-17T00:00:00Z', account: { acct: 'fan@else.example' } }] })],
        ['GET', '/api/v1/statuses/S2', () => json({ id: 'S2', visibility: 'unlisted', account: { id: 'fan', acct: 'fan@else.example' } })],
        ['POST', '/api/v1/statuses', () => json({ id: 'S3', url: 'https://m.example/@me/S3' })],
      ],
      { profile: { accountId: 'me' }, options: { visibility: 'public' } },
    );
    const out = await replyToComment(ctx, providerMap(), id, 'S2', '고마워요');
    assert.equal(out.url, 'https://m.example/@me/S3');
    const sent = calls.at(-1)!;
    assert.deepEqual(body(sent), { status: '@fan@else.example 고마워요', in_reply_to_id: 'S2', visibility: 'unlisted' });
    assert.match(sent.headers['idempotency-key'] ?? '', /^fanout-reply-[0-9a-f]{32}$/);
  });

  it('Bluesky: names our post as root and the comment as parent', async () => {
    const jwt = `h.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url')}.s`;
    const ours = 'at://did:plc:me/app.bsky.feed.post/K1';
    const theirs = 'at://did:plc:fan/app.bsky.feed.post/R1';
    const { ctx, calls, id } = published('bluesky', { pds: 'https://pds.example', did: 'did:plc:me', handle: 'me.bsky.social', accessJwt: jwt, refreshJwt: 'r' }, { remoteId: ours }, [
      ['GET', 'app.bsky.feed.getPostThread', () => json({ thread: { replies: [{ post: { uri: theirs, author: { handle: 'fan' }, record: { text: 'hi', createdAt: '2026-10-17T00:00:00Z' } } }] } })],
      ['GET', 'app.bsky.feed.getPosts', () => json({ posts: [{ uri: theirs, cid: 'cidR', record: { reply: { root: { uri: ours, cid: 'cidK' }, parent: { uri: ours, cid: 'cidK' } } } }] })],
      ['POST', 'com.atproto.repo.createRecord', () => json({ uri: 'at://did:plc:me/app.bsky.feed.post/NEW', cid: 'x' })],
    ]);
    const out = await replyToComment(ctx, providerMap(), id, theirs, '고마워요');
    assert.equal(out.url, 'https://bsky.app/profile/me.bsky.social/post/NEW');
    assert.deepEqual(body(calls.at(-1)!).record.reply, { root: { uri: ours, cid: 'cidK' }, parent: { uri: theirs, cid: 'cidR' } });
  });
});
