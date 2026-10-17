import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { liveRoundTrip } from '../src/core/livecheck.ts';
import type { Provider } from '../src/core/provider.ts';
import { makeCtx } from './helpers.ts';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

function fake(overrides: Partial<Provider> = {}): { provider: Provider; log: string[] } {
  const log: string[] = [];
  const provider = {
    id: 'fake',
    displayName: 'Fake',
    async publish({ ctx, account, target, saveResume }) {
      log.push(`publish ${JSON.stringify(target.options)}`);
      saveResume({ uploaded: true });
      // Rotate the token mid-check, like a refresh would.
      ctx.store.saveAccount({ ...account, credentials: { token: 'rotated' } });
      return { state: 'processing', remoteId: 'R1', remoteUrl: 'https://fake/R1' };
    },
    async poll({ target }) {
      log.push(`poll ${target.remoteId}`);
      return { state: 'published', remoteId: 'R1', remoteUrl: 'https://fake/R1' };
    },
    async remove({ target }) {
      log.push(`remove ${target.remoteId}`);
    },
    ...overrides,
  } as Provider;
  return { provider, log };
}

describe('doctor --live round trip', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  it('posts a test clip, waits for it, deletes it, and keeps a rotated token', async () => {
    const { ctx, store } = makeCtx();
    const account = { platform: 'fake', name: 'main', credentials: { token: 'old' }, profile: {} };
    store.saveAccount(account);
    const { provider, log } = fake();
    const checks = await liveRoundTrip(ctx, provider, account, { options: { privacy: 'private' }, pollMs: 1 });
    assert.deepEqual(checks.map((c) => [c.name, c.status]), [['테스트 업로드', 'ok'], ['처리·게시', 'ok'], ['테스트 게시물 삭제', 'ok']]);
    assert.deepEqual(log, ['publish {"privacy":"private"}', 'poll R1', 'remove R1']);
    assert.equal(store.listPosts(10).length, 0, 'nothing in the real history');
    assert.deepEqual(store.getAccount('fake', 'main')!.credentials, { token: 'rotated' });
  });

  it('says what to delete by hand when it could not', async () => {
    const { ctx } = makeCtx();
    const account = { platform: 'fake', name: 'main', credentials: {}, profile: {} };
    const { provider } = fake({
      async poll() {
        throw new Error('transcoding failed');
      },
    });
    const checks = await liveRoundTrip(ctx, provider, account, { options: {}, pollMs: 1 });
    assert.deepEqual(checks.map((c) => c.status), ['ok', 'fail', 'warn']);
    assert.match(checks[2]!.detail, /https:\/\/fake\/R1/);
  });
});

describe('doctor --live labels', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  it('a failed delete is reported as the delete step', async () => {
    const { ctx } = makeCtx();
    const account = { platform: 'fake', name: 'main', credentials: {}, profile: {} };
    const { provider } = fake({
      async remove() {
        throw new Error('403 forbidden');
      },
    });
    const checks = await liveRoundTrip(ctx, provider, account, { options: {}, pollMs: 1 });
    assert.deepEqual(checks.map((c) => [c.name, c.status]), [['테스트 업로드', 'ok'], ['처리·게시', 'ok'], ['테스트 게시물 삭제', 'fail'], ['테스트 게시물 삭제', 'warn']]);
  });
});
