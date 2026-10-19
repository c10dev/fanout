import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postDueFirstComments } from '../src/core/followup.ts';
import { fetchComments, refreshStats } from '../src/core/posting.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { instagram } from '../src/providers/instagram.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const NOW = new Date('2026-10-19T03:00:00Z');
const POST: PostInput = { mediaPath: '/v.mp4', title: '제목', description: '설명', tags: ['릴스'], captions: [], containsSyntheticMedia: false, firstComment: '링크는 프로필에' };
const CREDS = { pageId: 'PAGE', pageToken: 'PT', igUserId: 'IG' };

/** A target whose container Instagram says is PUBLISHED, with these posts on the account. */
async function recover(media: Array<{ id: string; caption?: string; timestamp: string; permalink?: string }>, options: Record<string, unknown> = {}) {
  const { fetch, calls } = mockFetch([
    ['GET', '/C1?', () => json({ status_code: 'PUBLISHED' })],
    ['GET', '/IG/media?', () => json({ data: media })],
  ]);
  const env = makeCtx(fetch, () => NOW);
  env.store.setApp('meta', { appId: 'a', appSecret: 's' });
  env.store.saveAccount({ platform: 'instagram', name: 'main', credentials: CREDS, profile: {} });
  const { post, targets } = env.store.createPost(POST, [{ platform: 'instagram', account: 'main', options }]);
  const id = targets[0]!.id;
  env.store.transition(id, 'uploading');
  env.store.transition(id, 'processing', { remoteId: 'C1', resume: { containerId: 'C1', uploaded: true } });
  const target = env.store.getTarget(id)!;
  const out = await instagram.poll({ ctx: env.ctx, post, target: { ...target, remoteId: 'C1' }, account: env.store.getAccount('instagram', 'main')! });
  env.store.transition(id, 'published', { remoteId: out.remoteId, remoteUrl: out.remoteUrl });
  return { ...env, calls, id, out };
}

const CAPTION = '제목\n\n설명\n\n#릴스';

describe('instagram: a container published without its media id', () => {
  it('finds the post among the latest by time and caption, and keeps its real id', async () => {
    const { out, store, id } = await recover([
      { id: 'OLD', caption: CAPTION, timestamp: '2026-10-18T00:00:00+0000' },
      { id: 'M9', caption: '제목  \n\n 설명\n\n#릴스', timestamp: '2026-10-19T02:59:00+0000', permalink: 'https://www.instagram.com/reel/m9/' },
      { id: 'OTHER', caption: 'something else', timestamp: '2026-10-19T02:59:30+0000' },
    ]);
    assert.equal(out.remoteId, 'M9');
    assert.notEqual(store.getTarget(id)!.remoteId, 'C1', 'not the container id');
    assert.equal((store.getTarget(id)!.resume as { mediaId?: string }).mediaId, 'M9');
  });

  it('two matches: never guesses, marks it, and stats, comments and the first comment skip it', async () => {
    const both = [
      { id: 'A', caption: CAPTION, timestamp: '2026-10-19T02:58:00+0000' },
      { id: 'B', caption: CAPTION, timestamp: '2026-10-19T02:59:00+0000' },
    ];
    const { out, store, id, ctx, calls } = await recover(both);
    assert.equal(out.remoteId, 'C1');
    assert.match(out.warnings?.join(' ') ?? '', /찾지 못했습니다/);
    assert.equal((store.getTarget(id)!.resume as { mediaIdUnknown?: boolean }).mediaIdUnknown, true);
    const before = calls.length;
    const stats = await refreshStats(ctx, providerMap(), store.getTarget(id)!.postId);
    assert.match(stats[0]!.skipped ?? '', /게시물 id를 몰라/);
    const comments = await fetchComments(ctx, providerMap(), store.getTarget(id)!.postId, 10);
    assert.match(comments[0]!.skipped ?? '', /게시물 id를 몰라/);
    await postDueFirstComments(ctx, providerMap());
    assert.equal(store.getTarget(id)!.followup?.state, 'failed');
    assert.equal(store.getTarget(id)!.followup?.maybePosted, undefined);
    assert.equal(calls.length, before, 'no Graph call with the container id');
  });

  it('a lookup that fails is not "no match": it throws, so the next poll looks again', async () => {
    const { fetch } = mockFetch([
      ['GET', '/C1?', () => json({ status_code: 'PUBLISHED' })],
      ['GET', '/IG/media?', () => json({ error: { code: 2, message: 'Service temporarily unavailable' } }, 500)],
    ]);
    const env = makeCtx(fetch, () => NOW);
    env.store.setApp('meta', { appId: 'a', appSecret: 's' });
    env.store.saveAccount({ platform: 'instagram', name: 'main', credentials: CREDS, profile: {} });
    const { post, targets } = env.store.createPost(POST, [{ platform: 'instagram', account: 'main', options: {} }]);
    env.store.transition(targets[0]!.id, 'uploading');
    env.store.transition(targets[0]!.id, 'processing', { remoteId: 'C1', resume: { containerId: 'C1', uploaded: true } });
    await assert.rejects(instagram.poll({ ctx: env.ctx, post, target: { ...env.store.getTarget(targets[0]!.id)!, remoteId: 'C1' }, account: env.store.getAccount('instagram', 'main')! }));
    assert.equal((env.store.getTarget(targets[0]!.id)!.resume as { mediaIdUnknown?: boolean }).mediaIdUnknown, undefined, 'not marked');
  });

  it('no match: marked', async () => {
    const { out } = await recover([{ id: 'X1', caption: 'another post', timestamp: '2026-10-19T02:59:00+0000' }]);
    assert.equal(out.remoteId, 'C1');
  });

  it('a match another target already holds is not taken', async () => {
    const { fetch } = mockFetch([
      ['GET', '/C1?', () => json({ status_code: 'PUBLISHED' })],
      ['GET', '/IG/media?', () => json({ data: [{ id: 'M9', caption: CAPTION, timestamp: '2026-10-19T02:59:00+0000' }] })],
    ]);
    const env = makeCtx(fetch, () => NOW);
    env.store.setApp('meta', { appId: 'a', appSecret: 's' });
    env.store.saveAccount({ platform: 'instagram', name: 'main', credentials: CREDS, profile: {} });
    // The same video posted twice: the first one already holds M9.
    const first = env.store.createPost(POST, [{ platform: 'instagram', account: 'main', options: {} }]);
    env.store.transition(first.targets[0]!.id, 'uploading');
    env.store.transition(first.targets[0]!.id, 'published', { remoteId: 'M9' });
    const { post, targets } = env.store.createPost(POST, [{ platform: 'instagram', account: 'main', options: {} }]);
    env.store.transition(targets[0]!.id, 'uploading');
    env.store.transition(targets[0]!.id, 'processing', { remoteId: 'C1', resume: { containerId: 'C1', uploaded: true } });
    const out = await instagram.poll({ ctx: env.ctx, post, target: { ...env.store.getTarget(targets[0]!.id)!, remoteId: 'C1' }, account: env.store.getAccount('instagram', 'main')! });
    assert.equal(out.remoteId, 'C1');
    assert.equal((env.store.getTarget(targets[0]!.id)!.resume as { mediaIdUnknown?: boolean }).mediaIdUnknown, true);
  });

  it('a trial reel missing from the media list is expected: marked, and the warning says where to look', async () => {
    const { out, store, id } = await recover([], { trialReel: 'manual' });
    assert.equal((store.getTarget(id)!.resume as { mediaIdUnknown?: boolean }).mediaIdUnknown, true);
    assert.match(out.warnings?.join(' ') ?? '', /시험 릴스/);
  });
});
