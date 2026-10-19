import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PostInput, Target, TargetState } from '../src/core/types.ts';
import { makeCtx } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false };

function setup() {
  const env = makeCtx();
  const { targets } = env.store.createPost(POST, [{ platform: 'instagram', account: 'main', options: {} }]);
  const id = targets[0]!.id;
  env.store.transition(id, 'uploading');
  env.store.transition(id, 'processing', { remoteId: 'C1' });
  const heard: Array<[TargetState, TargetState]> = [];
  env.store.onTransition((t: Target, from: TargetState) => heard.push([from, t.state]));
  return { ...env, id, heard };
}

describe('target transitions are atomic', () => {
  it('a patch that cannot be written leaves state, event and fields as they were, and nobody hears of it', () => {
    const { store, id, heard } = setup();
    const events = store.events(id).length;
    assert.throws(() => store.transition(id, 'published', { remoteId: 'M1', resume: { bad: 10n } as never }), /BigInt/);
    const t = store.getTarget(id)!;
    assert.deepEqual([t.state, t.remoteId], ['processing', 'C1'], 'not published with the container id');
    assert.equal(store.events(id).length, events);
    assert.deepEqual(heard, []);
  });

  it('inside a transaction, it joins it, and its listener runs once after the outer COMMIT', () => {
    const { store, id, heard } = setup();
    store.transaction(() => {
      store.transition(id, 'published', { remoteId: 'M1' });
      assert.deepEqual(heard, [], 'not before the commit');
    });
    assert.deepEqual(heard, [['processing', 'published']]);
    assert.equal(store.getTarget(id)!.remoteId, 'M1');
  });

  it('when the outer transaction fails after it, everything is rolled back and nothing is heard', () => {
    const { store, id, heard } = setup();
    const events = store.events(id).length;
    assert.throws(() =>
      store.transaction(() => {
        store.transition(id, 'published', { remoteId: 'M1' });
        throw new Error('later step failed');
      }),
    );
    const t = store.getTarget(id)!;
    assert.deepEqual([t.state, t.remoteId], ['processing', 'C1']);
    assert.equal(store.events(id).length, events);
    assert.deepEqual(heard, []);
    // And the next transition is heard as usual (nothing left queued from the rolled-back one).
    store.transition(id, 'published', { remoteId: 'M2' });
    assert.deepEqual(heard, [['processing', 'published']]);
  });

  it('a throwing listener does not stop the others or the change', () => {
    const { store, id, heard } = setup();
    store.onTransition(() => {
      throw new Error('listener broke');
    });
    const seen: string[] = [];
    store.onTransition((t: Target) => seen.push(t.state));
    store.transition(id, 'published', { remoteId: 'M1' });
    assert.equal(store.getTarget(id)!.state, 'published');
    assert.deepEqual(heard, [['processing', 'published']]);
    assert.deepEqual(seen, ['published']);
  });
});
