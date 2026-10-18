import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changeVisibility, editPost } from '../src/core/posting.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const NOW = new Date('2026-10-17T03:00:00Z');
const POST: PostInput = { mediaPath: '/v.mp4', title: '옛 제목', description: '옛 설명', tags: ['old'], captions: [], containsSyntheticMedia: false };

describe('editing published posts', () => {
  it('updates YouTube, Facebook and Mastodon and skips the rest with a reason', async () => {
    const { fetch, calls } = mockFetch([
      ['GET', '/youtube/v3/videos?part=snippet&id=V', () => json({ items: [{ snippet: { title: '옛 제목', description: '옛 설명', categoryId: '27', defaultLanguage: 'ko', defaultAudioLanguage: 'ko', channelId: 'UC' } }] })],
      ['PUT', '/youtube/v3/videos?part=snippet', () => json({ id: 'V' })],
      ['POST', '/R1', () => json({ success: true })],
      ['PUT', '/api/v1/statuses/S1', () => json({ id: 'S1' })],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('meta', { appId: 'a', appSecret: 's' });
    store.setApp('youtube', { clientId: 'c', clientSecret: 's' });
    store.saveAccount({ platform: 'youtube', name: 'main', credentials: { accessToken: 'A', refreshToken: 'R', expiresAt: NOW.getTime() + 3600_000 }, profile: {} });
    store.saveAccount({ platform: 'facebook', name: 'main', credentials: { pageId: 'P', pageToken: 'PT' }, profile: {} });
    store.saveAccount({ platform: 'mastodon', name: 'main', credentials: { instance: 'https://m.example', token: 'T' }, profile: {} });
    store.saveAccount({ platform: 'bluesky', name: 'main', credentials: {}, profile: {} });
    const { post, targets } = store.createPost(POST, [
      { platform: 'youtube', account: 'main', options: {} },
      { platform: 'facebook', account: 'main', options: {} },
      { platform: 'mastodon', account: 'main', options: { visibility: 'unlisted' } },
      { platform: 'bluesky', account: 'main', options: {} },
      { platform: 'tiktok', account: 'main', options: {} },
    ]);
    const ids = Object.fromEntries(targets.map((t) => [t.platform, t.id]));
    for (const [p, remote, resume] of [['youtube', 'V', undefined], ['facebook', 'R1', undefined], ['mastodon', 'S1', { mediaId: 'm1' }], ['bluesky', 'at://x/y/z', undefined]] as const) {
      store.transition(ids[p]!, 'uploading');
      store.transition(ids[p]!, 'published', { remoteId: remote, resume: resume as Record<string, unknown> | undefined });
    }

    const results = await editPost(ctx, providerMap(), post.id, { title: '새 제목', description: '새 설명', tags: ['new'] });
    const by = Object.fromEntries(results.map((r) => [r.platform, r]));
    assert.deepEqual([by.youtube!.status, by.facebook!.status, by.mastodon!.status], ['updated', 'updated', 'updated']);
    assert.match(by.bluesky!.detail!, /고칠 수 없습니다/);
    assert.match(by.tiktok!.detail!, /바뀐 내용으로 올라갑니다/);
    assert.equal(store.getPost(post.id)!.title, '새 제목');

    const yt = JSON.parse(String(calls.find((c) => c.method === 'PUT' && c.url.includes('youtube'))!.body));
    assert.deepEqual(yt, { id: 'V', snippet: { title: '새 제목', description: '새 설명', tags: ['new'], categoryId: '27', defaultLanguage: 'ko' } }, 'only fields videos.update documents as settable');
    assert.equal(new URLSearchParams(String(calls.find((c) => c.url.endsWith('/R1'))!.body)).get('description'), '새 제목\n\n새 설명\n\n#new');
    assert.deepEqual(JSON.parse(String(calls.find((c) => c.url.includes('/statuses/S1'))!.body)), { status: '새 제목\n\n새 설명\n\n#new', media_ids: ['m1'] });
  });

  it('reports platform failures per target and refuses an empty title', async () => {
    const { fetch } = mockFetch([['PUT', '/api/v1/statuses/S1', () => json({ error: 'Validation failed' }, 422)]]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.saveAccount({ platform: 'mastodon', name: 'main', credentials: { instance: 'https://m.example', token: 'T' }, profile: {} });
    const { post, targets } = store.createPost(POST, [{ platform: 'mastodon', account: 'main', options: { visibility: 'public' } }]);
    store.transition(targets[0]!.id, 'uploading');
    store.transition(targets[0]!.id, 'published', { remoteId: 'S1' });
    const [r] = await editPost(ctx, providerMap(), post.id, { description: 'x' });
    assert.equal(r!.status, 'failed');
    assert.match(r!.detail!, /Validation failed/);
    await assert.rejects(editPost(ctx, providerMap(), post.id, { title: '  ' }), /제목/);
  });
});

describe('changing a published video\'s visibility', () => {
  function setup() {
    const { fetch, calls } = mockFetch([
      ['GET', '/youtube/v3/videos?part=status&id=V', () => json({ items: [{ status: { privacyStatus: 'unlisted', embeddable: false, license: 'youtube', publicStatsViewable: true, selfDeclaredMadeForKids: false, uploadStatus: 'processed' } }] })],
      ['PUT', '/youtube/v3/videos?part=status', () => json({ id: 'V' })],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('youtube', { clientId: 'c', clientSecret: 's' });
    store.saveAccount({ platform: 'youtube', name: 'main', credentials: { accessToken: 'A', refreshToken: 'R', expiresAt: NOW.getTime() + 3600_000 }, profile: {} });
    const { targets } = store.createPost(POST, [{ platform: 'youtube', account: 'main', options: { privacy: 'unlisted', madeForKids: false } }]);
    const id = targets[0]!.id;
    store.transition(id, 'uploading');
    store.transition(id, 'published', { remoteId: 'V' });
    return { ctx, store, calls, id };
  }
  const putBody = (calls: Array<{ method: string; url: string; body: unknown }>) => JSON.parse(String(calls.find((c) => c.method === 'PUT')!.body));

  it('makes it public, keeping the other settable status fields', async () => {
    const { ctx, calls, id } = setup();
    const t = await changeVisibility(ctx, providerMap(), id, 'public');
    assert.deepEqual(putBody(calls), { id: 'V', status: { embeddable: false, license: 'youtube', publicStatsViewable: true, selfDeclaredMadeForKids: false, privacyStatus: 'public' } });
    assert.equal(t.options.privacy, 'public');
  });

  it('schedules it to go public later (private until then)', async () => {
    const { ctx, calls, id } = setup();
    const at = new Date(NOW.getTime() + 86_400_000).toISOString();
    const t = await changeVisibility(ctx, providerMap(), id, 'public', at);
    assert.deepEqual([putBody(calls).status.privacyStatus, putBody(calls).status.publishAt], ['private', at]);
    assert.equal(t.options.publishAt, at);
  });

  it('refuses what YouTube would not take, before calling it', async () => {
    const { ctx, calls, id } = setup();
    await assert.rejects(changeVisibility(ctx, providerMap(), id, 'friends'), /public, unlisted, private/);
    await assert.rejects(changeVisibility(ctx, providerMap(), id, 'public', '2020-01-01T00:00:00Z'), /앞으로의/);
    await assert.rejects(changeVisibility(ctx, providerMap(), id, 'unlisted', new Date(NOW.getTime() + 86_400_000).toISOString()), /public/);
    assert.equal(calls.length, 0);
  });
});
