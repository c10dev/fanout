import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cancelTarget, priorPosts } from '../src/core/posting.ts';
import type { PostInput } from '../src/core/types.ts';
import { makeCtx } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false, mediaHash: 'h' };

describe('canceling targets', () => {
  it('cancels queued (incl. scheduled), failed and needs_reauth targets', () => {
    const { store } = makeCtx();
    const { targets } = store.createPost(POST, [
      { platform: 'tiktok', account: 'main', options: {} },
      { platform: 'youtube', account: 'main', options: {} },
      { platform: 'x', account: 'main', options: {} },
    ]);
    const [a, b, c] = targets.map((t) => t.id) as [string, string, string];
    store.updateTarget(a, { notBefore: '2099-01-01T00:00:00Z' });
    store.transition(b, 'failed');
    store.transition(c, 'needs_reauth');
    for (const id of [a, b, c]) assert.equal(cancelTarget(store, id).state, 'canceled');
    assert.equal(store.getTarget(a)!.notBefore, undefined);
    assert.equal(store.events(a).at(-1)!.detail, 'canceled by user');
    assert.deepEqual(store.workableTargets(), []);
  });

  it('refuses published or in-flight targets', () => {
    const { store } = makeCtx();
    const { targets } = store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }, { platform: 'tiktok', account: 'main', options: {} }]);
    const [pub, busy] = targets.map((t) => t.id) as [string, string];
    store.transition(pub, 'uploading');
    store.transition(pub, 'published');
    assert.throws(() => cancelTarget(store, pub), /삭제를 쓰세요/);
    store.claim(busy, 'worker-1', 60_000);
    assert.throws(() => cancelTarget(store, busy), /처리 중/);
    assert.equal(store.getTarget(busy)!.state, 'queued');
  });

  it('a canceled target does not count as already posted', () => {
    const { store } = makeCtx();
    const { targets } = store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }]);
    const wanted = [{ platform: 'youtube', account: 'main', options: {} }];
    assert.equal(priorPosts(store, 'h', wanted).size, 1);
    cancelTarget(store, targets[0]!.id);
    assert.equal(priorPosts(store, 'h', wanted).size, 0);
  });
});
