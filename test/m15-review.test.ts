import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs } from '../src/cli.ts';
import { postDueFirstComments } from '../src/core/followup.ts';
import { mayBeDuplicate, removeTarget } from '../src/core/posting.ts';
import { step, type RunnerDeps } from '../src/core/runner.ts';
import type { Account } from '../src/core/store.ts';
import type { Post, Target } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { facebook } from '../src/providers/facebook.ts';
import { x } from '../src/providers/x.ts';
import { fakeMedia, json, makeCtx, mockFetch } from './helpers.ts';

const NOW = new Date('2026-10-19T03:00:00Z');
const post = (o: Partial<Post> = {}): Post => ({ id: 'p', createdAt: '', mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false, ...o });

describe('M15 review: no second post', () => {
  it('Facebook: a status check that fails after a lost finish never starts a second Reel', async () => {
    const account: Account = { platform: 'facebook', name: 'main', credentials: { pageId: 'PAGE', pageToken: 'PT' }, profile: {} };
    const target: Target = { id: 't', postId: 'p', platform: 'facebook', account: 'main', options: {}, state: 'uploading', warnings: [], attempts: 2, updatedAt: '', resume: { videoId: 'V1', finished: false } };
    for (const failing of [() => json({ error: { code: 2, message: 'Service temporarily unavailable' } }, 500), () => json({ error: { code: 4, message: 'rate limit' } }, 400)]) {
      const { fetch, calls } = mockFetch([
        ['GET', '/V1?', failing],
        ['POST', '/PAGE/video_reels', () => json({ video_id: 'V2', upload_url: 'https://rupload.facebook.com/video-upload/v24.0/V2' })],
      ]);
      const { ctx, store } = makeCtx(fetch, () => NOW);
      store.setApp('meta', { appId: 'a', appSecret: 's' });
      await assert.rejects(facebook.publish({ ctx, post: post(), target, account, mediaPath: '/v.mp4', media: fakeMedia(), saveResume: () => {} }));
      assert.equal(calls.filter((c) => c.url.includes('/video_reels')).length, 0, 'no new video started');
    }
  });

  it('Facebook: a definite "no such video" still starts over', async () => {
    const account: Account = { platform: 'facebook', name: 'main', credentials: { pageId: 'PAGE', pageToken: 'PT' }, profile: {} };
    const target: Target = { id: 't', postId: 'p', platform: 'facebook', account: 'main', options: {}, state: 'uploading', warnings: [], attempts: 2, updatedAt: '', resume: { videoId: 'V1', finished: false } };
    const { fetch, calls } = mockFetch([
      ['GET', '/V1?', () => json({ error: { code: 100, message: 'Unsupported get request' } }, 400)],
      ['POST', '/PAGE/video_reels', () => json({ error: { code: 1, message: 'stop here' } }, 400)],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    await assert.rejects(facebook.publish({ ctx, post: post(), target, account, mediaPath: '/v.mp4', media: fakeMedia(), saveResume: () => {} }));
    assert.equal(calls.filter((c) => c.url.includes('/video_reels')).length, 1, 'starts fresh');
  });

  it('X: a post request with no answer stays gated whatever the next poll hits', async () => {
    const xAccount = { platform: 'x', name: 'main', credentials: { accessToken: 'A', refreshToken: 'R', expiresAt: NOW.getTime() + 3_600_000, userId: 'U', username: 'me' }, profile: {} };
    const { fetch, calls } = mockFetch([['GET', '/2/media/upload?', () => json({ title: 'Payment Required', detail: 'credits' }, 402)]]);
    const env = makeCtx(fetch, () => NOW);
    env.store.setApp('x', { clientId: 'c' });
    env.store.saveAccount(xAccount);
    const { targets } = env.store.createPost(post(), [{ platform: 'x', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    env.store.transition(id, 'uploading');
    env.store.transition(id, 'processing', { remoteId: 'M1', resume: { mediaId: 'M1', finalized: true, posting: true } });
    const deps: RunnerDeps = { ctx: env.ctx, providers: new Map([['x', x]]), probe: async () => fakeMedia() };
    const t = await step(deps, id);
    assert.equal(t.state, 'failed');
    assert.equal(t.errorCode, 'x.maybe_posted', 'stopped before reading anything');
    assert.equal(calls.length, 0);
    assert.ok(mayBeDuplicate(t), 'the retry gate still holds it');
  });

  it('the runner keeps a posting marker when another error fails the poll', async () => {
    const fake = { ...x, poll: async () => { throw Object.assign(new (await import('../src/core/errors.ts')).ProviderError('rejected', 'fake.http_400', 'bad'), {}); } };
    const env = makeCtx(undefined, () => NOW);
    env.store.saveAccount({ platform: 'x', name: 'main', credentials: { accessToken: 'A', refreshToken: 'R', expiresAt: NOW.getTime() + 3_600_000 }, profile: {} });
    const { targets } = env.store.createPost(post(), [{ platform: 'x', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    env.store.transition(id, 'uploading');
    env.store.transition(id, 'processing', { remoteId: 'M1', resume: { mediaId: 'M1', posting: true } });
    const t = await step({ ctx: env.ctx, providers: new Map([['x', fake as never]]), probe: async () => fakeMedia() }, id);
    assert.equal(t.state, 'failed');
    assert.equal((t.resume as { posting?: boolean }).posting, true);
    assert.ok(mayBeDuplicate(t));
  });

  it('fanout retry: the confirmation flag never takes the platform as its value, and "no" means no', () => {
    const a = parseArgs(['retry', 'P', '--confirmed-not-posted', 'x']);
    assert.deepEqual(a.positionals, ['retry', 'P', 'x']);
    assert.equal(a.flags['confirmed-not-posted'], true);
    assert.equal(parseArgs(['retry', 'P', 'x', '--confirmed-not-posted=no']).flags['confirmed-not-posted'], 'no');
    assert.deepEqual(parseArgs(['post', 'v.mp4', '--title', 'hi']).flags, { title: 'hi' }, 'other flags still take values');
  });

  it('removing a post first takes its pending first comment, so the worker never posts a reply to it', async () => {
    const xAccount = { platform: 'x', name: 'main', credentials: { accessToken: 'A', refreshToken: 'R', expiresAt: NOW.getTime() + 3_600_000, userId: 'U', username: 'me' }, profile: {} };
    const { fetch, calls } = mockFetch([['DELETE', '/2/tweets/', () => json({ data: { deleted: true } })]]);
    const env = makeCtx(fetch, () => NOW);
    env.store.setApp('x', { clientId: 'c' });
    env.store.saveAccount(xAccount);
    const { targets } = env.store.createPost({ ...post(), firstComment: 'link' }, [{ platform: 'x', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    env.store.transition(id, 'uploading');
    env.store.transition(id, 'published', { remoteId: 'TW1' });
    await removeTarget(env.ctx, providerMap(), id);
    await postDueFirstComments(env.ctx, providerMap());
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'no reply posted');
    assert.equal(env.store.getTarget(id)!.followup?.state, 'failed');
  });
});
