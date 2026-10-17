import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import type { Account } from '../src/core/store.ts';
import type { Post, Target } from '../src/core/types.ts';
import { mastodon, normalizeInstance, statusText } from '../src/providers/mastodon.ts';
import { fakeMedia, json, makeCtx, mockFetch, tempFile } from './helpers.ts';

const account: Account = { platform: 'mastodon', name: 'main', credentials: { instance: 'https://mastodon.example', token: 'TOK' }, profile: {} };
const post = (o: Partial<Post> = {}): Post => ({ id: 'p', createdAt: '', mediaPath: '/v.mp4', title: '영상', description: '설명', tags: ['fanout'], captions: [], containsSyntheticMedia: false, ...o });
const target = (options: Record<string, unknown>, resume?: Record<string, unknown>): Target => ({ id: 'tgt-1', postId: 'p', platform: 'mastodon', account: 'main', options, state: 'uploading', warnings: [], attempts: 1, updatedAt: '', resume });

describe('mastodon basics', () => {
  it('normalizes instance addresses and refuses plain http', () => {
    assert.equal(normalizeInstance('mastodon.social'), 'https://mastodon.social');
    assert.equal(normalizeInstance('https://mstdn.jp/'), 'https://mstdn.jp');
    assert.throws(() => normalizeInstance('http://evil.example'), /https/);
  });

  it('requires an explicit visibility and only warns about near schedules', () => {
    const codes = (o: Record<string, unknown>, p = post()) => mastodon.validate(p, target(o), fakeMedia()).map((i) => i.code);
    assert.ok(codes({}).includes('visibility'));
    assert.ok(!codes({ visibility: 'unlisted' }).includes('visibility'));
    const near = mastodon.validate(post({ scheduledAt: new Date(Date.now() + 60_000).toISOString() }), target({ visibility: 'public' }), fakeMedia());
    assert.ok(near.some((i) => i.code === 'schedule' && i.severity === 'warning'), 'a near schedule posts now instead of failing');
  });

  it('builds status text and drops a long description first', () => {
    assert.equal(statusText(post(), {}), '영상\n\n설명\n\n#fanout');
    assert.equal(statusText(post({ description: 'x'.repeat(600) }), {}), '영상\n\n#fanout');
  });

  it('connects with an instance token', async () => {
    const { fetch, calls } = mockFetch([['GET', '/api/v1/accounts/verify_credentials', () => json({ id: '1', acct: 'me', username: 'me', url: 'https://mastodon.example/@me' })]]);
    const { ctx } = makeCtx(fetch);
    const acct = await mastodon.connect(ctx, 'main', { instance: 'mastodon.example', token: 'TOK' });
    assert.equal(acct.profile.username, 'me@mastodon.example');
    assert.equal(calls[0]!.headers.authorization, 'Bearer TOK');
  });
});

describe('mastodon upload', () => {
  it('uploads media with alt text and thumbnail as multipart', async () => {
    const { fetch, calls } = mockFetch([
      ['GET', '/api/v2/instance', () => json({ configuration: { media_attachments: { video_size_limit: 99 * 1024 * 1024 } } })],
      ['POST', '/api/v2/media', () => json({ id: 'm1', url: null }, 202)],
    ]);
    const { ctx } = makeCtx(fetch);
    const saved: Array<Record<string, unknown>> = [];
    const out = await mastodon.publish({
      ctx,
      post: post({ thumbnailPath: tempFile(50) }),
      target: target({ visibility: 'unlisted', alt: '설명 텍스트' }),
      account,
      mediaPath: tempFile(1000),
      media: fakeMedia(),
      saveResume: (r) => saved.push(r),
    });
    assert.deepEqual([out.state, out.remoteId], ['processing', 'm1']);
    const form = calls.find((c) => c.url.endsWith('/api/v2/media'))!.body as FormData;
    assert.equal((form.get('file') as Blob).size, 1000);
    assert.equal(form.get('description'), '설명 텍스트');
    assert.ok(form.get('thumbnail'));
    assert.deepEqual(saved[0], { mediaId: 'm1' });
  });

  it('refuses a file over the instance limit before uploading', async () => {
    const { fetch, calls } = mockFetch([['GET', '/api/v2/instance', () => json({ configuration: { media_attachments: { video_size_limit: 500 } } })]]);
    const { ctx } = makeCtx(fetch);
    await assert.rejects(
      mastodon.publish({ ctx, post: post(), target: target({ visibility: 'public' }), account, mediaPath: tempFile(1000), media: fakeMedia(), saveResume: () => {} }),
      (e: ProviderError) => e.code === 'mastodon.too_large',
    );
    assert.equal(calls.length, 1);
  });

  it('waits for processing, then posts once with an idempotency key', async () => {
    let ready = false;
    const { fetch, calls } = mockFetch([
      ['GET', '/api/v1/media/m1', () => (ready ? json({ id: 'm1', url: 'https://files/m1.mp4' }) : json({ id: 'm1', url: null }, 206))],
      ['POST', '/api/v1/statuses', () => json({ id: 's1', url: 'https://mastodon.example/@me/s1' })],
    ]);
    const { ctx, store } = makeCtx(fetch);
    const { targets } = store.createPost(post(), [{ platform: 'mastodon', account: 'main', options: { visibility: 'unlisted', language: 'ko' } }]);
    const t = { ...store.getTarget(targets[0]!.id)!, remoteId: 'm1', resume: { mediaId: 'm1' } };
    assert.equal((await mastodon.poll({ ctx, post: post(), target: t, account })).state, 'processing');
    ready = true;
    const out = await mastodon.poll({ ctx, post: post(), target: t, account });
    assert.deepEqual([out.state, out.remoteUrl], ['published', 'https://mastodon.example/@me/s1']);
    const status = calls.find((c) => c.url.endsWith('/api/v1/statuses'))!;
    assert.equal(status.headers['idempotency-key'], `fanout-${t.id}`);
    assert.deepEqual(JSON.parse(String(status.body)), { status: '영상\n\n설명\n\n#fanout', media_ids: ['m1'], visibility: 'unlisted', language: 'ko' });
    assert.equal((store.getTarget(t.id)!.resume as { statusId: string }).statusId, 's1');
  });

  it('schedules natively and reports a revoked token as auth', async () => {
    const { fetch } = mockFetch([
      ['GET', '/api/v1/media/m1', () => json({ id: 'm1', url: 'u' })],
      ['POST', '/api/v1/statuses', () => json({ id: 'sch1', scheduled_at: '2026-10-20T00:00:00.000Z' })],
    ]);
    const { ctx, store } = makeCtx(fetch);
    const p = post({ scheduledAt: '2026-10-20T00:00:00.000Z' });
    const { targets } = store.createPost(p, [{ platform: 'mastodon', account: 'main', options: { visibility: 'public' } }]);
    const out = await mastodon.poll({ ctx, post: p, target: { ...store.getTarget(targets[0]!.id)!, remoteId: 'm1', resume: { mediaId: 'm1' } }, account });
    assert.ok(out.warnings?.some((w) => w.includes('예약')));

    const revoked = mockFetch([['GET', '/api/v1/accounts/verify_credentials', () => json({ error: 'The access token was revoked' }, 401)]]);
    await assert.rejects(mastodon.connect(makeCtx(revoked.fetch).ctx, 'main', { instance: 'mastodon.example', token: 'x' }), (e: ProviderError) => e.kind === 'auth');
  });
});
