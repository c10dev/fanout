import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { describe, it } from 'node:test';
import { addTargets, planAddTargets } from '../src/core/posting.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { youtube } from '../src/providers/youtube.ts';
import { fakeMedia, makeCtx, tempFile } from './helpers.ts';

const media = fakeMedia();
const MD = { visibility: 'unlisted' };

function setup(post: Partial<PostInput> = {}) {
  const env = makeCtx();
  for (const platform of ['youtube', 'mastodon', 'bluesky']) env.store.saveAccount({ platform, name: 'main', credentials: {}, profile: {} });
  const input: PostInput = { mediaPath: tempFile(100), title: '원래 게시물', description: 'd', tags: [], captions: [], containsSyntheticMedia: false, ...post };
  const { post: p, targets } = env.store.createPost(input, [{ platform: 'mastodon', account: 'main', options: MD }]);
  return { ...env, post: p, first: targets[0]! };
}

describe('adding platforms to a post', () => {
  it('queues the new platform with the same post', () => {
    const { store, post } = setup();
    const created = addTargets(store, providerMap(), post.id, [{ platform: 'bluesky', account: 'main', options: {} }], media);
    assert.deepEqual(created.map((t) => [t.platform, t.state, t.postId]), [['bluesky', 'queued', post.id]]);
    assert.equal(store.targetsForPost(post.id).length, 2);
  });

  it('refuses a platform account already on the post, and allows it after a clean failure or cancel', () => {
    const { store, post, first } = setup();
    assert.throws(() => planAddTargets(store, providerMap(), post.id, [{ platform: 'mastodon', account: 'main', options: MD }], media), /이미 있습니다/);
    store.transition(first.id, 'uploading');
    store.transition(first.id, 'failed', { errorCode: 'mastodon.maybe_posted' });
    assert.throws(() => planAddTargets(store, providerMap(), post.id, [{ platform: 'mastodon', account: 'main', options: MD }], media), /maybe_posted/);
    store.updateTarget(first.id, { errorCode: 'mastodon.http_422' });
    assert.equal(planAddTargets(store, providerMap(), post.id, [{ platform: 'mastodon', account: 'main', options: MD }], media).preview.length, 1);
  });

  it('refuses once the original video was cleaned up', () => {
    const { store, post } = setup();
    rmSync(post.mediaPath);
    assert.throws(() => planAddTargets(store, providerMap(), post.id, [{ platform: 'bluesky', account: 'main', options: {} }], media), /정리돼 없습니다/);
  });

  it('blocked previews stop the add', () => {
    const { store, post } = setup();
    // YouTube needs privacy and made-for-kids answers.
    assert.throws(() => addTargets(store, providerMap(), post.id, [{ platform: 'youtube', account: 'main', options: {} }], media), /youtube\/main/);
    assert.equal(store.targetsForPost(post.id).length, 1);
  });

  it('a future schedule holds platforms without native scheduling, a past one does not', () => {
    const future = setup({ scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
    const [md, bs] = addTargets(future.store, providerMap(), future.post.id, [{ platform: 'bluesky', account: 'main', options: {} }], media).concat();
    assert.equal(md!.notBefore, future.post.scheduledAt);
    assert.equal(bs, undefined);
    const past = setup({ scheduledAt: new Date(Date.now() - 3600_000).toISOString() });
    assert.equal(addTargets(past.store, providerMap(), past.post.id, [{ platform: 'bluesky', account: 'main', options: {} }], media)[0]!.notBefore, undefined);
  });

  it('leaves out attachments whose files are gone, and says so', () => {
    const thumb = tempFile(10);
    const { store, post } = setup({ thumbnailPath: thumb, captions: [{ language: 'ko', path: tempFile(10) }] });
    rmSync(thumb);
    const plan = planAddTargets(store, providerMap(), post.id, [{ platform: 'bluesky', account: 'main', options: {} }], media);
    assert.match(plan.preview[0]!.warnings[0]!, /썸네일/);
    addTargets(store, providerMap(), post.id, [{ platform: 'bluesky', account: 'main', options: {} }], media);
    assert.equal(store.getPost(post.id)!.thumbnailPath, undefined);
    assert.equal(store.getPost(post.id)!.captions.length, 1);
  });
});

describe('YouTube schedule that has passed', () => {
  const post = { id: 'p', createdAt: '', mediaPath: '/v', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false, scheduledAt: new Date(Date.now() - 60_000).toISOString() };
  const target = (resume?: Record<string, unknown>) => ({ id: 't', postId: 'p', platform: 'youtube', account: 'main', options: { privacy: 'public', madeForKids: false }, state: 'queued' as const, warnings: [], attempts: 0, updatedAt: '', resume });
  it('refuses a new upload but lets one already under way resume', () => {
    assert.ok(youtube.validate(post, target(), media).some((i) => i.code === 'schedule_past'));
    assert.ok(!youtube.validate(post, target({ sessionUri: 'https://upload/s' }), media).some((i) => i.code === 'schedule_past'));
  });
});

describe('eighth review fixes', () => {
  it('a target waiting for reconnection still covers its account', () => {
    const { store, post, first } = setup();
    store.transition(first.id, 'uploading');
    store.transition(first.id, 'needs_reauth');
    assert.throws(() => planAddTargets(store, providerMap(), post.id, [{ platform: 'mastodon', account: 'main', options: MD }], media), /needs_reauth/);
  });

  it('YouTube publishes now, with a warning, when the schedule has passed', async () => {
    const { buildMetadata } = await import('../src/providers/youtube.ts');
    const post = { id: 'p', createdAt: '', mediaPath: '/v', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false, scheduledAt: new Date(Date.now() - 60_000).toISOString() };
    const meta = buildMetadata(post, { privacy: 'public', madeForKids: false }) as { status: { privacyStatus: string; publishAt?: string } };
    assert.deepEqual([meta.status.privacyStatus, meta.status.publishAt], ['public', undefined]);
    const target = { id: 't', postId: 'p', platform: 'youtube', account: 'main', options: { privacy: 'public', madeForKids: false }, state: 'queued' as const, warnings: [], attempts: 0, updatedAt: '' };
    const issue = youtube.validate(post, target, media).find((i) => i.code === 'schedule_past');
    assert.equal(issue?.severity, 'warning');
  });

  it('adds all targets or none', () => {
    const { store, post } = setup();
    const before = store.targetsForPost(post.id).length;
    assert.throws(() => store.addTargets(post.id, [{ platform: 'bluesky', account: 'main', options: {} }, { platform: 'x', account: 'main', options: undefined as never }]));
    assert.equal(store.targetsForPost(post.id).length, before);
  });
});

describe('ninth review fixes', () => {
  it('a passed schedule does not demand public on YouTube', () => {
    const post = { id: 'p', createdAt: '', mediaPath: '/v', title: 't', description: '', tags: [], captions: [], containsSyntheticMedia: false, scheduledAt: new Date(Date.now() - 60_000).toISOString() };
    const target = { id: 't', postId: 'p', platform: 'youtube', account: 'main', options: { privacy: 'unlisted', madeForKids: false }, state: 'queued' as const, warnings: [], attempts: 0, updatedAt: '' };
    assert.deepEqual(youtube.validate(post, target, media).filter((i) => i.severity === 'error'), []);
  });
});
