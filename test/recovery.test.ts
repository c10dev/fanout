import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import type { Account } from '../src/core/store.ts';
import type { Post, Target } from '../src/core/types.ts';
import { bluesky } from '../src/providers/bluesky.ts';
import { tiktok } from '../src/providers/tiktok.ts';
import { x } from '../src/providers/x.ts';
import { youtube } from '../src/providers/youtube.ts';
import { fakeMedia, json, makeCtx, mockFetch, tempFile } from './helpers.ts';

const NOW = new Date('2026-10-17T03:00:00Z');
const post: Post = { id: 'p', createdAt: '', mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };

describe('token refresh failures', () => {
  it('TikTok: a 503 from the token endpoint is retryable, a refused grant needs reconnecting', async () => {
    const acct: Account = { platform: 'tiktok', name: 'main', profile: {}, credentials: { accessToken: 'A', refreshToken: 'R', expiresAt: 0, refreshExpiresAt: 0, openId: 'o', scope: '' } };
    for (const [status, kind] of [[503, 'retryable'], [400, 'auth']] as const) {
      const { fetch } = mockFetch([['POST', '/oauth/token/', () => json({ error: 'x', error_description: 'y' }, status)]]);
      const { ctx, store } = makeCtx(fetch, () => NOW);
      store.setApp('tiktok', { clientKey: 'k', clientSecret: 's' });
      await assert.rejects(tiktok.refresh(ctx, acct), (e: ProviderError) => e.kind === kind);
    }
  });

  it('Bluesky: network trouble during refresh is not "session expired"', async () => {
    const acct: Account = { platform: 'bluesky', name: 'main', profile: {}, credentials: { pds: 'https://pds.example', did: 'd', handle: 'h', accessJwt: '', refreshJwt: 'R' } };
    const down = mockFetch([['POST', 'refreshSession', () => { throw new TypeError('fetch failed'); }]]);
    await assert.rejects(bluesky.refresh(makeCtx(down.fetch, () => NOW).ctx, acct), (e: Error) => !(e instanceof ProviderError) || e.kind !== 'auth');
    const outage = mockFetch([['POST', 'refreshSession', () => json({ error: 'InternalServerError' }, 503)]]);
    await assert.rejects(bluesky.refresh(makeCtx(outage.fetch, () => NOW).ctx, acct), (e: ProviderError) => e.kind === 'retryable');
  });
});

describe('tokens expiring mid-upload', () => {
  it('YouTube refreshes on a 401 chunk and resumes from the session offset', async () => {
    let chunk = 0;
    const { fetch, calls } = mockFetch([
      ['POST', 'oauth2.googleapis.com/token', () => json({ access_token: 'FRESH', expires_in: 3600 })],
      ['PUT', 'session', (c) => {
        if (c.headers['content-range'] === 'bytes */5000') return new Response(null, { status: 308, headers: { range: 'bytes=0-1999' } });
        chunk++;
        if (chunk === 1) return json({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }, 401);
        assert.equal(c.headers.authorization, 'Bearer FRESH');
        return json({ id: 'V', status: { uploadStatus: 'uploaded', privacyStatus: 'unlisted' } }, 200);
      }],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('youtube', { clientId: 'c', clientSecret: 's' });
    const account: Account = { platform: 'youtube', name: 'main', profile: {}, credentials: { accessToken: 'OLD', refreshToken: 'R', expiresAt: NOW.getTime() + 3600_000 } };
    const t: Target = { id: 't', postId: 'p', platform: 'youtube', account: 'main', options: { privacy: 'unlisted', madeForKids: false }, state: 'uploading', warnings: [], attempts: 1, updatedAt: '', resume: { sessionUri: 'https://upload.example/session', size: 5000 } };
    // Resume path: the session reports 2000 bytes, first chunk 401s, refresh, re-query, finish.
    const out = await youtube.publish({ ctx, post, target: t, account, mediaPath: tempFile(5000), media: fakeMedia(), saveResume: () => {} });
    assert.equal(out.remoteId, 'V');
    assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1);
    assert.equal(calls.filter((c) => c.headers['content-range'] === 'bytes */5000').length, 2, 'asked the session again after refreshing');
  });

  it('X refreshes on a 401 append and retries the same segment', async () => {
    let appends = 0;
    const { fetch, calls } = mockFetch([
      ['POST', '/2/oauth2/token', () => json({ access_token: 'FRESH', refresh_token: 'R2', expires_in: 7200 })],
      ['POST', '/append', (c) => {
        appends++;
        return appends === 1 ? json({ title: 'Unauthorized' }, 401) : (assert.equal(c.headers.authorization, 'Bearer FRESH'), new Response(null, { status: 204 }));
      }],
      ['POST', '/finalize', () => json({ data: { id: 'M1' } })],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('x', { clientId: 'cid' });
    const account: Account = { platform: 'x', name: 'main', profile: {}, credentials: { accessToken: 'OLD', refreshToken: 'R', expiresAt: NOW.getTime() + 3600_000, userId: '1', username: 'me' } };
    const t: Target = { id: 't', postId: 'p', platform: 'x', account: 'main', options: {}, state: 'uploading', warnings: [], attempts: 1, updatedAt: '', resume: { mediaId: 'M1', segment: 0 } };
    const out = await x.publish({ ctx, post, target: t, account, mediaPath: tempFile(100), media: fakeMedia(), saveResume: () => {} });
    assert.equal(out.state, 'processing');
    const segs = calls.filter((c) => c.url.endsWith('/append')).map((c) => (c.body as FormData).get('segment_index'));
    assert.deepEqual(segs, ['0', '0']);
  });
});
