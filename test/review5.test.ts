import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { describe, it } from 'node:test';
import { cancelTarget, mayBeLive, MaybeLiveError, priorPosts, replyToComment } from '../src/core/posting.ts';
import { step, type RunnerDeps } from '../src/core/runner.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: 'd', tags: [], captions: [], containsSyntheticMedia: false, mediaHash: 'h1' };

describe('cancel never hides a post that may be live', () => {
  it('refuses a queued target whose upload got far, until the user confirms', () => {
    const { store } = makeCtx();
    const { targets } = store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    store.transition(id, 'uploading', { resume: { sessionUri: 'https://upload/s', size: 10 } });
    store.transition(id, 'queued');
    assert.match(mayBeLive(store.getTarget(id)!) ?? '', /sessionUri/);
    assert.throws(() => cancelTarget(store, id), MaybeLiveError);
    assert.equal(store.getTarget(id)!.state, 'queued');
    assert.equal(cancelTarget(store, id, { confirmedNotPosted: true }).state, 'canceled');
  });

  it('refuses a failed maybe_posted target', () => {
    const { store } = makeCtx();
    const { targets } = store.createPost(POST, [{ platform: 'x', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    store.transition(id, 'uploading');
    store.transition(id, 'failed', { errorCode: 'x.maybe_posted' });
    assert.throws(() => cancelTarget(store, id), /x\.maybe_posted/);
    assert.equal(priorPosts(store, 'h1', [{ platform: 'x', account: 'main', options: {} }]).size, 1, 'still counted as possibly posted');
  });

  it('cancels a plain queued target at once, and takes over a dead process lease', () => {
    const { store } = makeCtx();
    const { targets } = store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    assert.ok(store.claim(id, `${hostname()}:2147483646:gone`, 60_000));
    assert.equal(cancelTarget(store, id).state, 'canceled');
  });

  it('a cancel landing between the runner check and its claim is not an error', async () => {
    const { ctx, store } = makeCtx();
    const { targets } = store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    const claim = store.claim.bind(store);
    store.claim = (...args: Parameters<typeof store.claim>) => {
      store.claim = claim;
      cancelTarget(store, id);
      return claim(...args);
    };
    const deps: RunnerDeps = { ctx, providers: providerMap() };
    assert.equal((await step(deps, id)).state, 'canceled');
  });
});

describe('replies that never went out say so', () => {
  function mastodon(routes: Parameters<typeof mockFetch>[0]) {
    const { fetch, calls } = mockFetch(routes);
    const env = makeCtx(fetch);
    env.store.saveAccount({ platform: 'mastodon', name: 'main', credentials: { instance: 'https://m.example', token: 'T' }, profile: { accountId: 'me' } });
    const { targets } = env.store.createPost(POST, [{ platform: 'mastodon', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    env.store.transition(id, 'uploading');
    env.store.transition(id, 'published', { remoteId: 'S1' });
    return { ...env, calls, id };
  }
  const context = () => json({ descendants: [{ id: 'S2', in_reply_to_id: 'S1', content: 'hi', created_at: '2026-10-17T00:00:00Z', account: { acct: 'fan' } }] });

  it('a failed read before sending is not "may have posted"', async () => {
    const { ctx, calls, id } = mastodon([
      ['GET', '/api/v1/statuses/S1/context', context],
      ['GET', '/api/v1/statuses/S2', () => json({ error: 'busy' }, 503)],
    ]);
    await assert.rejects(replyToComment(ctx, providerMap(), id, 'S2', 'hi'), (err: Error) => !/이미 달렸을/.test(err.message));
    assert.ok(calls.every((c) => c.method === 'GET'));
  });

  it('Meta throttling is "not sent"', async () => {
    const { fetch } = mockFetch([
      ['GET', '/R1/comments', () => json({ data: [{ id: 'R1_9', message: 'hi', created_time: '2026-10-17T00:00:00Z' }] })],
      ['POST', '/R1_9/comments', () => json({ error: { code: 613, message: 'Calls to this api have exceeded the rate limit.' } }, 400)],
    ]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    store.saveAccount({ platform: 'facebook', name: 'main', credentials: { pageId: 'P1', pageToken: 'PT' }, profile: {} });
    const { targets } = store.createPost(POST, [{ platform: 'facebook', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    store.transition(id, 'uploading');
    store.transition(id, 'published', { remoteId: 'R1' });
    await assert.rejects(replyToComment(ctx, providerMap(), id, 'R1_9', 'hi'), (err: Error) => /요청 한도/.test(err.message) && !/이미 달렸을/.test(err.message));
  });
});
