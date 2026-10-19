import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openContext } from '../src/core/context.ts';
import { mayBeDuplicate, retryTarget } from '../src/core/posting.ts';
import type { PostInput } from '../src/core/types.ts';
import { makeCtx } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };

describe('retry gate', () => {
  function failed(platform: string, patch: { errorCode?: string; resume?: Record<string, unknown> }) {
    const env = makeCtx();
    const { targets } = env.store.createPost(POST, [{ platform, account: 'main', options: {} }]);
    const id = targets[0]!.id;
    env.store.transition(id, 'uploading');
    env.store.transition(id, 'failed', patch);
    return { ...env, id };
  }

  it('gates a repeat that could post twice, not a resume from saved upload ids', () => {
    const cases: Array<[string, { errorCode?: string; resume?: Record<string, unknown> }, boolean]> = [
      ['x', { errorCode: 'x.maybe_posted', resume: { mediaId: 'M', posting: true } }, true],
      ['mastodon', { errorCode: 'mastodon.media_attached', resume: { mediaId: 'M' } }, true],
      ['peertube', { errorCode: 'peertube.maybe_posted' }, true],
      ['x', { errorCode: 'x.http_503', resume: { mediaId: 'M', posting: true } }, true],
      ['youtube', { errorCode: 'youtube.processing_timeout', resume: { sessionUri: 'https://upload' } }, false],
      ['instagram', { errorCode: 'meta.2', resume: { containerId: 'C', uploaded: true } }, false],
      ['x', { errorCode: 'x.http_400', resume: { mediaId: 'M', posting: false } }, false],
    ];
    for (const [platform, patch, gated] of cases) {
      const { store, id } = failed(platform, patch);
      assert.equal(Boolean(mayBeDuplicate(store.getTarget(id)!)), gated, `${platform} ${patch.errorCode}`);
      if (gated) {
        assert.throws(() => retryTarget(store, id, 'test'), (e: Error & { code?: string }) => e.code === 'maybe_duplicate');
        assert.equal(store.getTarget(id)!.state, 'failed');
        const next = retryTarget(store, id, 'test', { confirmedNotPosted: true });
        assert.equal(next.state, 'queued');
        assert.equal((next.resume as { posting?: boolean } | undefined)?.posting ?? false, false);
      } else assert.equal(retryTarget(store, id, 'test').state, 'queued');
    }
  });

  it('fanout retry holds a maybe-posted target and says how to go on', () => {
    const home = mkdtempSync(join(tmpdir(), 'fanout-retry-'));
    const ctx = openContext(home);
    const { post, targets } = ctx.store.createPost(POST, [{ platform: 'x', account: 'main', options: {} }]);
    ctx.store.transition(targets[0]!.id, 'uploading');
    ctx.store.transition(targets[0]!.id, 'failed', { errorCode: 'x.maybe_posted', resume: { mediaId: 'M', posting: true } });
    ctx.store.close();
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), 'retry', post.id.slice(0, 8)], { env: { ...process.env, FANOUT_HOME: home, FANOUT_LANG: 'en' }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /may already be posted/);
    assert.match(r.stderr, /--confirmed-not-posted/);
    const after = openContext(home);
    assert.equal(after.store.getTarget(targets[0]!.id)!.state, 'failed');
    after.store.close();
  });
});
