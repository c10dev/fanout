import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import type { Account } from '../src/core/store.ts';
import type { Post, Target } from '../src/core/types.ts';
import { captionFor, chunkPlan, statusOutcome, tiktok, tiktokError } from '../src/providers/tiktok.ts';
import { fakeMedia, json, makeCtx, mockFetch, tempFile } from './helpers.ts';

const MB = 1024 * 1024;
const NOW = new Date('2026-10-17T03:00:00Z');

const post: Post = { id: 'p', createdAt: NOW.toISOString(), mediaPath: '/v.mp4', title: '제목', description: '본문', tags: ['짧은영상', '#vlog'], captions: [], containsSyntheticMedia: true };
const account: Account = {
  platform: 'tiktok',
  name: 'main',
  credentials: { accessToken: 'AT', refreshToken: 'RT', expiresAt: NOW.getTime() + 3600_000, refreshExpiresAt: NOW.getTime() + 1e10, openId: 'o', scope: 'video.upload' },
  profile: {},
};
const target = (options: Record<string, unknown>): Target => ({ id: 't', postId: 'p', platform: 'tiktok', account: 'main', options, state: 'uploading', warnings: [], attempts: 1, updatedAt: '' });

describe('tiktok chunk plan', () => {
  it('sends files up to 64MB as one chunk', () => {
    assert.deepEqual(chunkPlan(3 * MB), { chunkSize: 3 * MB, count: 1, ranges: [[0, 3 * MB - 1]] });
    assert.equal(chunkPlan(64 * MB).count, 1);
  });

  it('folds the remainder into the last 32MB chunk', () => {
    const size = 100 * MB + 5;
    const plan = chunkPlan(size);
    assert.equal(plan.chunkSize, 32 * MB);
    assert.equal(plan.count, 3);
    assert.deepEqual(plan.ranges.at(-1), [64 * MB, size - 1]);
    assert.ok(size - 64 * MB <= 128 * MB);
  });
});

describe('tiktok options', () => {
  it('builds a caption with hashtags', () => {
    assert.equal(captionFor(post, { mode: 'direct' }), '제목\n\n본문\n\n#짧은영상 #vlog');
  });

  it('requires an explicit privacy level and music consent for direct posts', () => {
    const codes = tiktok.validate(post, target({ mode: 'direct' }), fakeMedia()).map((i) => i.code);
    assert.ok(codes.includes('privacy'));
    assert.ok(codes.includes('music_consent'));
  });

  it('refuses private branded content', () => {
    const issues = tiktok.validate(post, target({ mode: 'direct', privacyLevel: 'SELF_ONLY', musicConsent: true, brandedContent: true }), fakeMedia());
    assert.ok(issues.some((i) => i.code === 'branded_private'));
  });

  it('accepts inbox mode with only a warning', () => {
    const issues = tiktok.validate(post, target({ mode: 'inbox' }), fakeMedia());
    assert.ok(issues.every((i) => i.severity === 'warning'));
  });
});

describe('tiktok errors and status', () => {
  it('explains the unaudited-client restriction', () => {
    const e = tiktokError(403, { error: { code: 'unaudited_client_can_only_post_to_private_accounts', message: 'nope' } });
    assert.equal(e.kind, 'rejected');
    assert.match(e.message, /SELF_ONLY/);
    assert.equal(tiktokError(401, { error: { code: 'access_token_invalid' } }).kind, 'auth');
    assert.equal(tiktokError(429, { error: { code: 'rate_limit_exceeded' } }).kind, 'retryable');
  });

  it('maps publish statuses onto target states', () => {
    assert.equal(statusOutcome('pid', { status: 'PROCESSING_UPLOAD' }).state, 'processing');
    assert.equal(statusOutcome('pid', { status: 'SEND_TO_USER_INBOX' }).state, 'handed_off');
    const done = statusOutcome('pid', { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7123] }, 'me');
    assert.equal(done.remoteUrl, 'https://www.tiktok.com/@me/video/7123');
    assert.throws(() => statusOutcome('pid', { status: 'FAILED', fail_reason: 'file_format_check_failed' }), (e: ProviderError) => e.platformCode === 'file_format_check_failed');
  });
});

describe('tiktok publish', () => {
  it('inbox mode: init, upload, then poll to handed_off', async () => {
    const file = tempFile(2 * MB);
    const { fetch, calls } = mockFetch([
      ['POST', '/post/publish/inbox/video/init/', () => json({ data: { publish_id: 'v_inbox~1', upload_url: 'https://upload.tiktok.example/u1' }, error: { code: 'ok' } })],
      ['PUT', 'upload.tiktok.example/u1', () => new Response(null, { status: 201 })],
      ['POST', '/post/publish/status/fetch/', () => json({ data: { status: 'SEND_TO_USER_INBOX' }, error: { code: 'ok' } })],
    ]);
    const { ctx } = makeCtx(fetch, () => NOW);
    const t = target({ mode: 'inbox' });
    const out = await tiktok.publish({ ctx, post, target: t, account, mediaPath: file, media: fakeMedia(), saveResume: () => {} });
    assert.deepEqual(out, { state: 'processing', remoteId: 'v_inbox~1' });
    const initBody = JSON.parse(String(calls[0]!.body)) as { source_info: Record<string, unknown>; post_info?: unknown };
    assert.deepEqual(initBody.source_info, { source: 'FILE_UPLOAD', video_size: 2 * MB, chunk_size: 2 * MB, total_chunk_count: 1 });
    assert.equal(initBody.post_info, undefined);
    assert.equal(calls[1]!.headers['content-range'], `bytes 0-${2 * MB - 1}/${2 * MB}`);
    const polled = await tiktok.poll({ ctx, post, target: { ...t, remoteId: 'v_inbox~1' }, account });
    assert.equal(polled.state, 'handed_off');
  });

  it('direct mode sends the mandated UX fields with interactions off by default', async () => {
    const file = tempFile(1000);
    const { fetch, calls } = mockFetch([
      [
        'POST',
        '/creator_info/query/',
        () => json({ data: { creator_username: 'me', privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'], max_video_post_duration_sec: 600 }, error: { code: 'ok' } }),
      ],
      ['POST', '/post/publish/video/init/', () => json({ data: { publish_id: 'p1', upload_url: 'https://upload.tiktok.example/u2' }, error: { code: 'ok' } })],
      ['PUT', 'u2', () => new Response(null, { status: 201 })],
    ]);
    const { ctx } = makeCtx(fetch, () => NOW);
    await tiktok.publish({
      ctx,
      post,
      target: target({ mode: 'direct', privacyLevel: 'PUBLIC_TO_EVERYONE', musicConsent: true, allowComment: true }),
      account,
      mediaPath: file,
      media: fakeMedia(),
      saveResume: () => {},
    });
    const init = JSON.parse(String(calls[1]!.body)) as { post_info: Record<string, unknown> };
    assert.equal(init.post_info.privacy_level, 'PUBLIC_TO_EVERYONE');
    assert.equal(init.post_info.disable_comment, false);
    assert.equal(init.post_info.disable_duet, true);
    assert.equal(init.post_info.disable_stitch, true);
    assert.equal(init.post_info.is_aigc, true);
  });

  it('direct mode rejects a privacy level the creator cannot use', async () => {
    const { fetch } = mockFetch([
      ['POST', '/creator_info/query/', () => json({ data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } })],
    ]);
    const { ctx } = makeCtx(fetch, () => NOW);
    await assert.rejects(
      tiktok.publish({ ctx, post, target: target({ mode: 'direct', privacyLevel: 'PUBLIC_TO_EVERYONE', musicConsent: true }), account, mediaPath: tempFile(10), media: fakeMedia(), saveResume: () => {} }),
      (e: ProviderError) => e.code === 'tiktok.privacy_level_option_mismatch',
    );
  });

  it('treats a 200 response with a non-ok error code as a failure', async () => {
    const { fetch } = mockFetch([
      ['POST', '/post/publish/inbox/video/init/', () => json({ error: { code: 'spam_risk_too_many_posts', message: 'too many' } })],
    ]);
    const { ctx } = makeCtx(fetch, () => NOW);
    await assert.rejects(
      tiktok.publish({ ctx, post, target: target({ mode: 'inbox' }), account, mediaPath: tempFile(10), media: fakeMedia(), saveResume: () => {} }),
      (e: ProviderError) => e.kind === 'rejected' && e.platformCode === 'spam_risk_too_many_posts',
    );
  });
});

describe('tiktok refresh', () => {
  it('doctor still really refreshes a stale copy of an unchanged token', async () => {
    const { fetch, calls } = mockFetch([['POST', '/oauth/token/', () => json({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'o', scope: 'video.upload' })]]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('tiktok', { clientKey: 'k', clientSecret: 's' });
    store.saveAccount(account);
    const next = await tiktok.refresh(ctx, { ...account, credentials: { ...account.credentials, expiresAt: 0 } });
    assert.equal(calls.length, 1);
    assert.equal((next.credentials as { accessToken: string }).accessToken, 'AT2');
  });

  it('uses the pair another process stored when it already rotated the refresh token', async () => {
    const { fetch, calls } = mockFetch([]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('tiktok', { clientKey: 'k', clientSecret: 's' });
    store.saveAccount({ ...account, credentials: { ...account.credentials, accessToken: 'AT3', refreshToken: 'RT3' } });
    const next = await tiktok.refresh(ctx, { ...account, credentials: { ...account.credentials, expiresAt: 0 } });
    assert.equal(calls.length, 0);
    assert.equal((next.credentials as { accessToken: string }).accessToken, 'AT3');
  });
});
