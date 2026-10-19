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
    assert.equal(f.maybePosted, undefined, 'a clear refusal created nothing');
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

  it('two workers (or two clicks) never post the same comment twice', async () => {
    let posts = 0;
    const slow = () => new Promise<Response>((r) => setTimeout(() => (posts++, r(json({ id: `TH${posts}` }))), 30));
    const { ctx, id, store } = published('youtube', yt, 'V1', [['POST', '/commentThreads?part=snippet', slow]]);
    await Promise.all([postDueFirstComments(ctx, providerMap()), postDueFirstComments(ctx, providerMap())]);
    assert.equal(posts, 1);
    store.setFollowup(id, { state: 'failed', at: '2026-10-17T03:00:00.000Z', error: 'x' });
    const results = await Promise.allSettled([retryFirstComment(ctx, providerMap(), id), retryFirstComment(ctx, providerMap(), id)]);
    assert.equal(posts, 2, 'one retry went through');
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  });

  it('counts from when the target went out or public, not when the post was made', async () => {
    // Scheduled natively ten days ahead: due once that time comes, though the post is older than a week.
    let clock = Date.parse('2026-10-17T03:00:00Z');
    const { fetch } = mockFetch([['POST', '/commentThreads?part=snippet', () => json({ id: 'TH' })]]);
    const env = makeCtx(fetch, () => new Date(clock));
    env.store.saveAccount({ platform: 'youtube', name: 'main', credentials: yt, profile: {} });
    const { targets } = env.store.createPost(POST({ scheduledAt: '2026-10-27T03:00:00.000Z' }), [{ platform: 'youtube', account: 'main', options: {} }]);
    env.store.transition(targets[0]!.id, 'uploading');
    env.store.transition(targets[0]!.id, 'published', { remoteId: 'V' });
    assert.equal(await postDueFirstComments(env.ctx, providerMap()), 0, 'still private');
    clock = Date.parse('2026-10-27T04:00:00Z');
    assert.equal(await postDueFirstComments(env.ctx, providerMap()), 1);
    // A target added to that (now old) post later, published today.
    clock = Date.parse('2026-11-20T00:00:00Z');
    const [added] = env.store.addTargets(targets[0]!.postId, [{ platform: 'youtube', account: 'main', options: {} }]);
    env.store.transition(added!.id, 'uploading');
    env.store.transition(added!.id, 'published', { remoteId: 'V2' });
    assert.equal(await postDueFirstComments(env.ctx, providerMap()), 1);
  });

  it('warns where it will not go or breaks the platform rules', () => {
    const providers = providerMap();
    assert.match(firstCommentWarnings(providers.get('tiktok')!, 'hi')[0]!, /건너뜁니다/);
    assert.deepEqual(firstCommentWarnings(providers.get('youtube')!, 'hi'), []);
    assert.deepEqual(firstCommentWarnings(providers.get('youtube')!, '  '), []);
    assert.match(firstCommentWarnings(providers.get('youtube')!, 'hi', { madeForKids: true })[0]!, /아동용/);
    const premium = { platform: 'x', name: 'main', credentials: { subscriptionType: 'Premium' }, profile: {} };
    assert.equal(firstCommentWarnings(providers.get('x')!, '한'.repeat(141), {}, premium as never).length, 1, 'Premium: only the cost');
    const ig = firstCommentWarnings(providers.get('instagram')!, `${'가'.repeat(301)} #a #b #c #d #e https://a.example https://b.example`);
    assert.equal(ig.length, 3);
  });
});

describe('first comment from the CLI', () => {
  it('fanout run posts a first comment that is due, without a dashboard or worker', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { openContext } = await import('../src/core/context.ts');
    const { main } = await import('../src/cli.ts');
    const home = mkdtempSync(join(tmpdir(), 'fanout-cli-fc-'));
    const prev = { home: process.env.FANOUT_HOME, fetch: globalThis.fetch };
    process.env.FANOUT_HOME = home;
    const ctx = openContext(home);
    ctx.store.saveAccount({ platform: 'youtube', name: 'main', credentials: yt, profile: {} });
    ctx.store.setApp('youtube', { clientId: 'c', clientSecret: 's' });
    const { targets } = ctx.store.createPost(POST(), [{ platform: 'youtube', account: 'main', options: {} }]);
    ctx.store.transition(targets[0]!.id, 'uploading');
    ctx.store.transition(targets[0]!.id, 'published', { remoteId: 'V1' });
    ctx.store.close();
    const sent: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      sent.push(String(url));
      return json({ id: 'TH1' });
    }) as typeof fetch;
    try {
      assert.equal(await main(['run']), 0);
    } finally {
      globalThis.fetch = prev.fetch;
      if (prev.home === undefined) delete process.env.FANOUT_HOME;
      else process.env.FANOUT_HOME = prev.home;
    }
    assert.ok(sent.some((u) => u.includes('/commentThreads')), sent.join('\n'));
    const after = openContext(home);
    assert.equal(after.store.getTarget(targets[0]!.id)!.followup!.state, 'posted');
    after.store.close();
  });
});
