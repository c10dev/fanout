import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import type { Account } from '../src/core/store.ts';
import type { Post, Target } from '../src/core/types.ts';
import { withTimeout } from '../src/core/posting.ts';
import { bluesky, facets, graphemes, httpsOnly, jwtExpiry, postText } from '../src/providers/bluesky.ts';
import { fakeMedia, json, makeCtx, mockFetch, slowFetch, tempFile } from './helpers.ts';

const NOW = new Date('2026-10-17T03:00:00Z');
const jwt = (expMs: number) => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString('base64url')}.s`;
const PDS = 'https://morel.us-east.host.bsky.network';
const account: Account = {
  platform: 'bluesky',
  name: 'main',
  credentials: { pds: PDS, did: 'did:plc:abc', handle: 'me.bsky.social', accessJwt: jwt(NOW.getTime() + 3600_000), refreshJwt: jwt(NOW.getTime() + 60 * 86400_000) },
  profile: {},
};
const post = (o: Partial<Post> = {}): Post => ({ id: 'p', createdAt: '', mediaPath: '/v.mp4', title: '첫 영상', description: '설명', tags: ['브이로그', 'fanout'], captions: [], containsSyntheticMedia: false, ...o });
const target = (options: Record<string, unknown> = {}, resume?: Record<string, unknown>): Target => ({ id: 't', postId: 'p', platform: 'bluesky', account: 'main', options, state: 'uploading', warnings: [], attempts: 1, updatedAt: '', resume });

describe('bluesky text', () => {
  it('sends session tokens only over https (or to a local test server)', () => {
    assert.equal(httpsOnly('https://pds.example'), 'https://pds.example');
    assert.equal(httpsOnly('http://localhost:2583'), 'http://localhost:2583');
    assert.throws(() => httpsOnly('http://pds.example'), /https/);
    assert.throws(() => httpsOnly('not a url'), /올바르지 않습니다/);
  });

  it('counts graphemes, not code units', () => {
    assert.equal(graphemes('👍🏽한글'), 3);
  });

  it('drops the description when the full text is too long', () => {
    assert.equal(postText(post(), {}), '첫 영상\n\n설명\n\n#브이로그 #fanout');
    assert.equal(postText(post({ description: 'x'.repeat(400) }), {}), '첫 영상\n\n#브이로그 #fanout');
  });

  it('builds hashtag and link facets with UTF-8 byte offsets', () => {
    const text = '한글 #브이로그 https://x.dev';
    const [tag, link] = facets(text) as Array<{ index: { byteStart: number; byteEnd: number }; features: Array<Record<string, string>> }>;
    assert.equal(Buffer.from(text).subarray(tag!.index.byteStart, tag!.index.byteEnd).toString(), '#브이로그');
    assert.equal(tag!.features[0]!.tag, '브이로그');
    assert.equal(Buffer.from(text).subarray(link!.index.byteStart, link!.index.byteEnd).toString(), 'https://x.dev');
  });

  it('rejects text over 300 graphemes', () => {
    const issues = bluesky.validate(post(), target({ text: 'ㄱ'.repeat(301) }), fakeMedia());
    assert.ok(issues.some((i) => i.code === 'text' && i.severity === 'error'));
  });

  it('reads JWT expiry', () => {
    assert.equal(jwtExpiry(jwt(NOW.getTime())), Math.floor(NOW.getTime() / 1000) * 1000);
    assert.equal(jwtExpiry('garbage'), 0);
  });
});

describe('bluesky connect and refresh', () => {
  it('signs in with an app password and keeps the PDS from the DID document', async () => {
    const { fetch, calls } = mockFetch([
      ['POST', 'com.atproto.server.createSession', () => json({ did: 'did:plc:abc', handle: 'me.bsky.social', accessJwt: 'A', refreshJwt: 'R', didDoc: { service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] } })],
    ]);
    const { ctx } = makeCtx(fetch, () => NOW);
    const acct = await bluesky.connect(ctx, 'main', { handle: '@me.bsky.social', token: 'app-pass' });
    assert.equal((acct.credentials as { pds: string }).pds, PDS);
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), { identifier: 'me.bsky.social', password: 'app-pass' });
    assert.ok(!JSON.stringify(acct).includes('app-pass'), 'never stores the app password');
  });

  it('refreshes an expiring session and reports an expired one as needing reconnection', async () => {
    const ok = mockFetch([['POST', 'com.atproto.server.refreshSession', () => json({ accessJwt: 'A2', refreshJwt: 'R2', handle: 'me.bsky.social' })]]);
    const env = makeCtx(ok.fetch, () => NOW);
    const expiring = { ...account, credentials: { ...account.credentials, accessJwt: jwt(NOW.getTime() + 60_000) } };
    const next = await bluesky.refresh(env.ctx, expiring);
    assert.equal((next.credentials as { accessJwt: string }).accessJwt, 'A2');
    assert.equal(ok.calls[0]!.headers.authorization, `Bearer ${(account.credentials as { refreshJwt: string }).refreshJwt}`);

    const bad = mockFetch([['POST', 'com.atproto.server.refreshSession', () => json({ error: 'ExpiredToken', message: 'Token has expired' }, 400)]]);
    const env2 = makeCtx(bad.fetch, () => NOW);
    await assert.rejects(bluesky.refresh(env2.ctx, expiring), (e: ProviderError) => e.kind === 'auth' && e.code === 'bluesky.session_expired');
  });

  it('a short deadline on the caller never cuts the session refresh off', async () => {
    const expiring = { ...account, credentials: { ...account.credentials, accessJwt: jwt(NOW.getTime() + 60_000) } };
    const env = makeCtx(slowFetch({ accessJwt: 'A2', refreshJwt: 'R2', handle: 'me.bsky.social' }, 80), () => NOW);
    env.store.saveAccount(expiring);
    await bluesky.refresh(withTimeout(env.ctx, 30), expiring);
    assert.equal((env.store.getAccount('bluesky', expiring.name)!.credentials as { refreshJwt: string }).refreshJwt, 'R2');
  });

  it('never refreshes against a plain-http server, and keeps new tokens when the DID document points to one', async () => {
    const expiring = { ...account, credentials: { ...account.credentials, accessJwt: jwt(NOW.getTime() + 60_000) } };
    const none = mockFetch([]);
    const old = { ...expiring, credentials: { ...expiring.credentials, pds: 'http://pds.lan:3000' } };
    await assert.rejects(bluesky.refresh(makeCtx(none.fetch, () => NOW).ctx, old), (e: ProviderError) => e.kind === 'auth' && e.code === 'bluesky.insecure');
    assert.equal(none.calls.length, 0, 'the refresh token never went out');

    const didDoc = { service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'http://evil.example' }] };
    const ok = mockFetch([['POST', 'com.atproto.server.refreshSession', () => json({ accessJwt: 'A2', refreshJwt: 'R2', handle: 'me.bsky.social', didDoc })]]);
    const env = makeCtx(ok.fetch, () => NOW);
    env.store.saveAccount(expiring);
    const next = await bluesky.refresh(env.ctx, expiring);
    const saved = env.store.getAccount('bluesky', expiring.name)!.credentials as { pds: string; refreshJwt: string };
    assert.deepEqual([saved.pds, saved.refreshJwt], [(account.credentials as { pds: string }).pds, 'R2']);
    assert.equal((next.credentials as { pds: string }).pds, saved.pds);
    assert.ok(env.logs.some((l) => l.includes('https')));
  });
});

describe('bluesky upload', () => {
  const routes = (upload: () => Response) =>
    mockFetch([
      ['GET', 'com.atproto.server.getServiceAuth', (c) => json({ token: `svc-${new URL(c.url).searchParams.get('lxm')}` })],
      ['GET', 'app.bsky.video.getUploadLimits', () => json({ canUpload: true, remainingDailyVideos: 25, remainingDailyBytes: 10e9 })],
      ['POST', 'app.bsky.video.uploadVideo', upload],
    ]);

  it('uploads to the video service with a PDS-audience service token', async () => {
    const file = tempFile(2048);
    const { fetch, calls } = routes(() => json({ jobId: 'job1', did: 'did:plc:abc', state: 'JOB_STATE_CREATED' }));
    const { ctx } = makeCtx(fetch, () => NOW);
    const saved: Array<Record<string, unknown>> = [];
    const out = await bluesky.publish({ ctx, post: post(), target: target(), account, mediaPath: file, media: fakeMedia({}, { width: 1080, height: 1920 }), saveResume: (r) => saved.push(r) });
    assert.deepEqual([out.state, out.remoteId], ['processing', 'job1']);
    const auth = calls.filter((c) => c.url.includes('getServiceAuth')).map((c) => Object.fromEntries(new URL(c.url).searchParams));
    assert.equal(auth[0]!.aud, 'did:web:video.bsky.app');
    assert.equal(auth[1]!.aud, 'did:web:morel.us-east.host.bsky.network');
    assert.equal(auth[1]!.lxm, 'com.atproto.repo.uploadBlob');
    const up = calls.find((c) => c.url.includes('uploadVideo'))!;
    assert.equal(new URL(up.url).searchParams.get('did'), 'did:plc:abc');
    assert.equal(up.headers.authorization, 'Bearer svc-com.atproto.repo.uploadBlob');
    assert.equal(up.headers['content-type'], 'video/mp4');
    assert.deepEqual(saved[0], { jobId: 'job1', width: 1080, height: 1920 });
  });

  it('reuses the job of an already-processed file', async () => {
    const { fetch } = routes(() => json({ error: 'already_exists', message: 'already processed', jobId: 'job0', state: 'JOB_STATE_COMPLETED' }, 409));
    const { ctx } = makeCtx(fetch, () => NOW);
    const out = await bluesky.publish({ ctx, post: post(), target: target(), account, mediaPath: tempFile(10), media: fakeMedia(), saveResume: () => {} });
    assert.equal(out.remoteId, 'job0');
  });

  it('refuses when the daily video limit is used up', async () => {
    const { fetch } = mockFetch([
      ['GET', 'getServiceAuth', () => json({ token: 't' })],
      ['GET', 'getUploadLimits', () => json({ canUpload: false, message: 'daily limit reached' })],
    ]);
    const { ctx } = makeCtx(fetch, () => NOW);
    await assert.rejects(
      bluesky.publish({ ctx, post: post(), target: target(), account, mediaPath: tempFile(10), media: fakeMedia(), saveResume: () => {} }),
      (e: ProviderError) => e.code === 'bluesky.upload_limit' && /daily limit/.test(e.message),
    );
  });

  it('waits for the blob, then posts with facets, aspect ratio and VTT captions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fanout-bsky-'));
    writeFileSync(join(dir, 'ko.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\n안녕\n');
    writeFileSync(join(dir, 'en.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
    let blobReady = false;
    const blob = { $type: 'blob', ref: { $link: 'bafy' }, mimeType: 'video/mp4', size: 2048 };
    const { fetch, calls } = mockFetch([
      ['GET', 'app.bsky.video.getJobStatus', () => json({ jobStatus: blobReady ? { jobId: 'job1', state: 'JOB_STATE_COMPLETED', blob } : { jobId: 'job1', state: 'JOB_STATE_ENCODING', progress: 40 } })],
      ['POST', 'com.atproto.repo.uploadBlob', () => json({ blob: { $type: 'blob', ref: { $link: 'vtt' }, mimeType: 'text/vtt', size: 40 } })],
      ['POST', 'com.atproto.repo.createRecord', () => json({ uri: 'at://did:plc:abc/app.bsky.feed.post/3kabc', cid: 'c' })],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    const { targets } = store.createPost(post(), [{ platform: 'bluesky', account: 'main', options: { alt: '테스트', langs: ['ko'] } }]);
    const t = { ...store.getTarget(targets[0]!.id)!, remoteId: 'job1', resume: { jobId: 'job1', width: 1080, height: 1920 } };
    const p = post({ captions: [{ language: 'ko', path: join(dir, 'ko.vtt') }, { language: 'en', path: join(dir, 'en.srt') }] });

    assert.equal((await bluesky.poll({ ctx, post: p, target: t, account })).state, 'processing');
    blobReady = true;
    const out = await bluesky.poll({ ctx, post: p, target: t, account });
    assert.equal(out.state, 'published');
    assert.equal(out.remoteUrl, 'https://bsky.app/profile/me.bsky.social/post/3kabc');
    assert.ok(out.warnings?.some((w) => w.includes('en.srt')), 'non-VTT captions are skipped with a warning');

    const record = (JSON.parse(String(calls.find((c) => c.url.includes('createRecord'))!.body)) as { repo: string; record: Record<string, any> });
    assert.equal(record.repo, 'did:plc:abc');
    assert.equal(record.record.text, '첫 영상\n\n설명\n\n#브이로그 #fanout');
    assert.equal(record.record.facets.length, 2);
    assert.deepEqual(record.record.langs, ['ko']);
    assert.deepEqual(record.record.embed.aspectRatio, { width: 1080, height: 1920 });
    assert.equal(record.record.embed.alt, '테스트');
    assert.deepEqual(record.record.embed.captions, [{ lang: 'ko', file: { $type: 'blob', ref: { $link: 'vtt' }, mimeType: 'text/vtt', size: 40 } }]);
    assert.equal((store.getTarget(t.id)!.resume as { postUri: string }).postUri, 'at://did:plc:abc/app.bsky.feed.post/3kabc', 'remembered so a retry never double-posts');
  });

  it('fails when processing fails without a blob', async () => {
    const { fetch } = mockFetch([['GET', 'getJobStatus', () => json({ jobStatus: { jobId: 'j', state: 'JOB_STATE_FAILED', failureCode: 'encoding_failure', message: 'bad codec' } })]]);
    const { ctx } = makeCtx(fetch, () => NOW);
    await assert.rejects(
      bluesky.poll({ ctx, post: post(), target: { ...target({}, { jobId: 'j' }), remoteId: 'j' }, account }),
      (e: ProviderError) => e.kind === 'rejected' && e.platformCode === 'encoding_failure',
    );
  });
});
