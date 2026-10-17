import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachNotifier, detectFormat, flushNotifications, messageFor, payloadFor } from '../src/core/notify.ts';
import type { PostInput } from '../src/core/types.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const POST: PostInput = { mediaPath: '/v.mp4', title: '첫 영상', description: '', tags: [], captions: [], containsSyntheticMedia: false };

describe('notifications', () => {
  it('detects Slack and Discord webhooks', () => {
    assert.equal(detectFormat('https://hooks.slack.com/services/T/B/x'), 'slack');
    assert.equal(detectFormat('https://discord.com/api/webhooks/1/abc'), 'discord');
    assert.equal(detectFormat('https://example.com/hook'), 'json');
  });

  it('builds readable messages and per-format payloads', () => {
    const post = { ...POST, id: 'p', createdAt: '' };
    const t = { id: 't', postId: 'p', platform: 'youtube', account: 'main', options: {}, state: 'failed' as const, warnings: [], attempts: 1, updatedAt: '', errorCode: 'youtube.quota', errorMessage: '한도 초과' };
    const text = messageFor(post, t);
    assert.equal(text, '❌ youtube/main 실패: "첫 영상"\nyoutube.quota 한도 초과');
    assert.deepEqual(payloadFor('slack', text, post, t), { text });
    assert.deepEqual(payloadFor('discord', text, post, t), { content: text });
    assert.equal((payloadFor('json', text, post, t) as { error: { code: string } }).error.code, 'youtube.quota');
  });

  it('sends on configured states only, and never breaks a transition', async () => {
    let fail = false;
    const { fetch, calls } = mockFetch([['POST', 'hooks.slack.com', () => (fail ? json({}, 500) : json({ ok: true }))]]);
    const { ctx, store } = makeCtx(fetch);
    attachNotifier(ctx);
    store.setApp('notify', { url: 'https://hooks.slack.com/services/T/B/x', events: ['failed', 'published'] });
    const { targets } = store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }]);
    const id = targets[0]!.id;
    store.transition(id, 'uploading');
    await flushNotifications();
    assert.equal(calls.length, 0, 'uploading is not notified');
    store.transition(id, 'published', { remoteUrl: 'https://youtu.be/V' });
    await flushNotifications();
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(String(calls[0]!.body)), { text: '✅ youtube/main 게시됨: "첫 영상"\nhttps://youtu.be/V' });

    fail = true;
    store.transition(id, 'removed');
    await flushNotifications();
    assert.equal(calls.length, 1, 'removed not in the configured events');
  });

  it('lets FANOUT_WEBHOOK_URL override the saved webhook', async () => {
    const { fetch, calls } = mockFetch([['POST', 'example.com/env', () => json({})]]);
    const { ctx, store } = makeCtx(fetch);
    attachNotifier(ctx);
    store.setApp('notify', { url: 'https://hooks.slack.com/services/saved' });
    process.env.FANOUT_WEBHOOK_URL = 'https://example.com/env';
    try {
      const { targets } = store.createPost(POST, [{ platform: 'youtube', account: 'main', options: {} }]);
      store.transition(targets[0]!.id, 'failed', { errorCode: 'x' });
      await flushNotifications();
    } finally {
      delete process.env.FANOUT_WEBHOOK_URL;
    }
    assert.equal(calls.length, 1);
    assert.equal((JSON.parse(String(calls[0]!.body)) as { state: string }).state, 'failed');
  });
});
