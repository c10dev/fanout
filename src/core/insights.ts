import { msg } from './i18n.ts';
import type { Store } from './store.ts';
import type { Target } from './types.ts';

/**
 * What performs, from what fanout already recorded (no platform calls): per platform and account,
 * the posts of the last N days with their latest numbers, and, once there are enough of them, the
 * weekday and time of day whose posts did best a day after going up. A day-later reading compares
 * posts fairly; totals would favour the oldest ones.
 */

export interface InsightPost {
  postId: string;
  title: string;
  views: number;
  url?: string;
}

export interface InsightSlot {
  /** Weekday 0 (Sunday) … 6, or the first hour of a 3-hour block. */
  value: number;
  label: string;
  /** Median views a day after posting, over `posts` posts. */
  medianViews: number;
  posts: number;
}

export interface InsightGroup {
  platform: string;
  account: string;
  posts: number;
  /** Posts with a view count (some platforms don't share views). */
  withViews: number;
  totalViews?: number;
  medianViews?: number;
  /** Likes per 100 views, over the posts that have both. */
  likesPer100Views?: number;
  top: InsightPost[];
  bestWeekday?: InsightSlot;
  bestHours?: InsightSlot;
  /** Why there's no best time yet. */
  note?: string;
}

export interface Insights {
  days: number;
  since: string;
  /** The time zone weekdays and hours are in. */
  timeZone: string;
  groups: InsightGroup[];
}

/** At least this many posts with a day-later reading before naming a best time. */
export const MIN_POSTS_FOR_TIMING = 8;
const DAY_MS = 86_400_000;

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Views about a day after posting: the last reading between 18 and 30 hours after it went up. */
function viewsAfterADay(store: Store, t: Target, postedAt: number): number | undefined {
  const points = store.statsHistory(t.id, new Date(postedAt + 18 * 3600_000).toISOString());
  const inWindow = points.filter((p) => Date.parse(p.at) <= postedAt + 30 * 3600_000 && p.views !== undefined);
  return inWindow.at(-1)?.views;
}

function bestSlot(entries: Array<{ slot: number; views: number }>, label: (v: number) => string): InsightSlot | undefined {
  const by = new Map<number, number[]>();
  for (const e of entries) by.set(e.slot, [...(by.get(e.slot) ?? []), e.views]);
  // A slot needs two posts at least, so one lucky post doesn't decide it.
  const slots = [...by.entries()].filter(([, v]) => v.length >= 2).map(([slot, v]) => ({ value: slot, label: label(slot), medianViews: median(v)!, posts: v.length }));
  slots.sort((a, b) => b.medianViews - a.medianViews || b.posts - a.posts);
  return slots[0];
}

/** A time zone Intl knows (e.g. Asia/Seoul), else undefined. */
export function validTimeZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

export function computeInsights(store: Store, now: Date, opts: { days?: number; platform?: string; timeZone?: string; locale?: string } = {}): Insights {
  const days = opts.days ?? 30;
  const since = new Date(now.getTime() - days * DAY_MS);
  const timeZone = validTimeZone(opts.timeZone) ?? validTimeZone(process.env.FANOUT_TZ) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = new Intl.DateTimeFormat(opts.locale ?? 'ko-KR', { weekday: 'long', timeZone: 'UTC' });
  const weekdayLabel = (d: number) => dayName.format(new Date(Date.UTC(2026, 0, 4 + d)));
  const hoursLabel = (h: number) => `${String(h).padStart(2, '0')}:00–${String(h + 3).padStart(2, '0')}:00`;

  const groups = new Map<string, { platform: string; account: string; items: Array<{ t: Target; title: string; postedAt: number }> }>();
  const posts = new Map<string, ReturnType<Store['getPost']>>();
  for (const t of store.publishedTargets(opts.platform)) {
    if (!posts.has(t.postId)) posts.set(t.postId, store.getPost(t.postId));
    const post = posts.get(t.postId);
    if (!post) continue;
    // When it went public: a native schedule uploads early and goes public at scheduledAt.
    const published = (store.stateSince(t.id, 'published') ?? new Date(post.createdAt)).getTime();
    const postedAt = Math.max(published, post.scheduledAt ? Date.parse(post.scheduledAt) : 0);
    if (postedAt < since.getTime() || postedAt > now.getTime()) continue;
    const key = `${t.platform}/${t.account}`;
    const g = groups.get(key) ?? { platform: t.platform, account: t.account, items: [] };
    g.items.push({ t, title: post.title, postedAt });
    groups.set(key, g);
  }

  const out: InsightGroup[] = [];
  for (const g of groups.values()) {
    const viewed = g.items.filter((i) => typeof i.t.stats?.views === 'number');
    const views = viewed.map((i) => i.t.stats!.views!);
    const both = viewed.filter((i) => typeof i.t.stats?.likes === 'number');
    const viewSum = both.reduce((n, i) => n + i.t.stats!.views!, 0);
    const likeSum = both.reduce((n, i) => n + i.t.stats!.likes!, 0);
    const group: InsightGroup = {
      platform: g.platform,
      account: g.account,
      posts: g.items.length,
      withViews: viewed.length,
      ...(viewed.length ? { totalViews: views.reduce((a, b) => a + b, 0), medianViews: median(views) } : {}),
      ...(viewSum > 0 ? { likesPer100Views: Math.round((likeSum / viewSum) * 1000) / 10 } : {}),
      top: [...viewed]
        .sort((a, b) => b.t.stats!.views! - a.t.stats!.views!)
        .slice(0, 3)
        .map((i) => ({ postId: i.t.postId, title: i.title, views: i.t.stats!.views!, ...(i.t.remoteUrl ? { url: i.t.remoteUrl } : {}) })),
    };
    const timed = g.items
      .map((i) => ({ i, views: viewsAfterADay(store, i.t, i.postedAt) }))
      .filter((x): x is { i: (typeof g.items)[number]; views: number } => x.views !== undefined)
      .map(({ i, views }) => {
        const p = Object.fromEntries(parts.formatToParts(new Date(i.postedAt)).map((x) => [x.type, x.value]));
        return { weekday: WEEKDAYS.indexOf(p.weekday!), block: Math.floor(Number(p.hour) / 3) * 3, views };
      });
    if (timed.length >= MIN_POSTS_FOR_TIMING) {
      group.bestWeekday = bestSlot(timed.map((x) => ({ slot: x.weekday, views: x.views })), weekdayLabel);
      group.bestHours = bestSlot(timed.map((x) => ({ slot: x.block, views: x.views })), hoursLabel);
    } else if (viewed.length) {
      group.note = msg('언제 올리면 좋은지는 하루 뒤 조회수가 기록된 게시물이 {min}개 이상일 때 보여 줍니다 (지금 {n}개)', { min: MIN_POSTS_FOR_TIMING, n: timed.length });
    }
    out.push(group);
  }
  out.sort((a, b) => (b.totalViews ?? -1) - (a.totalViews ?? -1) || a.platform.localeCompare(b.platform));
  return { days, since: since.toISOString(), timeZone, groups: out };
}
