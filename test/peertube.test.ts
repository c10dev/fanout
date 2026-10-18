import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import type { MediaInfo } from '../src/core/media.ts';
import { replyToComment, removeTarget, withTimeout } from '../src/core/posting.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { peertube, peertubeTags } from '../src/providers/peertube.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const I = 'https://pt.example';
const FAR = Date.parse('2026-10-18T03:00:00Z');
const CREDS = { instance: I, clientId: 'cid', clientSecret: 'csec', accessToken: 'AT', refreshToken: 'RT', expiresAt: FAR };
const ME = { id: 7, username: 'me', videoChannels: [{ id: 3, name: 'me_channel' }, { id: 4, name: 'second' }], videoQuota: -1, videoQuotaDaily: -1 };
const POST: PostInput = { mediaPath: '/v.mp4', title: '테스트 영상', description: '설명입니다', tags: ['vlog', 'x', 'travel'], captions: [], containsSyntheticMedia: false };
const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

function video(bytes = 10): string {
  const dir = mkdtempSync(join(tmpdir(), 'fanout-pt-'));
  const p = join(dir, 'clip.mp4');
  writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

function env(routes: Parameters<typeof mockFetch>[0], post: Partial<PostInput> = {}, options: Record<string, unknown> = { privacy: 'public' }) {
  const { fetch, calls } = mockFetch(routes);
  const e = makeCtx(fetch);
  e.store.saveAccount({ platform: 'peertube', name: 'main', credentials: { ...CREDS }, profile: { username: 'me@pt.example', userId: 7 } });
  const { post: p, targets } = e.store.createPost({ ...POST, ...post }, [{ platform: 'peertube', account: 'main', options }]);
  const account = e.store.getAccount('peertube', 'main')!;
  return { ...e, calls, post: p, target: targets[0]!, account };
}

const base: Parameters<typeof mockFetch>[0] = [
  ['GET', '/api/v1/users/me/video-quota-used', () => json({ videoQuotaUsed: 0, videoQuotaUsedDaily: 0 })],
  ['GET', '/api/v1/users/me', () => json(ME)],
  ['GET', '/api/v1/config', () => json({ serverVersion: '8.3.1', client: { videos: { resumableUpload: { maxChunkSize: 0 } } } })],
];

describe('PeerTube connect and tokens', () => {
  it('logs in with the instance client and keeps tokens, not the password', async () => {
    const { fetch, calls } = mockFetch([
      ['GET', '/api/v1/oauth-clients/local', () => json({ client_id: 'cid', client_secret: 'csec' })],
      ['POST', '/api/v1/users/token', () => json({ access_token: 'AT', refresh_token: 'RT', expires_in: 86400 })],
      ['GET', '/api/v1/users/me', () => json(ME)],
    ]);
    const { ctx } = makeCtx(fetch);
    const acct = await peertube.connect(ctx, 'main', { instance: 'pt.example', username: 'me', password: 'pw secret', otp: '123456' });
    assert.equal(calls[1]!.headers['x-peertube-otp'], '123456');
    assert.match(String(calls[1]!.body), /grant_type=password/);
    assert.equal(JSON.stringify(acct.credentials).includes('pw secret'), false);
    assert.equal((acct.credentials as typeof CREDS).instance, I);
    assert.deepEqual(acct.profile.channels, [{ id: 3, name: 'me_channel', displayName: undefined }, { id: 4, name: 'second', displayName: undefined }]);
  });

  it('asks for the 2FA code when the account needs one', async () => {
    const { fetch } = mockFetch([
      ['GET', '/api/v1/oauth-clients/local', () => json({ client_id: 'cid', client_secret: 'csec' })],
      ['POST', '/api/v1/users/token', () => json({ code: 'missing_two_factor', detail: 'Missing two factor header' }, 401)],
    ]);
    const { ctx } = makeCtx(fetch);
    await assert.rejects(peertube.connect(ctx, 'main', { instance: I, username: 'me', password: 'pw' }), /2단계 인증/);
  });

  it('a short deadline on the caller never cuts a token rotation off', async () => {
    // The server rotates the refresh token and answers after 80 ms; the stats read that started the
    // refresh gives its calls 30 ms. Aborting there would lose RT2 for good.
    const slow = (async (_url: string, init?: RequestInit) =>
      new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        setTimeout(() => resolve(json({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 86400 })), 80);
      })) as typeof fetch;
    const e = env([]);
    const ctx = withTimeout({ ...e.ctx, fetch: slow }, 30);
    const expired = { ...e.account, credentials: { ...CREDS, expiresAt: 0 } };
    e.store.saveAccount(expired);
    await peertube.refresh(ctx, expired);
    assert.equal((e.store.getAccount('peertube', 'main')!.credentials as typeof CREDS).refreshToken, 'RT2');
  });

  it('refreshes near expiry and asks to reconnect when the refresh token is gone', async () => {
    const { ctx, store, account, calls } = env([['POST', '/api/v1/users/token', () => json({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 86400 })]]);
    const soon = { ...account, credentials: { ...CREDS, expiresAt: ctx.now().getTime() + 60_000 } };
    store.saveAccount(soon);
    const next = await peertube.refresh(ctx, soon);
    assert.equal((next.credentials as typeof CREDS).accessToken, 'AT2');
    assert.match(String(calls[0]!.body), /grant_type=refresh_token&refresh_token=RT/);
    assert.equal((store.getAccount('peertube', 'main')!.credentials as typeof CREDS).refreshToken, 'RT2');

    const dead = env([['POST', '/api/v1/users/token', () => json({ code: 'invalid_grant', detail: 'Invalid grant: refresh token is invalid' }, 400)]]);
    const expired = { ...dead.account, credentials: { ...CREDS, expiresAt: 0 } };
    dead.store.saveAccount(expired);
    await assert.rejects(peertube.refresh(dead.ctx, expired), (err: ProviderError) => err.kind === 'auth');
  });
});

describe('PeerTube validation', () => {
  it('needs an explicit privacy, a 3–120 character title, and trims tags', () => {
    const { post, target } = env([], { title: 'ab', tags: ['ok', 'a', 'six', 'one', 'two', 'three', 'four'] }, {});
    const issues = peertube.validate(post, target, {} as MediaInfo);
    assert.deepEqual(issues.map((i) => i.code).sort(), ['privacy', 'tags', 'title']);
    assert.deepEqual(peertubeTags(['#ok', 'a', 'ok', 'six', 'one', 'two', 'three', 'four']), ['ok', 'six', 'one', 'two', 'three']);
  });
});

describe('PeerTube upload', () => {
  it('starts a resumable session, marks the last chunk, and returns the watch URL', async () => {
    const path = video(10);
    const { ctx, calls, post, target, account, store } = env([
      ...base,
      ['POST', '/api/v1/videos/upload-resumable', () => empty(201, { location: '/api/v1/videos/upload-resumable?upload_id=U1' })],
      ['PUT', 'upload_id=U1', () => json({ video: { id: 42, uuid: 'uu', shortUUID: 'short42' } })],
    ]);
    const saved: Array<Record<string, unknown>> = [];
    const out = await peertube.publish({ ctx, post, target, account, mediaPath: path, media: {} as MediaInfo, saveResume: (r) => (saved.push(r), store.updateTarget(target.id, { resume: r })) });
    assert.deepEqual(out, { state: 'processing', remoteId: '42', remoteUrl: `${I}/w/short42`, warnings: [] });
    const init = calls.find((c) => c.method === 'POST')!;
    assert.equal(init.headers['x-upload-content-length'], '10');
    const body = JSON.parse(String(init.body));
    assert.deepEqual({ channelId: body.channelId, privacy: body.privacy, tags: body.tags, name: body.name }, { channelId: 3, privacy: 1, tags: ['vlog', 'travel'], name: '테스트 영상' });
    const put = calls.find((c) => c.method === 'PUT')!;
    assert.equal(put.headers['content-range'], 'bytes 0-9/10');
    assert.ok(saved.some((r) => r.finalSent === true), 'last chunk marked before sending');
    assert.equal(saved.at(-1)!.videoId, 42);
  });

  it('schedules by uploading private with a scheduled privacy change, on the chosen channel', async () => {
    const path = video(5);
    const { ctx, calls, post, target, account } = env(
      [...base, ['POST', '/api/v1/videos/upload-resumable', () => empty(201, { location: `${I}/api/v1/videos/upload-resumable?upload_id=U2` })], ['PUT', 'upload_id=U2', () => json({ video: { id: 5, shortUUID: 's5' } })]],
      { scheduledAt: '2026-10-20T00:00:00Z' },
      { privacy: 'unlisted', channel: 'second', commentsPolicy: 'approval' },
    );
    await peertube.publish({ ctx, post, target, account, mediaPath: path, media: {} as MediaInfo, saveResume: () => {} });
    const body = JSON.parse(String(calls.find((c) => c.method === 'POST')!.body));
    assert.deepEqual({ channelId: body.channelId, privacy: body.privacy, scheduleUpdate: body.scheduleUpdate, commentsPolicy: body.commentsPolicy }, {
      channelId: 4,
      privacy: 3,
      scheduleUpdate: { updateAt: '2026-10-20T00:00:00.000Z', privacy: 2 },
      commentsPolicy: 3,
    });
  });

  it('resumes from the byte the server has', async () => {
    const path = video(10);
    const { ctx, calls, post, account, store, target } = env([
      ...base,
      ['PUT', 'upload_id=U3', (c) => (c.headers['content-range'] === 'bytes */10' ? empty(308, { range: 'bytes=0-5' }) : json({ video: { id: 9, shortUUID: 's9' } }))],
    ]);
    store.updateTarget(target.id, { resume: { location: `${I}/api/v1/videos/upload-resumable?upload_id=U3`, total: 10 } });
    const t = store.getTarget(target.id)!;
    const out = await peertube.publish({ ctx, post, target: t, account, mediaPath: path, media: {} as MediaInfo, saveResume: () => {} });
    assert.equal(out.remoteId, '9');
    assert.equal(calls.filter((c) => c.method === 'PUT').at(-1)!.headers['content-range'], 'bytes 6-9/10');
    assert.equal(calls.some((c) => c.method === 'POST'), false, 'no new session');
  });

  it('a vanished session after the last chunk stops as maybe posted', async () => {
    const path = video(10);
    const { ctx, post, account, store, target } = env([['PUT', 'upload_id=U4', () => json({ detail: 'Upload not found' }, 404)]]);
    store.updateTarget(target.id, { resume: { location: `${I}/api/v1/videos/upload-resumable?upload_id=U4`, total: 10, finalSent: true } });
    await assert.rejects(
      peertube.publish({ ctx, post, target: store.getTarget(target.id)!, account, mediaPath: path, media: {} as MediaInfo, saveResume: () => {} }),
      (err: ProviderError) => err.code === 'peertube.maybe_posted' && err.keepResume,
    );
  });

  it('a vanished session before the last chunk starts over', async () => {
    const path = video(10);
    const { ctx, calls, post, account, store, target } = env([
      ...base,
      ['PUT', 'upload_id=OLD', () => json({ detail: 'Upload not found' }, 404)],
      ['POST', '/api/v1/videos/upload-resumable', () => empty(201, { location: '/api/v1/videos/upload-resumable?upload_id=NEW' })],
      ['PUT', 'upload_id=NEW', () => json({ video: { id: 11, shortUUID: 's11' } })],
    ]);
    store.updateTarget(target.id, { resume: { location: `${I}/api/v1/videos/upload-resumable?upload_id=OLD`, total: 10 } });
    const out = await peertube.publish({ ctx, post, target: store.getTarget(target.id)!, account, mediaPath: path, media: {} as MediaInfo, saveResume: () => {} });
    assert.equal(out.remoteId, '11');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  });

  it('refuses when the storage quota is short', async () => {
    const path = video(10);
    const { ctx, post, target, account } = env([
      ['GET', '/api/v1/users/me/video-quota-used', () => json({ videoQuotaUsed: 95, videoQuotaUsedDaily: 0 })],
      ['GET', '/api/v1/users/me', () => json({ ...ME, videoQuota: 100 })],
    ]);
    await assert.rejects(peertube.publish({ ctx, post, target, account, mediaPath: path, media: {} as MediaInfo, saveResume: () => {} }), /저장 용량/);
  });
});

describe('PeerTube after upload', () => {
  function published(routes: Parameters<typeof mockFetch>[0], resume: Record<string, unknown> = { videoId: 42, shortUUID: 's42', extrasDone: true, instance: I, userId: 7 }) {
    const e = env(routes);
    e.store.transition(e.target.id, 'uploading');
    e.store.transition(e.target.id, 'processing', { remoteId: '42', remoteUrl: `${I}/w/s42`, resume });
    return e;
  }

  it('polls until published and fails on transcoding errors without losing the video', async () => {
    let state = 2;
    const { ctx, post, account, store, target } = published([['GET', '/api/v1/videos/42', () => json({ state: { id: state }, shortUUID: 's42' })]]);
    const t = store.getTarget(target.id)! as typeof target & { remoteId: string };
    assert.equal((await peertube.poll({ ctx, post, target: t, account })).state, 'processing');
    state = 1;
    assert.equal((await peertube.poll({ ctx, post, target: t, account })).state, 'published');
    state = 7;
    await assert.rejects(peertube.poll({ ctx, post, target: t, account }), (err: ProviderError) => err.kind === 'rejected' && err.keepResume);
  });

  it('removes only its own videos, and reads stats, comments and replies', async () => {
    const own = published([
      ['GET', '/api/v1/videos/42/comment-threads', () => json({ data: [{ id: 501, text: '<p>좋아요 &amp; 감사</p>', createdAt: '2026-10-17T01:00:00Z', totalReplies: 0, account: { name: 'fan', host: 'other.example' } }, { id: 502, isDeleted: true, createdAt: '2026-10-17T00:00:00Z' }] })],
      ['POST', '/api/v1/videos/42/comments/501', () => json({ comment: { id: 900 } })],
      ['GET', '/api/v1/videos/42', () => json({ views: 12, likes: 3, dislikes: 1, comments: 2 })],
      ['DELETE', '/api/v1/videos/42', () => empty(204)],
    ]);
    own.store.transition(own.target.id, 'published');
    const t = own.store.getTarget(own.target.id)! as typeof own.target & { remoteId: string };
    assert.deepEqual(await peertube.stats!({ ctx: own.ctx, account: own.account, target: t }), { views: 12, likes: 3, comments: 2, note: '싫어요 1' });
    const comments = await peertube.comments!({ ctx: own.ctx, account: own.account, target: t, limit: 20 });
    assert.deepEqual(comments.map((c) => [c.id, c.author, c.text]), [['501', '@fan@other.example', '좋아요 & 감사']]);
    assert.equal((await replyToComment(own.ctx, providerMap(), t.id, '501', '고마워요')).id, '900');
    assert.equal((await removeTarget(own.ctx, providerMap(), t.id)).state, 'removed');

    const other = published([], { videoId: 42, instance: 'https://old.example', userId: 7 });
    other.store.transition(other.target.id, 'published');
    await assert.rejects(removeTarget(other.ctx, providerMap(), other.target.id), /old\.example/);
    assert.equal(other.calls.length, 0);
  });
});

describe('PeerTube review fixes', () => {
  const session = (id: string, extra: Record<string, unknown> = {}) => ({ location: `${I}/api/v1/videos/upload-resumable?upload_id=${id}`, total: 10, instance: I, userId: 7, channelId: 3, startedAt: '2026-10-17T02:59:00Z', ...extra });

  it('edits a post without a description by sending null, not an empty string', async () => {
    const e = env([['PUT', '/api/v1/videos/42', () => empty(204)]], { description: '' });
    e.store.transition(e.target.id, 'uploading');
    e.store.transition(e.target.id, 'published', { remoteId: '42', resume: { videoId: 42, instance: I, userId: 7 } });
    const t = e.store.getTarget(e.target.id)! as typeof e.target & { remoteId: string };
    await peertube.update!({ ctx: e.ctx, account: e.account, target: t, post: e.post });
    assert.equal(JSON.parse(String(e.calls[0]!.body)).description, null);
  });

  it('a refused last chunk clears the session so the next try starts clean', async () => {
    const path = video(10);
    const e = env([
      ...base,
      ['POST', '/api/v1/videos/upload-resumable', () => empty(201, { location: '/api/v1/videos/upload-resumable?upload_id=BAD' })],
      ['PUT', 'upload_id=BAD', () => json({ detail: 'Video file unreadable.' }, 400)],
    ]);
    const saved: Array<Record<string, unknown>> = [];
    await assert.rejects(peertube.publish({ ctx: e.ctx, post: e.post, target: e.target, account: e.account, mediaPath: path, media: {} as MediaInfo, saveResume: (r) => saved.push(r) }));
    assert.equal(saved.at(-1)!.finalSent, undefined);
    assert.equal(saved.at(-1)!.location, undefined);
  });

  it('after a lost last-chunk answer, adopts the video it made', async () => {
    const path = video(10);
    const e = env([
      // uploadx answers with an error object, not the REST API's problem+json.
      ['PUT', 'upload_id=DONE', () => json({ error: { code: 'FileNotFound', message: 'Not found' } }, 404)],
      [
        'GET',
        '/api/v1/users/me/videos',
        () => json({ data: [{ id: 77, shortUUID: 's77', name: '테스트 영상', createdAt: '2026-10-17T02:59:30Z', channel: { id: 3 } }, { id: 70, name: '테스트 영상', createdAt: '2026-10-10T00:00:00Z', channel: { id: 3 } }] }),
      ],
    ]);
    e.store.updateTarget(e.target.id, { resume: session('DONE', { finalSent: true }) });
    const out = await peertube.publish({ ctx: e.ctx, post: e.post, target: e.store.getTarget(e.target.id)!, account: e.account, mediaPath: path, media: {} as MediaInfo, saveResume: () => {} });
    assert.equal(out.remoteId, '77');
    assert.equal(e.calls.some((c) => c.method === 'POST'), false, 'not uploaded again');
  });

  it('after a lost last-chunk answer with no such video, starts over', async () => {
    const path = video(10);
    const e = env([
      ...base.filter(([, u]) => u !== '/api/v1/users/me'),
      ['PUT', 'upload_id=DONE', () => json({ detail: 'Upload not found' }, 404)],
      ['GET', '/api/v1/users/me/videos', () => json({ data: [] })],
      ['GET', '/api/v1/users/me', () => json(ME)],
      ['POST', '/api/v1/videos/upload-resumable', () => empty(201, { location: '/api/v1/videos/upload-resumable?upload_id=NEW2' })],
      ['PUT', 'upload_id=NEW2', () => json({ video: { id: 78, shortUUID: 's78' } })],
    ]);
    e.store.updateTarget(e.target.id, { resume: session('DONE', { finalSent: true }) });
    const out = await peertube.publish({ ctx: e.ctx, post: e.post, target: e.store.getTarget(e.target.id)!, account: e.account, mediaPath: path, media: {} as MediaInfo, saveResume: () => {} });
    assert.equal(out.remoteId, '78');
  });

  it('a token revoked mid-upload is renewed and the chunk sent again', async () => {
    const path = video(10);
    const tokens: string[] = [];
    const e = env([
      ['POST', '/api/v1/users/token', () => json({ access_token: 'AT-NEW', refresh_token: 'RT-NEW', expires_in: 86400 })],
      ['PUT', 'upload_id=U5', (c) => (tokens.push(c.headers.authorization!), c.headers.authorization === 'Bearer AT' ? json({ code: 'invalid_token' }, 401) : json({ video: { id: 5, shortUUID: 's5' } }))],
    ]);
    e.store.updateTarget(e.target.id, { resume: session('U5') });
    // The status query is the first PUT: it gets the 401, then the renewed token.
    const out = await peertube.publish({ ctx: e.ctx, post: e.post, target: e.store.getTarget(e.target.id)!, account: e.account, mediaPath: path, media: {} as MediaInfo, saveResume: () => {} });
    assert.equal(out.remoteId, '5');
    assert.deepEqual(tokens, ['Bearer AT', 'Bearer AT-NEW']);
    assert.equal((e.store.getAccount('peertube', 'main')!.credentials as typeof CREDS).accessToken, 'AT-NEW');
  });

  it('never reads stats or comments of another instance’s video with the same id', async () => {
    const e = env([]);
    e.store.transition(e.target.id, 'uploading');
    e.store.transition(e.target.id, 'published', { remoteId: '42', resume: { videoId: 42, instance: 'https://old.example', userId: 7 } });
    const t = e.store.getTarget(e.target.id)! as typeof e.target & { remoteId: string };
    await assert.rejects(peertube.stats!({ ctx: e.ctx, account: e.account, target: t }), /old\.example/);
    await assert.rejects(peertube.comments!({ ctx: e.ctx, account: e.account, target: t, limit: 5 }), /old\.example/);
    assert.equal(e.calls.length, 0);
  });

  it('counts emoji as one character, like the server', () => {
    const { post, target } = env([], { title: '🎬'.repeat(65), tags: ['🎬'.repeat(16)] });
    assert.deepEqual(peertube.validate(post, target, {} as MediaInfo).map((i) => i.code), []);
  });
});

describe('PeerTube seventh review fixes', () => {
  const session = (id: string, extra: Record<string, unknown> = {}) => ({ location: `${I}/api/v1/videos/upload-resumable?upload_id=${id}`, total: 10, instance: I, userId: 7, channelId: 3, startedAt: '2026-10-17T02:59:00Z', finalSent: true, ...extra });
  const gone = (): [string, string, () => Response] => ['PUT', 'upload_id=S', () => json({ error: { code: 'FileNotFound' } }, 404)];
  const list = (data: unknown[]): [string, string, () => Response] => ['GET', '/api/v1/users/me/videos', () => json({ data })];
  const run = async (e: ReturnType<typeof env>) =>
    peertube.publish({ ctx: e.ctx, post: e.post, target: e.store.getTarget(e.target.id)!, account: e.account, mediaPath: video(10), media: {} as MediaInfo, saveResume: () => {} });

  it('two look-alike videos since the session: stops instead of guessing', async () => {
    const e = env([gone(), list([{ id: 90, name: '테스트 영상', createdAt: '2026-10-17T03:05:00Z', channel: { id: 3 } }, { id: 77, name: '테스트 영상', createdAt: '2026-10-17T02:59:30Z', channel: { id: 3 } }])]);
    e.store.updateTarget(e.target.id, { resume: session('S') });
    await assert.rejects(run(e), (err: ProviderError) => err.code === 'peertube.maybe_posted');
    assert.equal(e.calls.some((c) => c.method === 'PUT' && c.url.includes('/videos/9')), false, 'nothing written to either video');
  });

  it('skips a video another target already owns', async () => {
    const e = env([gone(), list([{ id: 90, shortUUID: 's90', name: '테스트 영상', createdAt: '2026-10-17T03:05:00Z', channel: { id: 3 } }, { id: 77, name: '테스트 영상', createdAt: '2026-10-17T02:59:30Z', channel: { id: 3 } }])]);
    const { targets } = e.store.createPost(POST, [{ platform: 'peertube', account: 'main', options: { privacy: 'public' } }]);
    e.store.transition(targets[0]!.id, 'uploading');
    e.store.transition(targets[0]!.id, 'published', { remoteId: '77' });
    e.store.updateTarget(e.target.id, { resume: session('S') });
    assert.equal((await run(e)).remoteId, '90');
  });

  it('times the session by the server clock', async () => {
    const path = video(10);
    const e = env([
      ...base,
      // The server runs two minutes behind fanout's clock (2026-10-17T03:00:00Z).
      ['POST', '/api/v1/videos/upload-resumable', () => empty(201, { location: '/api/v1/videos/upload-resumable?upload_id=SK', date: 'Sat, 17 Oct 2026 02:58:00 GMT' })],
      ['PUT', 'upload_id=SK', () => json({ video: { id: 1, shortUUID: 's1' } })],
    ]);
    const saved: Array<Record<string, unknown>> = [];
    await peertube.publish({ ctx: e.ctx, post: e.post, target: e.target, account: e.account, mediaPath: path, media: {} as MediaInfo, saveResume: (r) => saved.push(r) });
    assert.equal(saved.find((r) => r.startedAt)!.startedAt, '2026-10-17T02:58:00.000Z');
  });

  it('a throttled last chunk keeps the session for the retry', async () => {
    const path = video(10);
    const e = env([...base, ['POST', '/api/v1/videos/upload-resumable', () => empty(201, { location: '/api/v1/videos/upload-resumable?upload_id=T' })], ['PUT', 'upload_id=T', () => json({ detail: 'Too many requests' }, 429)]]);
    const saved: Array<Record<string, unknown>> = [];
    await assert.rejects(peertube.publish({ ctx: e.ctx, post: e.post, target: e.target, account: e.account, mediaPath: path, media: {} as MediaInfo, saveResume: (r) => saved.push(r) }));
    assert.ok(saved.at(-1)!.location && saved.at(-1)!.finalSent);
  });

  it('a refresh token another process already used: take the pair it stored', async () => {
    const e = env([
      [
        'POST',
        '/api/v1/users/token',
        () => {
          // The other process wins the race and stores its new pair before our request is answered.
          e.store.saveAccount({ ...e.account, credentials: { ...CREDS, accessToken: 'AT-OTHER', refreshToken: 'RT-OTHER', expiresAt: FAR } });
          return json({ code: 'invalid_grant' }, 400);
        },
      ],
    ]);
    const expired = { ...e.account, credentials: { ...CREDS, expiresAt: 0 } };
    e.store.saveAccount(expired);
    const next = await peertube.refresh(e.ctx, expired);
    assert.equal((next.credentials as typeof CREDS).accessToken, 'AT-OTHER');
  });
});

describe('PeerTube video ids are per instance', () => {
  it('a target of another account with the same id does not hide our video', async () => {
    const e = env([
      ['PUT', 'upload_id=S', () => json({ error: { code: 'FileNotFound' } }, 404)],
      ['GET', '/api/v1/users/me/videos', () => json({ data: [{ id: 90, shortUUID: 's90', name: '테스트 영상', createdAt: '2026-10-17T02:59:30Z', channel: { id: 3 } }] })],
    ]);
    const { targets } = e.store.createPost(POST, [{ platform: 'peertube', account: 'alt', options: { privacy: 'public' } }]);
    e.store.transition(targets[0]!.id, 'uploading');
    e.store.transition(targets[0]!.id, 'published', { remoteId: '90' });
    e.store.updateTarget(e.target.id, { resume: { location: `${I}/api/v1/videos/upload-resumable?upload_id=S`, total: 10, instance: I, userId: 7, channelId: 3, startedAt: '2026-10-17T02:59:00Z', finalSent: true } });
    const out = await peertube.publish({ ctx: e.ctx, post: e.post, target: e.store.getTarget(e.target.id)!, account: e.account, mediaPath: video(10), media: {} as MediaInfo, saveResume: () => {} });
    assert.equal(out.remoteId, '90');
  });
});
