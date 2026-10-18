import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import type { Account } from '../src/core/store.ts';
import type { Post, Target } from '../src/core/types.ts';
import { facebook, reelOutcome } from '../src/providers/facebook.ts';
import { holdUntil } from '../src/core/posting.ts';
import { instagram } from '../src/providers/instagram.ts';
import { step } from '../src/core/runner.ts';
import { providerMap } from '../src/providers/index.ts';
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
    assert.deepEqual(codes({ collaborators: 'alice, @bob' }), codes({}), 'a comma-separated string (MCP, watch JSON) works too');
    assert.ok(codes({}, Array.from({ length: 21 }, (_, i) => `@u${i}`).join(' ')).includes('mentions'));
    assert.ok(!codes({}, 'mail me at a@b.co @one').includes('mentions'));
  });

  it('trial reels: graduation strategy sent, unknown values refused, and a refusal says what to drop', async () => {
    let refuse = false;
    const { fetch, calls } = mockFetch([
      ['GET', '/IG/content_publishing_limit', () => json({ data: [{ quota_usage: 0, config: { quota_total: 100 } }] })],
      ['POST', '/IG/media', () => (refuse ? json({ error: { message: '(#100) Invalid parameter', type: 'OAuthException', code: 100 } }, 400) : json({ id: 'CONT1', uri: 'https://rupload.facebook.com/ig-api-upload/v24.0/CONT1' }))],
      ['POST', 'rupload.facebook.com', () => json({ success: true })],
    ]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    const publish = (trialReel?: string) =>
      instagram.publish({ ctx, post, target: { ...target('instagram'), options: { trialReel } }, account: account('instagram'), mediaPath: tempFile(10), media: fakeMedia(), saveResume: () => {} });
    await publish('auto');
    assert.deepEqual(JSON.parse(new URLSearchParams(String(calls[1]!.body)).get('trial_params')!), { graduation_strategy: 'SS_PERFORMANCE' });
    await publish();
    assert.equal(new URLSearchParams(String(calls.filter((c) => c.url.endsWith('/IG/media')).at(-1)!.body)).get('trial_params'), null);
    refuse = true;
    await assert.rejects(publish('manual'), /trialReel/);
    const codes = (o: Record<string, unknown>) => instagram.validate(post, { ...target('instagram'), options: o }, fakeMedia({}, { width: 1080, height: 1920 })).map((i) => `${i.severity}:${i.code}`);
    assert.ok(codes({ trialReel: 'manual' }).includes('warning:trial'), 'experimental: said up front');
    assert.ok(codes({ trialReel: 'sometimes' }).includes('error:trial'));
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

  it('sends the title and saves a draft instead of publishing (or scheduling)', async () => {
    const { fetch, calls } = mockFetch([
      ['POST', '/PAGE/video_reels', (c) => (new URLSearchParams(String(c.body)).get('upload_phase') === 'start' ? json({ video_id: 'R1', upload_url: 'https://rupload.facebook.com/video-upload/v24.0/R1' }) : json({ success: true }))],
      ['POST', 'rupload.facebook.com', () => json({ success: true })],
    ]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    const draft = { ...target('facebook'), options: { title: '가사 영상', draft: true } };
    await facebook.publish({ ctx, post: { ...post, scheduledAt: '2026-10-20T00:00:00.000Z' }, target: draft, account: account('facebook'), mediaPath: tempFile(16), media: fakeMedia(), saveResume: () => {} });
    const finish = new URLSearchParams(String(calls[2]!.body));
    assert.deepEqual([finish.get('title'), finish.get('video_state'), finish.get('scheduled_publish_time')], ['가사 영상', 'DRAFT', null]);
    const out = await facebook.publish({ ctx, post, target: { ...draft, resume: { videoId: 'R1', finished: true } }, account: account('facebook'), mediaPath: tempFile(16), media: fakeMedia(), saveResume: () => {} });
    assert.equal(out.remoteUrl, undefined, 'a draft has no public page to link to');
    // Done once processed: it waits in the Page's drafts.
    assert.equal(reelOutcome('R1', { status: { processing_phase: { status: 'complete' } } }, true).state, 'handed_off');
    assert.equal(reelOutcome('R1', { status: { processing_phase: { status: 'complete' } } }).state, 'processing');
    assert.ok(facebook.validate({ ...post, scheduledAt: '2026-10-20T00:00:00.000Z' }, draft, fakeMedia()).some((i) => i.code === 'draft_schedule'));
  });

  it('a draft is not held back for a far schedule, and checks the cover frame range elsewhere', () => {
    assert.equal(holdUntil(facebook, new Date(Date.now() + 60 * 86_400_000).toISOString(), Date.now(), { draft: true }), undefined);
    assert.ok(holdUntil(facebook, new Date(Date.now() + 60 * 86_400_000).toISOString(), Date.now(), {}));
    const cover = (thumbOffsetMs: number) => instagram.validate(post, { ...target('instagram'), options: { thumbOffsetMs } }, fakeMedia({ durationSec: 15 }, { width: 1080, height: 1920 })).some((i) => i.code === 'cover');
    assert.deepEqual([cover(-1), cover(1500), cover(60_000)], [true, false, true]);
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

describe('facebook draft through the runner', () => {
  it('never carries a reel link, from upload to handed_off', async () => {
    let processed = false;
    const { fetch } = mockFetch([
      ['POST', '/PAGE/video_reels', (c) => (new URLSearchParams(String(c.body)).get('upload_phase') === 'start' ? json({ video_id: 'R1', upload_url: 'https://rupload.facebook.com/video-upload/v24.0/R1' }) : json({ success: true }))],
      ['POST', 'rupload.facebook.com', () => json({ success: true })],
      ['GET', '/R1?', () => json({ status: { processing_phase: { status: processed ? 'complete' : 'in_progress' } } })],
    ]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    store.saveAccount(account('facebook'));
    const { targets } = store.createPost({ mediaPath: tempFile(16), title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false }, [{ platform: 'facebook', account: 'main', options: { draft: true } }]);
    const deps = { ctx, providers: providerMap(), probe: async () => fakeMedia({ durationSec: 20 }, { width: 1080, height: 1920 }), ensureVariant: async (info: { path: string }) => ({ path: info.path, transcoded: false, reasons: [] }) };
    const id = targets[0]!.id;
    let t = await step(deps as never, id);
    assert.equal(t.state, 'processing');
    t = await step(deps as never, id);
    assert.deepEqual([t.state, t.remoteUrl], ['processing', undefined], 'no link while Meta processes it either');
    processed = true;
    t = await step(deps as never, id);
    assert.deepEqual([t.state, t.remoteUrl], ['handed_off', undefined]);
  });
});
