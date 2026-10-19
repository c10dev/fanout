import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeCalendar } from '../src/core/calendar.ts';
import type { PostInput } from '../src/core/types.ts';
import { makeCtx } from './helpers.ts';

const POST = (title: string, scheduledAt?: string): PostInput => ({ mediaPath: '/v.mp4', title, description: '', tags: [], captions: [], containsSyntheticMedia: false, ...(scheduledAt ? { scheduledAt } : {}) });

describe('calendar', () => {
  it('puts posts on their local day from Monday, scheduled ones at their schedule, with each target\'s state', () => {
    let clock = Date.parse('2026-10-19T01:00:00Z'); // Monday 10:00 in Seoul
    const { store } = makeCtx(undefined, () => new Date(clock));
    const done = store.createPost(POST('posted'), [{ platform: 'youtube', account: 'main', options: {} }, { platform: 'x', account: 'main', options: {} }]);
    store.transition(done.targets[0]!.id, 'uploading');
    store.transition(done.targets[0]!.id, 'published', { remoteId: 'V', remoteUrl: 'https://youtu.be/V' });
    // Friday 23:30 UTC is already Saturday in Seoul.
    store.createPost(POST('later', '2026-10-23T23:30:00Z'), [{ platform: 'tiktok', account: 'main', options: {} }]);
    clock = Date.parse('2026-10-20T03:00:00Z');
    const c = computeCalendar(store, new Date(clock), { weeks: 1, timeZone: 'Asia/Seoul', locale: 'en-US' });
    assert.deepEqual([c.from, c.to, c.days.length], ['2026-10-19', '2026-10-25', 7]);
    const mon = c.days[0]!;
    assert.deepEqual([mon.weekday, mon.items[0]!.title, mon.items[0]!.time, mon.items[0]!.scheduled], ['Mon', 'posted', '10:00', false]);
    assert.deepEqual(mon.items[0]!.targets.map((t) => `${t.platform}:${t.state}`).sort(), ['x:queued', 'youtube:published']);
    assert.equal(c.days[1]!.today, true);
    const sat = c.days[5]!;
    assert.deepEqual([sat.date, sat.items[0]!.title, sat.items[0]!.time, sat.items[0]!.scheduled], ['2026-10-24', 'later', '08:30', true]);
  });

  it('moves by weeks and keeps to the range', () => {
    const { store } = makeCtx(undefined, () => new Date('2026-10-05T00:00:00Z'));
    store.createPost(POST('two weeks ago'), [{ platform: 'youtube', account: 'main', options: {} }]);
    const now = new Date('2026-10-19T12:00:00Z');
    assert.equal(computeCalendar(store, now, { weeks: 1, timeZone: 'UTC' }).days.flatMap((d) => d.items).length, 0);
    const back = computeCalendar(store, now, { weeks: 1, offset: -2, timeZone: 'UTC' });
    assert.deepEqual([back.from, back.days.flatMap((d) => d.items).map((i) => i.title)], ['2026-10-05', ['two weeks ago']]);
    assert.doesNotThrow(() => computeCalendar(store, now, { offset: Infinity }));
    assert.doesNotThrow(() => computeCalendar(store, now, { offset: 1e300 }));
  });
});
