import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDigest, isoWeek, sendWeeklyDigest } from '../src/core/digest.ts';
import { flushNotifications } from '../src/core/notify.ts';
import type { PostInput } from '../src/core/types.ts';
import { providerMap } from '../src/providers/index.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

describe('weekly digest', () => {
  it('names ISO weeks, years turning on the week\'s Thursday, in a time zone', () => {
    assert.equal(isoWeek(new Date('2026-10-19T01:00:00Z'), 'Asia/Seoul'), '2026-W43');
    assert.equal(isoWeek(new Date('2021-01-03T12:00:00Z'), 'UTC'), '2020-W53');
    assert.equal(isoWeek(new Date('2026-01-01T12:00:00Z'), 'UTC'), '2026-W01');
    // Sunday 20:00 UTC is already Monday in Seoul: next week there.
    assert.equal(isoWeek(new Date('2026-10-18T20:00:00Z'), 'Asia/Seoul'), '2026-W43');
    assert.equal(isoWeek(new Date('2026-10-18T20:00:00Z'), 'UTC'), '2026-W42');
  });

  it('goes once a week, only when picked, with views, the top post and failures', async () => {
    const bodies: Array<Record<string, any>> = [];
    const { fetch } = mockFetch([['POST', 'hooks.example', (c) => {
      bodies.push(JSON.parse(String(c.body)));
      return json({});
    }]]);
    let clock = Date.parse('2026-10-15T00:00:00Z');
    const { ctx, store } = makeCtx(fetch, () => new Date(clock));
    const input: PostInput = { mediaPath: '/v.mp4', title: 'Clip', description: '', tags: [], captions: [], containsSyntheticMedia: false };
    const { targets } = store.createPost(input, [{ platform: 'youtube', account: 'main', options: {} }, { platform: 'x', account: 'main', options: {} }]);
    store.transition(targets[0]!.id, 'uploading');
    store.transition(targets[0]!.id, 'published', { remoteId: 'V' });
    store.saveStats(targets[0]!.id, { fetchedAt: new Date(clock).toISOString(), views: 1234 });
    store.transition(targets[1]!.id, 'uploading');
    store.transition(targets[1]!.id, 'failed', { errorCode: 'x.http_402' });
    clock = Date.parse('2026-10-19T03:00:00Z');

    store.setApp('notify', { url: 'https://hooks.example/x' });
    assert.equal(sendWeeklyDigest(ctx, providerMap()), false, 'not picked by default');
    store.setApp('notify', { url: 'https://hooks.example/x', events: ['failed', 'digest'] });
    assert.equal(sendWeeklyDigest(ctx, providerMap()), true);
    assert.equal(sendWeeklyDigest(ctx, providerMap()), false, 'once a week');
    await flushNotifications();
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.event, 'digest');
    assert.match(bodies[0]!.text, /youtube\/main: 게시물 1개, 조회 1,234 — 최고 "Clip" 1,234/);
    assert.match(bodies[0]!.text, /실패한 게시 1건: x "Clip"/);
    clock += 7 * 86_400_000;
    assert.equal(sendWeeklyDigest(ctx, providerMap()), true, 'next week');
    assert.equal(buildDigest(ctx, providerMap(), 'UTC').week, '2026-W44');
  });
});
