import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { firstCommentWarnings, postDueFirstComments, retryFirstComment } from '../src/core/followup.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const POST = (extra: Partial<PostInput> = {}): PostInput => ({ mediaPath: '/v.mp4', title: 't', description: 'd', tags: [], captions: [], containsSyntheticMedia: false, firstComment: '링크는 프로필에 있어요', ...extra });
const yt = { accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3_600_000 };

function published(platform: string, credentials: Record<string, unknown>, remoteId: string, routes: Parameters<typeof mockFetch>[0], post: Partial<PostInput> = {}) {
  const { fetch, calls } = mockFetch(routes);
  const env = makeCtx(fetch);
  env.store.setApp('meta', { appId: 'a', appSecret: 's' });
  env.store.saveAccount({ platform, name: 'main', credentials, profile: {} });
  const { targets } = env.store.createPost(POST(post), [{ platform, account: 'main', options: {} }]);
  const id = targets[0]!.id;
  env.store.transition(id, 'uploading');
  env.store.transition(id, 'published', { remoteId });
  return { ...env, calls, id };
}

describe('first comment', () => {
  it('YouTube: a new thread on the video, once', async () => {
    const { ctx, calls, id, store } = published('youtube', yt, 'V1', [['POST', '/commentThreads?part=snippet', () => json({ id: 'TH1' })]]);
    assert.equal(await postDueFirstComments(ctx, providerMap()), 1);
    const f = store.getTarget(id)!.followup!;
    assert.deepEqual([f.state, f.id, f.url], ['posted', 'TH1', 'https://www.youtube.com/watch?v=V1&lc=TH1']);
    assert.deepEqual(JSON.parse(String(calls.at(-1)!.body)), { snippet: { videoId: 'V1', topLevelComment: { snippet: { textOriginal: '링크는 프로필에 있어요' } } } });
    assert.equal(await postDueFirstComments(ctx, providerMap()), 0, 'never twice');
    await assert.rejects(retryFirstComment(ctx, providerMap(), id), /이미 달렸습니다/);
  });

  it('Instagram and Facebook comment on the media / video as the account', async () => {
    const ig = published('instagram', { pageId: 'P1', pageToken: 'PT', igUserId: 'IG' }, 'M1', [['POST', '/M1/comments', () => json({ id: 'IC1' })]]);
    await postDueFirstComments(ig.ctx, providerMap());
    assert.equal(ig.store.getTarget(ig.id)!.followup!.state, 'posted');
    assert.match(String(ig.calls.at(-1)!.body), /PT/);
    const fb = published('facebook', { pageId: 'P1', pageToken: 'PT' }, 'R1', [['POST', '/R1/comments', () => json({ error: { code: 200, message: 'Permissions error' } }, 403)]]);
    await postDueFirstComments(fb.ctx, providerMap());
    const f = fb.store.getTarget(fb.id)!.followup!;
    assert.equal(f.state, 'failed');
    assert.match(f.error!, /pages_manage_engagement/);
    assert.equal(f.maybePosted, true, 'the request went out');
    assert.equal(fb.store.getTarget(fb.id)!.state, 'published', 'the post itself stays published');
  });

  it('after a failure that may have posted, a retry needs the user to say it did not', async () => {
    let calls = 0;
    const { ctx, id, store } = published('youtube', yt, 'V1', [
      ['POST', '/commentThreads?part=snippet', () => (++calls === 1 ? json({ error: { code: 500, message: 'backend' } }, 500) : json({ id: 'TH2' }))],
    ]);
    await postDueFirstComments(ctx, providerMap());
    assert.equal(store.getTarget(id)!.followup!.maybePosted, true);
    await assert.rejects(retryFirstComment(ctx, providerMap(), id), (err: Error & { needsConfirm?: boolean }) => err.needsConfirm === true);
    const f = await retryFirstComment(ctx, providerMap(), id, true);
    assert.deepEqual([f.state, f.id], ['posted', 'TH2']);
  });

  it('platforms without comments are marked, and a native schedule waits until it is public', async () => {
    const tt = published('tiktok', { accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3_600_000, openId: 'O' }, 'T1', []);
    await postDueFirstComments(tt.ctx, providerMap());
    assert.equal(tt.store.getTarget(tt.id)!.followup!.state, 'unsupported');
    assert.equal(tt.calls.length, 0);
    // makeCtx's clock is 2026-10-17T03:00Z; this one goes public a day later.
    const later = published('youtube', yt, 'V9', [], { scheduledAt: '2026-10-18T03:00:00.000Z' });
    assert.equal(await postDueFirstComments(later.ctx, providerMap()), 0);
    assert.equal(later.store.getTarget(later.id)!.followup, undefined);
  });

  it('X: a reply to the video post, with what it costs said up front', async () => {
    const x = { accessToken: 'A', refreshToken: 'R', expiresAt: Date.now() + 3_600_000, userId: 'U', username: 'me' };
    const { ctx, calls, id, store } = published('x', x, 'TW1', [['POST', '/2/tweets', () => json({ data: { id: 'TW2' } })]]);
    store.setApp('x', { clientId: 'c' });
    await postDueFirstComments(ctx, providerMap());
    const f = store.getTarget(id)!.followup!;
    assert.deepEqual([f.state, f.url], ['posted', 'https://x.com/me/status/TW2']);
    assert.deepEqual(JSON.parse(String(calls.at(-1)!.body)), { text: '링크는 프로필에 있어요', reply: { in_reply_to_tweet_id: 'TW1' } });
    const warn = firstCommentWarnings(providerMap().get('x')!, '한'.repeat(141));
    assert.equal(warn.length, 2, 'over 280 weighted (Korean counts double), and the cost');
  });

  it('warns where it will not go or breaks the platform rules', () => {
    const providers = providerMap();
    assert.match(firstCommentWarnings(providers.get('tiktok')!, 'hi')[0]!, /건너뜁니다/);
    assert.deepEqual(firstCommentWarnings(providers.get('youtube')!, 'hi'), []);
    assert.deepEqual(firstCommentWarnings(providers.get('youtube')!, '  '), []);
    const ig = firstCommentWarnings(providers.get('instagram')!, `${'가'.repeat(301)} #a #b #c #d #e https://a.example https://b.example`);
    assert.equal(ig.length, 3);
  });
});
