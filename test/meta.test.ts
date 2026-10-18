import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import type { Account } from '../src/core/store.ts';
import type { Post, Target } from '../src/core/types.ts';
import { facebook, reelOutcome } from '../src/providers/facebook.ts';
import { instagram } from '../src/providers/instagram.ts';
import { graphError } from '../src/providers/meta.ts';
import { fakeMedia, json, makeCtx, mockFetch, tempFile } from './helpers.ts';

const post: Post = { id: 'p', createdAt: '', mediaPath: '/v.mp4', title: '제목', description: '', tags: ['릴스'], captions: [], containsSyntheticMedia: false };
const account = (platform: string): Account => ({ platform, name: 'main', credentials: { pageId: 'PAGE', pageToken: 'PT', igUserId: 'IG' }, profile: {} });
const target = (platform: string, resume?: Record<string, unknown>): Target => ({
  id: 't',
  postId: 'p',
  platform,
  account: 'main',
  options: {},
  state: 'uploading',
  warnings: [],
  attempts: 1,
  updatedAt: '',
  resume,
});

describe('graph errors', () => {
  it('classifies token, rate-limit and daily-limit codes', () => {
    assert.equal(graphError(400, { error: { code: 190, message: 'expired' } }).kind, 'auth');
    assert.equal(graphError(400, { error: { code: 4 } }).kind, 'retryable');
    assert.equal(graphError(400, { error: { code: 9, error_subcode: 2207042 } }).platformCode, '9/2207042');
  });
});

describe('instagram reels', () => {
  it('checks the live publishing limit, creates a resumable container and uploads', async () => {
    const file = tempFile(4096);
    const { fetch, calls } = mockFetch([
      ['GET', '/IG/content_publishing_limit', () => json({ data: [{ quota_usage: 3, config: { quota_total: 100 } }] })],
      ['POST', '/IG/media', () => json({ id: 'CONT1', uri: 'https://rupload.facebook.com/ig-api-upload/v24.0/CONT1' })],
      ['POST', 'rupload.facebook.com', () => json({ success: true })],
    ]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    const out = await instagram.publish({ ctx, post, target: target('instagram'), account: account('instagram'), mediaPath: file, media: fakeMedia(), saveResume: () => {} });
    assert.equal(out.state, 'processing');
    assert.equal(out.remoteId, 'CONT1');
    assert.deepEqual(out.warnings, ['Instagram 24시간 게시 4/100']);
    const create = new URLSearchParams(String(calls[1]!.body));
    assert.equal(create.get('media_type'), 'REELS');
    assert.equal(create.get('upload_type'), 'resumable');
    assert.equal(create.get('caption'), '제목\n\n#릴스');
    assert.equal(calls[2]!.headers.authorization, 'OAuth PT');
    assert.equal(calls[2]!.headers.file_size, '4096');
    assert.equal(create.get('is_ai_generated'), null, 'only when the post is marked AI');
  });

  it('sends collaborators, the audio name and the AI disclosure, and checks them first', async () => {
    const { fetch, calls } = mockFetch([
      ['GET', '/IG/content_publishing_limit', () => json({ data: [{ quota_usage: 0, config: { quota_total: 100 } }] })],
      ['POST', '/IG/media', () => json({ id: 'CONT1', uri: 'https://rupload.facebook.com/ig-api-upload/v24.0/CONT1' })],
      ['POST', 'rupload.facebook.com', () => json({ success: true })],
    ]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    const t = { ...target('instagram'), options: { collaborators: ['@friend', 'band.official'], audioName: 'Ditto (cover)' } };
    await instagram.publish({ ctx, post: { ...post, containsSyntheticMedia: true }, target: t, account: account('instagram'), mediaPath: tempFile(10), media: fakeMedia(), saveResume: () => {} });
    const create = new URLSearchParams(String(calls[1]!.body));
    assert.deepEqual(JSON.parse(create.get('collaborators')!), ['friend', 'band.official']);
    assert.equal(create.get('audio_name'), 'Ditto (cover)');
    assert.equal(create.get('is_ai_generated'), 'true');

    const codes = (options: Record<string, unknown>, caption = '') =>
      instagram.validate({ ...post, title: caption || post.title }, { ...target('instagram'), options }, fakeMedia({}, { width: 1080, height: 1920 })).map((i) => i.code);
    assert.ok(codes({ collaborators: ['a', 'b', 'c', 'd'] }).includes('collaborators'), 'more than 3');
    assert.ok(codes({ collaborators: ['not a name!'] }).includes('collaborators'));
    assert.ok(codes({}, Array.from({ length: 21 }, (_, i) => `@u${i}`).join(' ')).includes('mentions'));
    assert.ok(!codes({}, 'mail me at a@b.co @one').includes('mentions'));
  });

  it('refuses when the 24h limit is used up', async () => {
    const { fetch } = mockFetch([['GET', 'content_publishing_limit', () => json({ data: [{ quota_usage: 50, config: { quota_total: 50 } }] })]]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    await assert.rejects(
      instagram.publish({ ctx, post, target: target('instagram'), account: account('instagram'), mediaPath: tempFile(10), media: fakeMedia(), saveResume: () => {} }),
      (e: ProviderError) => e.code === 'instagram.publishing_limit' && e.retryAt === new Date(ctx.now().getTime() + 3600_000).toISOString(),
    );
  });

  it('publishes the container once it is FINISHED', async () => {
    const { fetch, calls } = mockFetch([
      ['GET', '/CONT1?', () => json({ status_code: 'FINISHED' })],
      ['POST', '/IG/media_publish', () => json({ id: 'MEDIA1' })],
      ['GET', '/MEDIA1?', () => json({ permalink: 'https://www.instagram.com/reel/abc/' })],
    ]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    const { targets } = store.createPost(post, [{ platform: 'instagram', account: 'main', options: {} }]);
    const t = { ...store.getTarget(targets[0]!.id)!, remoteId: 'CONT1', resume: { containerId: 'CONT1', uploaded: true } };
    const out = await instagram.poll({ ctx, post, target: t, account: account('instagram') });
    assert.equal(out.state, 'published');
    assert.equal(out.remoteUrl, 'https://www.instagram.com/reel/abc/');
    assert.equal(new URLSearchParams(String(calls[1]!.body)).get('creation_id'), 'CONT1');
  });

  it('keeps polling while IN_PROGRESS and fails on ERROR', async () => {
    let code = 'IN_PROGRESS';
    const { fetch } = mockFetch([['GET', '/CONT2?', () => json({ status_code: code, status: 'Error: unsupported codec' })]]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    const t = { ...target('instagram', { containerId: 'CONT2' }), remoteId: 'CONT2' };
    assert.equal((await instagram.poll({ ctx, post, target: t, account: account('instagram') })).state, 'processing');
    code = 'PUBLISHED';
    assert.equal((await instagram.poll({ ctx, post, target: t, account: account('instagram') })).state, 'published');
    code = 'ERROR';
    await assert.rejects(instagram.poll({ ctx, post, target: t, account: account('instagram') }), /ERROR/);
  });
});

describe('facebook reels', () => {
  it('start → rupload → finish with native scheduling', async () => {
    const file = tempFile(2048);
    const { fetch, calls } = mockFetch([
      ['POST', '/PAGE/video_reels', (c) => (new URLSearchParams(String(c.body)).get('upload_phase') === 'start' ? json({ video_id: 'R1', upload_url: 'https://rupload.facebook.com/video-upload/v24.0/R1' }) : json({ success: true }))],
      ['POST', 'rupload.facebook.com', () => json({ success: true })],
    ]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    const scheduled = { ...post, scheduledAt: '2026-10-20T00:00:00.000Z' };
    const out = await facebook.publish({ ctx, post: scheduled, target: target('facebook'), account: account('facebook'), mediaPath: file, media: fakeMedia(), saveResume: () => {} });
    assert.equal(out.remoteId, 'R1');
    const finish = new URLSearchParams(String(calls[2]!.body));
    assert.equal(finish.get('upload_phase'), 'finish');
    assert.equal(finish.get('video_state'), 'SCHEDULED');
    assert.equal(finish.get('scheduled_publish_time'), String(Date.parse('2026-10-20T00:00:00Z') / 1000));
  });

  it('maps reel status phases', () => {
    assert.equal(reelOutcome('R', { status: { publishing_phase: { status: 'in_progress' } } }).state, 'processing');
    assert.equal(reelOutcome('R', { status: { publishing_phase: { status: 'complete', publish_status: 'published' } } }).state, 'published');
    assert.throws(() => reelOutcome('R', { status: { processing_phase: { status: 'error', errors: [{ message: 'bad aspect' }] } } }), /bad aspect/);
  });

  it('rejects schedules outside the 10 min – 29 day window', () => {
    const soon = { ...post, scheduledAt: new Date(Date.now() + 60_000).toISOString() };
    assert.ok(facebook.validate(soon, target('facebook'), fakeMedia()).some((i) => i.code === 'schedule_window'));
  });
});
