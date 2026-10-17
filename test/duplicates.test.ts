import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import type { Provider } from '../src/core/provider.ts';
import { step, type RunnerDeps } from '../src/core/runner.ts';
import type { Account } from '../src/core/store.ts';
import type { Post, PostInput, Target } from '../src/core/types.ts';
import { bluesky } from '../src/providers/bluesky.ts';
import { facebook } from '../src/providers/facebook.ts';
import { tiktok } from '../src/providers/tiktok.ts';
import { youtube } from '../src/providers/youtube.ts';
import { fakeMedia, json, makeCtx, mockFetch, tempFile } from './helpers.ts';

const NOW = new Date('2026-10-17T03:00:00Z');
const post = (o: Partial<Post> = {}): Post => ({ id: 'p', createdAt: '', mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false, ...o });

describe('Bluesky: a lost createRecord response never posts twice', () => {
  const account: Account = {
    platform: 'bluesky', name: 'main', profile: {},
    credentials: { pds: 'https://pds.example', did: 'did:plc:a', handle: 'me.bsky.social', accessJwt: 'x', refreshJwt: 'y' },
  };
  const blob = { $type: 'blob', ref: { $link: 'b' }, mimeType: 'video/mp4', size: 1 };

  it('fixes the record key before creating, then finds the existing post on retry', async () => {
    let created = 0;
    let exists = false;
    const { fetch, calls } = mockFetch([
      ['GET', 'getJobStatus', () => json({ jobStatus: { jobId: 'j', state: 'JOB_STATE_COMPLETED', blob } })],
      ['GET', 'com.atproto.repo.getRecord', () => (exists ? json({ uri: 'at://did:plc:a/app.bsky.feed.post/KEY', value: {} }) : json({ error: 'RecordNotFound', message: 'not found' }, 400))],
      ['POST', 'com.atproto.repo.createRecord', (c) => {
        created++;
        exists = true;
        assert.ok(JSON.parse(String(c.body)).rkey, 'rkey sent');
        return json({ error: 'InternalServerError' }, 502); // committed, but the response is lost
      }],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    const { targets } = store.createPost(post(), [{ platform: 'bluesky', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    const t = () => ({ ...store.getTarget(id)!, remoteId: 'j', resume: store.getTarget(id)!.resume ?? { jobId: 'j' } });
    await assert.rejects(bluesky.poll({ ctx, post: post(), target: t(), account }), (e: ProviderError) => e.kind === 'retryable');
    const rkey = (store.getTarget(id)!.resume as { rkey: string }).rkey;
    assert.match(rkey, /^[2-7a-z]{13}$/, 'rkey saved before the call');

    const out = await bluesky.poll({ ctx, post: post(), target: t(), account });
    assert.equal(out.state, 'published');
    assert.equal(created, 1, 'no second createRecord');
    const lookup = calls.filter((c) => c.url.includes('getRecord')).at(-1)!;
    assert.equal(new URL(lookup.url).searchParams.get('rkey'), rkey);
  });
});

describe('Facebook: a lost finish response never publishes a second Reel', () => {
  const account: Account = { platform: 'facebook', name: 'main', credentials: { pageId: 'PAGE', pageToken: 'PT' }, profile: {} };
  const tgt = (resume: Record<string, unknown>): Target => ({ id: 't', postId: 'p', platform: 'facebook', account: 'main', options: {}, state: 'uploading', warnings: [], attempts: 2, updatedAt: '', resume });
  const run = async (status: Record<string, unknown>) => {
    const { fetch, calls } = mockFetch([
      ['GET', '/V1?', () => json({ status })],
      ['POST', '/PAGE/video_reels', (c) => (new URLSearchParams(String(c.body)).get('upload_phase') === 'start' ? json({ video_id: 'V2', upload_url: 'https://rupload.facebook.com/video-upload/v24.0/V2' }) : json({ success: true }))],
      ['POST', 'rupload.facebook.com', () => json({ success: true })],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    const out = await facebook.publish({ ctx, post: post(), target: tgt({ videoId: 'V1', finished: false }), account, mediaPath: tempFile(10), media: fakeMedia(), saveResume: () => {} });
    const phases = calls.filter((c) => c.url.includes('/video_reels')).map((c) => new URLSearchParams(String(c.body)).get('upload_phase'));
    return { out, phases };
  };

  it('treats a video already publishing as finished', async () => {
    const { out, phases } = await run({ uploading_phase: { status: 'complete' }, processing_phase: { status: 'in_progress' }, publishing_phase: { status: 'not_started' } });
    assert.deepEqual([out.remoteId, phases], ['V1', []]);
  });

  it('finishes the same video when only the finish call is missing', async () => {
    const { out, phases } = await run({ uploading_phase: { status: 'complete' }, processing_phase: { status: 'not_started' }, publishing_phase: { status: 'not_started' } });
    assert.deepEqual([out.remoteId, phases], ['V1', ['finish']]);
  });

  it('starts over only when the old video never got its bytes', async () => {
    const { out, phases } = await run({ uploading_phase: { status: 'in_progress' }, processing_phase: { status: 'not_started' }, publishing_phase: { status: 'not_started' } });
    assert.deepEqual([out.remoteId, phases], ['V2', ['start', 'finish']]);
  });
});

describe('TikTok: no fresh init once the final chunk was sent', () => {
  const account: Account = { platform: 'tiktok', name: 'main', profile: {}, credentials: { accessToken: 'A', refreshToken: 'R', expiresAt: NOW.getTime() + 3600_000, refreshExpiresAt: 0, openId: 'o', scope: '' } };

  it('marks finalSent before the last chunk and resumes into status polling', async () => {
    const saved: Array<Record<string, unknown>> = [];
    let lastChunkSawMarker = false;
    const { fetch } = mockFetch([
      ['POST', '/inbox/video/init/', () => json({ data: { publish_id: 'P1', upload_url: 'https://up.tiktok.example/u' }, error: { code: 'ok' } })],
      ['PUT', 'up.tiktok.example', () => {
        lastChunkSawMarker = saved.some((r) => r.finalSent);
        throw new TypeError('fetch failed'); // response lost after TikTok got the bytes
      }],
    ]);
    const { ctx } = makeCtx(fetch, () => NOW);
    const t: Target = { id: 't', postId: 'p', platform: 'tiktok', account: 'main', options: { mode: 'inbox' }, state: 'uploading', warnings: [], attempts: 1, updatedAt: '' };
    await assert.rejects(tiktok.publish({ ctx, post: post(), target: t, account, mediaPath: tempFile(100), media: fakeMedia(), saveResume: (r) => saved.push(r) }));
    assert.ok(lastChunkSawMarker);
    const again = await tiktok.publish({ ctx, post: post(), target: { ...t, resume: saved.at(-1) }, account, mediaPath: tempFile(100), media: fakeMedia(), saveResume: () => {} });
    assert.deepEqual([again.state, again.remoteId], ['processing', 'P1']);
  });
});

describe('runner: retry after a platform-side failure starts over', () => {
  const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };
  const fake = (err: ProviderError): Provider => ({
    id: 'fake', displayName: 'F', spec: {}, appFields: [], connectMethod: 'token',
    capabilities: { nativeSchedule: false, thumbnail: false, captions: false, syntheticMediaFlag: false },
    setupGuide: () => '', connect: async () => { throw new Error('n/a'); }, refresh: async (_c, a) => a, validate: () => [],
    publish: async () => ({ state: 'processing', remoteId: 'R' }), poll: async () => { throw err; }, doctor: async () => [],
  });
  const setup = (err: ProviderError) => {
    const env = makeCtx(undefined, () => NOW);
    env.store.saveAccount({ platform: 'fake', name: 'main', credentials: {}, profile: {} });
    const { targets } = env.store.createPost(POST, [{ platform: 'fake', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    env.store.transition(id, 'uploading');
    env.store.transition(id, 'processing', { remoteId: 'DEAD', resume: { containerId: 'DEAD' } });
    const deps: RunnerDeps = { ctx: env.ctx, providers: new Map([['fake', fake(err)]]), probe: async () => fakeMedia() };
    return { ...env, deps, id };
  };

  it('forgets the dead remote object', async () => {
    const { deps, id } = setup(new ProviderError('rejected', 'ig.container_error', 'ERROR'));
    const t = await step(deps, id);
    assert.deepEqual([t.state, t.remoteId, t.resume], ['failed', undefined, undefined]);
  });

  it('keeps it when the error says the object may still be live', async () => {
    const { deps, id } = setup(new ProviderError('rejected', 'x.maybe_posted', 'check', undefined, { keepResume: true }));
    const t = await step(deps, id);
    assert.deepEqual([t.state, t.remoteId, t.resume], ['failed', 'DEAD', { containerId: 'DEAD' }]);
  });
});

describe('YouTube extras are sent at most once', () => {
  it('skips extras already sent and turns network errors into warnings', async () => {
    const { fetch, calls } = mockFetch([
      ['PUT', 'session', () => json({ id: 'VID', status: { uploadStatus: 'uploaded', privacyStatus: 'unlisted' } }, 200)],
      ['POST', '/captions', () => { throw new TypeError('fetch failed'); }],
      ['POST', '/playlistItems', () => json({}, 200)],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('youtube', { clientId: 'c', clientSecret: 's' });
    const account: Account = { platform: 'youtube', name: 'main', profile: {}, credentials: { accessToken: 'A', refreshToken: 'R', expiresAt: NOW.getTime() + 3600_000 } };
    const file = tempFile(100);
    const saved: Array<Record<string, unknown>> = [];
    const t: Target = {
      id: 't', postId: 'p', platform: 'youtube', account: 'main', state: 'uploading', warnings: [], attempts: 1, updatedAt: '',
      options: { privacy: 'unlisted', madeForKids: false, playlistId: 'PL' },
      resume: { sessionUri: 'https://upload.example/session', size: 100, extras: ['thumbnail'] },
    };
    const out = await youtube.publish({
      ctx,
      post: post({ thumbnailPath: tempFile(10), captions: [{ language: 'ko', path: tempFile(10) }] }),
      target: t, account, mediaPath: file, media: fakeMedia(), saveResume: (r) => saved.push(r),
    });
    assert.ok(!calls.some((c) => c.url.includes('thumbnails/set')), 'thumbnail already done');
    assert.equal(calls.filter((c) => c.url.includes('/playlistItems')).length, 1);
    assert.ok(out.warnings?.some((w) => w.startsWith('자막(ko) 실패')));
    assert.deepEqual(saved.at(-1), { videoId: 'VID', extras: ['thumbnail', 'caption:ko', 'playlist'] });
  });
});
