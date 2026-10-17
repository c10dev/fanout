import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import type { Account } from '../src/core/store.ts';
import type { Post, Target } from '../src/core/types.ts';
import { retryTarget } from '../src/core/posting.ts';
import { SEGMENT, tweetText, weightedLength, x } from '../src/providers/x.ts';
import { fakeMedia, json, makeCtx, mockFetch, tempFile } from './helpers.ts';

const NOW = new Date('2026-10-17T03:00:00Z');
const account: Account = {
  platform: 'x',
  name: 'main',
  credentials: { accessToken: 'AT', refreshToken: 'RT', expiresAt: NOW.getTime() + 3600_000, userId: '1', username: 'me' },
  profile: {},
};
const post = (o: Partial<Post> = {}): Post => ({ id: 'p', createdAt: '', mediaPath: '/v.mp4', title: '영상', description: '설명', tags: ['fanout'], captions: [], containsSyntheticMedia: false, ...o });
const target = (options: Record<string, unknown> = {}, resume?: Record<string, unknown>): Target => ({ id: 't', postId: 'p', platform: 'x', account: 'main', options, state: 'uploading', warnings: [], attempts: 1, updatedAt: '', resume });

describe('x text', () => {
  it('weighs Hangul double and URLs as 23', () => {
    assert.equal(weightedLength('abc'), 3);
    assert.equal(weightedLength('한글'), 4);
    assert.equal(weightedLength('see https://example.com/a/very/long/path'), 4 + 23);
  });

  it('drops the description when over 280', () => {
    assert.equal(tweetText(post({ description: '가'.repeat(150) }), {}), '영상\n\n#fanout');
  });

  it('warns about length and URL pricing', () => {
    const codes = x.validate(post({ description: 'https://x.dev' }), target({ text: '가'.repeat(141) + ' https://x.dev' }), fakeMedia()).map((i) => i.code);
    assert.ok(codes.includes('text') && codes.includes('url_cost'));
  });
});

describe('x auth', () => {
  it('uses Basic auth for confidential clients and client_id for public ones', async () => {
    for (const [cfg, expectBasic] of [[{ clientId: 'cid', clientSecret: 'sec' }, true], [{ clientId: 'cid' }, false]] as const) {
      const { fetch, calls } = mockFetch([
        ['POST', '/2/oauth2/token', () => json({ access_token: 'A', refresh_token: 'R', expires_in: 7200 })],
        ['GET', '/2/users/me', () => json({ data: { id: '9', username: 'me', name: 'Me' } })],
      ]);
      const { ctx, store } = makeCtx(fetch, () => NOW);
      store.setApp('x', cfg);
      const start = x.oauthBegin!(ctx, 'http://127.0.0.1:8780/oauth/x/callback');
      const u = new URL(start.url);
      assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(u.searchParams.get('scope')!.includes('media.write'));
      const acct = await x.oauthFinish!(ctx, 'main', new URLSearchParams({ code: 'C', state: start.state }), 'http://127.0.0.1:8780/oauth/x/callback', start.verifier);
      assert.equal((acct.credentials as { username: string }).username, 'me');
      const tok = calls[0]!;
      assert.equal(Boolean(tok.headers.authorization?.startsWith('Basic ')), expectBasic);
      assert.equal(new URLSearchParams(String(tok.body)).get('client_id'), expectBasic ? null : 'cid');
    }
  });
});

describe('x upload', () => {
  it('initializes, appends 4MB segments and finalizes, saving progress', async () => {
    const size = 2 * SEGMENT + 100;
    const { fetch, calls } = mockFetch([
      ['POST', '/2/media/upload/initialize', () => json({ data: { id: 'M1', expires_after_secs: 86400 } })],
      ['POST', '/2/media/upload/M1/append', () => new Response(null, { status: 204 })],
      ['POST', '/2/media/upload/M1/finalize', () => json({ data: { id: 'M1', processing_info: { state: 'pending', check_after_secs: 1 } } })],
    ]);
    const { ctx } = makeCtx(fetch, () => NOW);
    const saved: Array<Record<string, unknown>> = [];
    const out = await x.publish({ ctx, post: post(), target: target(), account, mediaPath: tempFile(size), media: fakeMedia(), saveResume: (r) => saved.push(r) });
    assert.deepEqual([out.state, out.remoteId], ['processing', 'M1']);
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), { media_type: 'video/mp4', total_bytes: size, media_category: 'tweet_video' });
    const appends = calls.filter((c) => c.url.endsWith('/append')).map((c) => [(c.body as FormData).get('segment_index'), ((c.body as FormData).get('media') as Blob).size]);
    assert.deepEqual(appends, [['0', SEGMENT], ['1', SEGMENT], ['2', 100]]);
    assert.deepEqual(saved.at(-1), { mediaId: 'M1', segment: 3, finalized: true, expiresAt: NOW.getTime() + 86_400_000 });
  });

  it('resumes appending from the saved segment', async () => {
    const { fetch, calls } = mockFetch([
      ['POST', '/2/media/upload/M1/append', () => new Response(null, { status: 204 })],
      ['POST', '/2/media/upload/M1/finalize', () => json({ data: { id: 'M1' } })],
    ]);
    const { ctx } = makeCtx(fetch, () => NOW);
    await x.publish({ ctx, post: post(), target: target({}, { mediaId: 'M1', segment: 1 }), account, mediaPath: tempFile(SEGMENT + 10), media: fakeMedia(), saveResume: () => {} });
    assert.deepEqual(calls.filter((c) => c.url.endsWith('/append')).map((c) => (c.body as FormData).get('segment_index')), ['1']);
    assert.ok(!calls.some((c) => c.url.includes('initialize')));
  });

  it('waits for processing, then posts once and refuses to guess after an unknown outcome', async () => {
    let state = 'in_progress';
    let tweetStatus = 201;
    const { fetch, calls } = mockFetch([
      ['GET', '/2/media/upload?', () => json({ data: { id: 'M1', processing_info: { state } } })],
      ['POST', '/2/tweets', () => (tweetStatus === 201 ? json({ data: { id: 'T1' } }, 201) : json({ title: 'Service Unavailable' }, tweetStatus))],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    const mk = () => {
      const { targets } = store.createPost(post(), [{ platform: 'x', account: 'main', options: {} }]);
      return { ...store.getTarget(targets[0]!.id)!, remoteId: 'M1', resume: { mediaId: 'M1', finalized: true } };
    };
    const t = mk();
    assert.equal((await x.poll({ ctx, post: post(), target: t, account })).state, 'processing');
    state = 'succeeded';
    const out = await x.poll({ ctx, post: post(), target: t, account });
    assert.deepEqual([out.state, out.remoteUrl], ['published', 'https://x.com/me/status/T1']);
    assert.deepEqual(JSON.parse(String(calls.find((c) => c.url.endsWith('/2/tweets'))!.body)), { text: '영상\n\n설명\n\n#fanout', media: { media_ids: ['M1'] } });

    // A 503 leaves the outcome unknown: the next poll must not post again.
    tweetStatus = 503;
    const t2 = mk();
    await assert.rejects(x.poll({ ctx, post: post(), target: t2, account }), (e: ProviderError) => e.kind === 'retryable');
    const fresh = { ...store.getTarget(t2.id)!, remoteId: 'M1' };
    await assert.rejects(x.poll({ ctx, post: post(), target: fresh, account }), (e: ProviderError) => e.code === 'x.maybe_posted');
    assert.equal(calls.filter((c) => c.url.endsWith('/2/tweets')).length, 2, 'no third attempt');
  });

  it('clears the marker after a clear rejection and explains missing credits', async () => {
    const { fetch } = mockFetch([
      ['GET', '/2/media/upload?', () => json({ data: { id: 'M1' } })],
      ['POST', '/2/tweets', () => json({ title: 'Payment Required', detail: 'Your account has no credits' }, 402)],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    const { targets } = store.createPost(post(), [{ platform: 'x', account: 'main', options: {} }]);
    const t = { ...store.getTarget(targets[0]!.id)!, remoteId: 'M1', resume: { mediaId: 'M1' } };
    await assert.rejects(x.poll({ ctx, post: post(), target: t, account }), (e: ProviderError) => e.kind === 'rejected' && /크레딧/.test(e.message));
    assert.equal((store.getTarget(t.id)!.resume as { posting: boolean }).posting, false);
  });

  it('posts again only after the user retries a maybe-posted target', async () => {
    const { fetch, calls } = mockFetch([
      ['GET', '/2/media/upload?', () => json({ data: { id: 'M1' } })],
      ['POST', '/2/tweets', () => json({ data: { id: 'T9' } }, 201)],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    const { targets } = store.createPost(post(), [{ platform: 'x', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    store.transition(id, 'uploading');
    store.transition(id, 'processing', { remoteId: 'M1', resume: { mediaId: 'M1', finalized: true, posting: true } });
    await assert.rejects(x.poll({ ctx, post: post(), target: { ...store.getTarget(id)!, remoteId: 'M1' }, account }), (e: ProviderError) => e.code === 'x.maybe_posted');
    store.transition(id, 'failed', { errorCode: 'x.maybe_posted' });
    retryTarget(store, id, 'test');
    assert.equal((store.getTarget(id)!.resume as { posting: boolean }).posting, false);
    const out = await x.poll({ ctx, post: post(), target: { ...store.getTarget(id)!, remoteId: 'M1' }, account });
    assert.equal(out.remoteId, 'T9');
    assert.equal(calls.filter((c) => c.url.endsWith('/2/tweets')).length, 1);
  });

  it('reports failed processing', async () => {
    const { fetch } = mockFetch([['GET', '/2/media/upload?', () => json({ data: { id: 'M1', processing_info: { state: 'failed', error: { name: 'InvalidMedia', message: 'Unsupported codec' } } } })]]);
    const { ctx } = makeCtx(fetch, () => NOW);
    await assert.rejects(x.poll({ ctx, post: post(), target: { ...target({}, { mediaId: 'M1' }), remoteId: 'M1' }, account }), (e: ProviderError) => e.platformCode === 'InvalidMedia');
  });
});

describe('x refresh race', () => {
  it('a refresh token another process already used: take the pair it stored', async () => {
    let env!: ReturnType<typeof makeCtx>;
    const { fetch } = mockFetch([
      [
        'POST',
        '/2/oauth2/token',
        () => {
          // The other process wins: it used RT and saved its new pair before our request is answered.
          env.store.saveAccount({ ...account, credentials: { ...account.credentials, accessToken: 'AT2', refreshToken: 'RT2', expiresAt: NOW.getTime() + 7200_000 } });
          return json({ error: 'invalid_request', error_description: 'Value passed for the token was invalid.' }, 400);
        },
      ],
    ]);
    env = makeCtx(fetch, () => NOW);
    env.store.setApp('x', { clientId: 'cid' });
    const expired = { ...account, credentials: { ...account.credentials, expiresAt: 0 } };
    env.store.saveAccount(expired);
    const next = await x.refresh(env.ctx, expired);
    assert.equal((next.credentials as { accessToken: string }).accessToken, 'AT2');
  });

  it('an account already refreshed elsewhere is used without spending the token again', async () => {
    const { fetch, calls } = mockFetch([]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.saveAccount({ ...account, credentials: { ...account.credentials, accessToken: 'AT3', refreshToken: 'RT3' } });
    const next = await x.refresh(ctx, { ...account, credentials: { ...account.credentials, expiresAt: 0 } });
    assert.equal((next.credentials as { accessToken: string }).accessToken, 'AT3');
    assert.equal(calls.length, 0);
  });
});
