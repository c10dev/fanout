import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeInsights, MIN_POSTS_FOR_TIMING } from '../src/core/insights.ts';
import type { PostInput } from '../src/core/types.ts';
import { makeCtx } from './helpers.ts';

const POST = (title: string): PostInput => ({ mediaPath: '/v.mp4', title, description: '', tags: [], captions: [], containsSyntheticMedia: false });
const H = 3600_000;

describe('insights', () => {
  function setup() {
    let clock = Date.parse('2026-09-01T00:00:00Z');
    const env = makeCtx(undefined, () => new Date(clock));
    /** Publish at `at`, read views a day later (`day1`) and now (`total`). */
    const publish = (title: string, at: number, day1: number | undefined, total: number, platform = 'youtube', likes?: number) => {
      clock = at;
      const { targets } = env.store.createPost(POST(title), [{ platform, account: 'main', options: {} }]);
      const id = targets[0]!.id;
      env.store.transition(id, 'uploading');
      env.store.transition(id, 'published', { remoteId: title, remoteUrl: `https://example.com/${title}` });
      if (day1 !== undefined) env.store.recordStats(id, { fetchedAt: new Date(at + 24 * H).toISOString(), views: day1 });
      env.store.saveStats(id, { fetchedAt: new Date(at + 48 * H).toISOString(), views: total, ...(likes !== undefined ? { likes } : {}) });
      return id;
    };
    return { env, publish, setClock: (t: number) => (clock = t) };
  }

  it('sums, ranks and holds back the best time until there are enough posts', () => {
    const { env, publish, setClock } = setup();
    const fri = Date.parse('2026-09-04T10:00:00Z'); // Friday 19:00 in Seoul
    publish('a', fri, 100, 500, 'youtube', 50);
    publish('b', fri + 7 * 24 * H, 120, 300, 'youtube', 30);
    publish('c', fri + 14 * 24 * H, undefined, 50, 'youtube');
    setClock(Date.parse('2026-09-30T00:00:00Z'));
    const r = computeInsights(env.store, new Date(Date.parse('2026-09-30T00:00:00Z')), { days: 30, timeZone: 'Asia/Seoul' });
    const g = r.groups[0]!;
    assert.deepEqual([g.platform, g.posts, g.withViews, g.totalViews, g.medianViews, g.likesPer100Views], ['youtube', 3, 3, 850, 300, 10]);
    assert.deepEqual(g.top.map((t) => t.title), ['a', 'b', 'c']);
    assert.equal(g.bestWeekday, undefined);
    assert.match(g.note!, new RegExp(`${MIN_POSTS_FOR_TIMING}`));
  });

  it('names the weekday and 3-hour block whose posts did best a day later', () => {
    const { env, publish } = setup();
    const mon = Date.parse('2026-08-31T00:00:00Z'); // Monday 09:00 in Seoul
    for (let w = 0; w < 4; w++) {
      publish(`fri${w}`, mon + w * 7 * 24 * H + 4 * 24 * H + 10 * H, 900 + w, 1000); // Friday 19:00 KST
      publish(`mon${w}`, mon + w * 7 * 24 * H, 100 + w, 5000); // Monday 09:00 KST: bigger totals, weaker first day
    }
    const now = new Date(mon + 30 * 24 * H);
    const g = computeInsights(env.store, now, { days: 31, timeZone: 'Asia/Seoul', locale: 'en-US' }).groups[0]!;
    assert.deepEqual([g.bestWeekday!.label, g.bestWeekday!.posts], ['Friday', 4]);
    assert.equal(g.bestHours!.label, '18:00–21:00');
    assert.equal(g.top[0]!.title.startsWith('mon'), true, 'totals still rank the top posts');
  });

  it('a natively scheduled post counts from when it goes public, and not before', () => {
    let clock = Date.parse('2026-09-07T00:00:00Z'); // uploaded Monday
    const env = makeCtx(undefined, () => new Date(clock));
    const goesPublic = '2026-09-11T10:00:00.000Z'; // Friday 19:00 in Seoul
    const { targets } = env.store.createPost({ ...POST('sched'), scheduledAt: goesPublic }, [{ platform: 'youtube', account: 'main', options: {} }]);
    env.store.transition(targets[0]!.id, 'uploading');
    env.store.transition(targets[0]!.id, 'published', { remoteId: 'S' });
    env.store.saveStats(targets[0]!.id, { fetchedAt: '2026-09-08T00:00:00Z', views: 0 });
    assert.equal(computeInsights(env.store, new Date('2026-09-10T00:00:00Z'), { days: 30 }).groups.length, 0, 'not public yet');
    clock = Date.parse('2026-09-20T00:00:00Z');
    assert.equal(computeInsights(env.store, new Date(clock), { days: 30 }).groups[0]!.posts, 1);
  });

  it('keeps to the window and the platform asked for', () => {
    const { env, publish } = setup();
    const t = Date.parse('2026-09-10T00:00:00Z');
    publish('old', t - 40 * 24 * H, 10, 10);
    publish('x1', t, 10, 10, 'x');
    publish('yt', t, 10, 10);
    const r = computeInsights(env.store, new Date(t + 24 * H), { days: 30, platform: 'youtube' });
    assert.deepEqual(r.groups.map((g) => `${g.platform}:${g.top.map((p) => p.title).join(',')}`), ['youtube:yt']);
  });
});
