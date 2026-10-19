import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import type { Account } from '../src/core/store.ts';
import type { Post, Target } from '../src/core/types.ts';
import { withTimeout } from '../src/core/posting.ts';
import { creatorIssues, captionFor, chunkPlan, parseExactJson, statusOutcome, tiktok, tiktokError } from '../src/providers/tiktok.ts';
import { fakeMedia, json, makeCtx, mockFetch, slowFetch, tempFile } from './helpers.ts';

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

  it('counts the caption the way TikTok does (UTF-16 units: an emoji is 2)', () => {
    const caption = (text: string) => tiktok.validate(post, target({ mode: 'direct', privacyLevel: 'SELF_ONLY', musicConsent: true, caption: text }), fakeMedia()).filter((i) => i.code === 'caption');
    assert.deepEqual(caption('😀'.repeat(1100)), [], '2200 units');
    assert.equal(caption('😀'.repeat(1101)).length, 1, '2202 units, though only 1101 characters');
  });

  it('checks a direct post against the account\'s own rules before anything uploads', () => {
    const info = { privacy_level_options: ['SELF_ONLY', 'FOLLOWER_OF_CREATOR'] as never, max_video_post_duration_sec: 60, comment_disabled: true };
    const direct = { mode: 'direct' as const, privacyLevel: 'PUBLIC_TO_EVERYONE' as never, allowComment: true };
    const issues = creatorIssues(info, direct, 90);
    assert.deepEqual(issues.map((i) => [i.code, i.severity]), [['privacy', 'error'], ['duration', 'error'], ['interactions', 'warning']]);
    assert.deepEqual(creatorIssues(info, { ...direct, privacyLevel: 'SELF_ONLY' as never, allowComment: false }, 30), []);
    assert.deepEqual(creatorIssues(info, { mode: 'inbox' } as never, 90), [], 'inbox uploads are finished in the app');
  });

  it('checks the cover frame is inside the video', () => {
    const cover = (coverTimestampMs: number) => tiktok.validate(post, target({ mode: 'direct', privacyLevel: 'SELF_ONLY', musicConsent: true, coverTimestampMs }), fakeMedia({ durationSec: 15 })).some((i) => i.code === 'cover');
    assert.deepEqual([cover(-5), cover(2000), cover(60_000)], [true, false, true]);
  });

  it('waits out the daily post cap instead of failing', () => {
    const err = tiktokError(403, { error: { code: 'spam_risk_too_many_posts', message: 'too many' } } as never);
    assert.ok(err.retryAt && Date.parse(err.retryAt) > Date.now());
    assert.equal(tiktokError(400, { error: { code: 'invalid_params', message: 'x' } } as never).retryAt, undefined);
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
    const saved: Array<Record<string, unknown>> = [];
    const out = await tiktok.publish({ ctx, post, target: t, account, mediaPath: file, media: fakeMedia({ durationSec: 30.4 }), saveResume: (r) => saved.push(r) });
    assert.deepEqual(out, { state: 'processing', remoteId: 'v_inbox~1' });
    assert.equal(saved.at(-1)!.durationSec, 30.4, 'kept to recognise the post if it is finished in the app');
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
  it('a disconnect while the token request is out does not bring the account back', async () => {
    let env!: ReturnType<typeof makeCtx>;
    const { fetch } = mockFetch([
      [
        'POST',
        '/oauth/token/',
        () => {
          env.store.removeAccount('tiktok', account.name);
          return json({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'o', scope: 'video.upload' });
        },
      ],
    ]);
    env = makeCtx(fetch);
    env.store.setApp('tiktok', { clientKey: 'k', clientSecret: 's' });
    const expired = { ...account, credentials: { ...account.credentials, expiresAt: 0 } };
    env.store.saveAccount(expired);
    const next = await tiktok.refresh(env.ctx, expired);
    assert.equal((next.credentials as { accessToken: string }).accessToken, 'AT2');
    assert.equal(env.store.getAccount('tiktok', account.name), undefined);
  });

  it('doctor still really refreshes a stale copy of an unchanged token', async () => {
    const { fetch, calls } = mockFetch([['POST', '/oauth/token/', () => json({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'o', scope: 'video.upload' })]]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('tiktok', { clientKey: 'k', clientSecret: 's' });
    store.saveAccount(account);
    const next = await tiktok.refresh(ctx, { ...account, credentials: { ...account.credentials, expiresAt: 0 } });
    assert.equal(calls.length, 1);
    assert.equal((next.credentials as { accessToken: string }).accessToken, 'AT2');
  });

  it('a short deadline on the caller never cuts the rotation off', async () => {
    const tok = { access_token: 'AT2', refresh_token: 'RT2', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'o', scope: 'video.upload' };
    const { ctx, store } = makeCtx(slowFetch(tok, 80), () => NOW);
    store.setApp('tiktok', { clientKey: 'k', clientSecret: 's' });
    const expired = { ...account, credentials: { ...account.credentials, expiresAt: 0 } };
    store.saveAccount(expired);
    await tiktok.refresh(withTimeout(ctx, 30), expired);
    assert.equal((store.getAccount('tiktok', account.name)!.credentials as { refreshToken: string }).refreshToken, 'RT2');
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

describe('tiktok stats', () => {
  const t = (remoteId: string) => ({ id: 't', postId: 'p', platform: 'tiktok', account: 'main', options: {}, state: 'published', warnings: [], attempts: 1, updatedAt: '', remoteId }) as Target & { remoteId: string };
  const withList: Account = { ...account, credentials: { ...account.credentials, scope: 'user.info.basic,video.upload,video.list' } };

  it('reads views, likes, comments and shares of the posted video with video.list', async () => {
    const { fetch, calls } = mockFetch([
      ['POST', '/v2/video/query/', () => json({ data: { videos: [{ id: '7300000000000000001', view_count: 1200, like_count: 80, comment_count: 7, share_count: 3 }] }, error: { code: 'ok' } })],
    ]);
    const { ctx } = makeCtx(fetch, () => NOW);
    const stats = await tiktok.stats!({ ctx, account: withList, target: t('7300000000000000001') });
    assert.deepEqual(stats, { views: 1200, likes: 80, comments: 7, shares: 3 });
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get('fields'), 'id,view_count,like_count,comment_count,share_count');
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), { filters: { video_ids: ['7300000000000000001'] } });
  });

  it('explains instead of calling when the scope or a public id is missing', async () => {
    const { fetch, calls } = mockFetch([]);
    const { ctx } = makeCtx(fetch, () => NOW);
    assert.match((await tiktok.stats!({ ctx, account, target: t('7300000000000000001') })).note!, /video\.list/);
    assert.match((await tiktok.stats!({ ctx, account: withList, target: t('v_pub_file~v2-1.123') })).note!, /공개 게시물 ID/);
    assert.equal(calls.length, 0);
  });

  it('notes a video the account does not have', async () => {
    const { fetch } = mockFetch([['POST', '/v2/video/query/', () => json({ data: { videos: [] }, error: { code: 'ok' } })]]);
    const { ctx } = makeCtx(fetch, () => NOW);
    assert.match((await tiktok.stats!({ ctx, account: withList, target: t('7300000000000000002') })).note!, /찾을 수 없습니다/);
  });
});

describe('tiktok post ids', () => {
  it('keep all 19 digits (JSON numbers past 2^53 would round to another video)', async () => {
    const body = '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7412345678901234567]},"error":{"code":"ok"}}';
    const { fetch } = mockFetch([['POST', '/v2/post/publish/status/fetch/', () => new Response(body, { headers: { 'content-type': 'application/json' } })]]);
    const { ctx } = makeCtx(fetch, () => NOW);
    const t = { ...target({ mode: 'direct' }), remoteId: 'v_pub_file~1', resume: { username: 'c10e2' } };
    const out = await tiktok.poll({ ctx, post, target: t, account });
    assert.deepEqual([out.remoteId, out.remoteUrl], ['7412345678901234567', 'https://www.tiktok.com/@c10e2/video/7412345678901234567']);
  });

  it('parses everything else as JSON would, strings untouched', () => {
    assert.deepEqual(parseExactJson('{"a":[1,-2.5e3,9007199254740991],"s":"x\\" 7412345678901234567]","b":-9007199254740993}'), {
      a: [1, -2500, 9007199254740991],
      s: 'x" 7412345678901234567]',
      b: '-9007199254740993',
    });
  });
});

describe('tiktok disclosure in inbox mode', () => {
  it('says the branded label must be set in the app', () => {
    const codes = tiktok.validate(post, target({ mode: 'inbox', brandedContent: true }), fakeMedia()).map((i) => i.code);
    assert.ok(codes.includes('branded_inbox'));
    assert.ok(!tiktok.validate(post, target({ mode: 'inbox' }), fakeMedia()).some((i) => i.code === 'branded_inbox'));
  });
});
