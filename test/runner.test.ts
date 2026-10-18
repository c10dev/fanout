import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs, targetOptions } from '../src/cli.ts';
import { ProviderError } from '../src/core/errors.ts';
import type { MediaInfo } from '../src/core/media.ts';
import type { PollOutcome, Provider, PublishOutcome } from '../src/core/provider.ts';
import { settle, step, type RunnerDeps } from '../src/core/runner.ts';
import type { PostInput } from '../src/core/types.ts';
import { fakeMedia, makeCtx } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };

function fakeProvider(behaviour: {
  publish?: () => Promise<PublishOutcome>;
  poll?: () => Promise<PollOutcome>;
  maxDurationSec?: number;
}): Provider & { publishes: number } {
  const p = {
    id: 'fake',
    displayName: 'Fake',
    capabilities: { nativeSchedule: false, thumbnail: false, captions: false, syntheticMediaFlag: false },
    spec: { maxDurationSec: behaviour.maxDurationSec, videoCodecs: ['h264'] },
    appFields: [],
    publishes: 0,
    setupGuide: () => '',
    connect: async () => {
      throw new Error('n/a');
    },
    refresh: async (_ctx: unknown, a: never) => a,
    validate: () => [],
    publish: async () => {
      p.publishes++;
      return behaviour.publish ? behaviour.publish() : { state: 'processing', remoteId: 'R1' };
    },
    poll: async () => (behaviour.poll ? behaviour.poll() : { state: 'published', remoteId: 'R1', remoteUrl: 'https://x/R1' }),
    doctor: async () => [],
  };
  return p as unknown as Provider & { publishes: number };
}

function setup(provider: Provider, media: MediaInfo = fakeMedia()) {
  const env = makeCtx();
  env.store.saveAccount({ platform: 'fake', name: 'main', credentials: {}, profile: {} });
  const deps: RunnerDeps = {
    ctx: env.ctx,
    providers: new Map([['fake', provider]]),
    probe: async () => media,
    ensureVariant: async (info) => ({ path: info.path, transcoded: false, reasons: [] }),
  };
  const { targets } = env.store.createPost(POST, [{ platform: 'fake', account: 'main', options: {} }]);
  return { ...env, deps, id: targets[0]!.id };
}

describe('runner', () => {
  it('drives a target to published and logs each state', async () => {
    const { deps, store, id } = setup(fakeProvider({}));
    const [done] = await settle(deps, [id], { pollIntervalMs: 1, timeoutMs: 5_000 });
    assert.equal(done!.state, 'published');
    assert.equal(done!.remoteUrl, 'https://x/R1');
    assert.deepEqual(store.events(id).map((e) => e.to), ['queued', 'uploading', 'processing', 'published']);
  });

  it('fails preflight on non-fixable spec violations without uploading', async () => {
    const provider = fakeProvider({ maxDurationSec: 10 });
    const { deps, id } = setup(provider, fakeMedia({ durationSec: 30 }));
    const t = await step(deps, id);
    assert.equal(t.state, 'failed');
    assert.equal(t.errorCode, 'preflight');
    assert.equal(provider.publishes, 0);
  });

  it('goes through transcoding when a violation is fixable', async () => {
    const { deps, store, id } = setup(fakeProvider({}), fakeMedia({}, { codec: 'hevc' }));
    deps.ensureVariant = async (info) => ({ path: `${info.path}.h264.mp4`, transcoded: true, reasons: ['codec'] });
    await settle(deps, [id], { pollIntervalMs: 1, timeoutMs: 5_000 });
    assert.deepEqual(store.events(id).map((e) => e.to), ['queued', 'transcoding', 'uploading', 'processing', 'published']);
  });

  it('requeues retryable upload errors with a backoff', async () => {
    const { deps, id } = setup(fakeProvider({ publish: async () => Promise.reject(new ProviderError('retryable', 'net', 'socket hang up')) }));
    const t = await step(deps, id);
    assert.equal(t.state, 'queued');
    assert.equal(t.attempts, 1);
    assert.ok(t.notBefore && new Date(t.notBefore) > deps.ctx.now());
    assert.equal(t.errorCode, 'net');
  });

  it('waits for a daily limit to reset instead of failing, without counting an attempt', async () => {
    const reset = new Date('2026-10-18T07:05:00Z');
    const limit = new ProviderError('rejected', 'youtube.quota', 'used up', 'quotaExceeded', { retryAt: reset });
    const { deps, store, id } = setup(fakeProvider({ publish: async () => Promise.reject(limit) }));
    const t = await step(deps, id);
    assert.equal(t.state, 'queued');
    assert.equal(t.notBefore, reset.toISOString());
    assert.equal(t.attempts, 0, 'the attempt entering uploading counted is given back');
    assert.equal(t.errorCode, 'youtube.quota (quotaExceeded)');
    // Days of waiting never use up the retries a later network error needs.
    for (let day = 0; day < 4; day++) {
      store.updateTarget(id, { notBefore: undefined });
      assert.equal((await step(deps, id)).attempts, 0);
    }
  });

  it('keeps the uploaded video when only its status check hits the limit', async () => {
    const limit = new ProviderError('rejected', 'youtube.http_403', 'quota', 'quotaExceeded', { retryAt: new Date('2026-10-18T07:05:00Z') });
    const { deps, id } = setup(fakeProvider({ poll: async () => Promise.reject(limit) }));
    const t = await step(deps, await step(deps, id).then((x) => x.id));
    assert.equal(t.state, 'processing');
    assert.equal(t.remoteId, 'R1', 'a retry must not upload it again');
  });

  it('does not wait past its deadline for a target parked until later', async () => {
    const later = new Date(Date.now() + 3 * 3600_000).toISOString();
    const { deps, store, id } = setup(fakeProvider({}));
    store.updateTarget(id, { notBefore: later });
    const started = Date.now();
    await settle(deps, [id], { pollIntervalMs: 5, timeoutMs: 2_000 });
    assert.ok(Date.now() - started < 1_000, `${Date.now() - started} ms`);
  });

  it('marks auth errors as needs_reauth and keeps the platform code', async () => {
    const { deps, id } = setup(fakeProvider({ publish: async () => Promise.reject(new ProviderError('auth', 'tiktok.access_token_invalid', 'expired', 'access_token_invalid')) }));
    const t = await step(deps, id);
    assert.equal(t.state, 'needs_reauth');
    assert.equal(t.errorCode, 'tiktok.access_token_invalid (access_token_invalid)');
  });

  it('keeps polling instead of re-uploading when a status check fails', async () => {
    let calls = 0;
    const provider = fakeProvider({
      poll: async () => {
        calls++;
        if (calls === 1) throw new ProviderError('retryable', 'net', 'timeout');
        return { state: 'handed_off', remoteId: 'R1' };
      },
    });
    const { deps, id } = setup(provider);
    const [done] = await settle(deps, [id], { pollIntervalMs: 1, timeoutMs: 5_000 });
    assert.equal(done!.state, 'handed_off');
    assert.equal(provider.publishes, 1);
  });

  it('gives up on a transcode that keeps failing instead of looping', async () => {
    const { deps, id } = setup(fakeProvider({}), fakeMedia({}, { codec: 'hevc' }));
    let calls = 0;
    deps.ensureVariant = async () => {
      calls++;
      throw new Error('ffmpeg exited with code 1');
    };
    deps.ctx.now = () => new Date('2100-01-01T00:00:00Z');
    let t = await step(deps, id);
    while (t.state !== 'failed' && calls < 20) {
      deps.ctx.store.updateTarget(id, { notBefore: undefined });
      t = await step(deps, id);
    }
    assert.equal(t.state, 'failed');
    assert.ok(calls <= 4, `ensureVariant called ${calls} times`);
  });

  it('gives up on a file that cannot be probed', async () => {
    const { deps, id } = setup(fakeProvider({}));
    deps.probe = async () => {
      throw new Error('Invalid data found when processing input');
    };
    let t = await step(deps, id);
    for (let i = 0; i < 10 && t.state !== 'failed'; i++) {
      deps.ctx.store.updateTarget(id, { notBefore: undefined });
      t = await step(deps, id);
    }
    assert.equal(t.state, 'failed');
    assert.match(t.errorMessage ?? '', /Invalid data/);
  });

  it('reports a missing account as needs_reauth', async () => {
    const { deps, store, id } = setup(fakeProvider({}));
    store.removeAccount('fake', 'main');
    assert.equal((await step(deps, id)).state, 'needs_reauth');
  });
});

describe('cli flags', () => {
  it('parses positionals, values, booleans and repeated flags', () => {
    const a = parseArgs(['post', 'v.mp4', '--title', '제목', '--yes', '--caption', 'ko:a.srt', '--caption=en:b.srt']);
    assert.deepEqual(a.positionals, ['post', 'v.mp4']);
    assert.equal(a.flags.title, '제목');
    assert.equal(a.flags.yes, true);
    assert.deepEqual(a.lists.caption, ['ko:a.srt', 'en:b.srt']);
  });

  it('maps platform flags and leaves required choices unset', () => {
    const a = parseArgs(['--yt-privacy', 'unlisted', '--yt-made-for-kids', 'no', '--tt-mode', 'direct', '--tt-privacy', 'followers']);
    assert.deepEqual(targetOptions('youtube', a), { privacy: 'unlisted', madeForKids: false });
    assert.deepEqual(targetOptions('tiktok', a), { mode: 'direct', privacyLevel: 'FOLLOWER_OF_CREATOR' });
    assert.deepEqual(targetOptions('tiktok', parseArgs([])), { mode: 'inbox' });
  });
});
