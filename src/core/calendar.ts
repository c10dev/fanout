import { validTimeZone } from './insights.ts';
import type { Store } from './store.ts';
import type { TargetState } from './types.ts';

/**
 * Week by week, what goes out and what went out: each day of the weeks asked for, with the posts
 * whose time (their schedule, or when they were made) falls on it, in a time zone. From the store
 * only; nothing is read from the platforms.
 */

export interface CalendarItem {
  postId: string;
  title: string;
  /** ISO time of the post: its schedule, or when it was made. */
  at: string;
  /** Local time of day, HH:MM. */
  time: string;
  scheduled: boolean;
  targets: Array<{ platform: string; account: string; state: TargetState; url?: string }>;
}

export interface CalendarDay {
  /** YYYY-MM-DD in the time zone. */
  date: string;
  weekday: string;
  today: boolean;
  items: CalendarItem[];
}

export interface Calendar {
  timeZone: string;
  from: string;
  to: string;
  days: CalendarDay[];
}

const DAY_MS = 86_400_000;

/** Parts of an instant in a time zone. */
function local(at: Date, timeZone: string): { date: string; weekday: number; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!), time: `${p.hour}:${p.minute}` };
}

/**
 * `weeks` weeks from the Monday of the week `offset` weeks away from now (0: this week). The range
 * is read a day wider on each side in UTC and then grouped by local date, so time zones far from
 * UTC still land on the right day.
 */
export function computeCalendar(store: Store, now: Date, opts: { weeks?: number; offset?: number; timeZone?: string; locale?: string } = {}): Calendar {
  const weeks = Math.min(Math.max(Math.floor(opts.weeks ?? 2), 1), 8);
  const timeZone = validTimeZone(opts.timeZone) ?? validTimeZone(process.env.FANOUT_TZ) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = local(now, timeZone);
  // The local Monday, as a calendar date (UTC midnight stands for it while counting days).
  const todayUtc = Date.parse(`${today.date}T00:00:00Z`);
  // About ten years either way: past that a date can't be written (and nothing is there).
  const offset = Number.isFinite(opts.offset) ? Math.max(-520, Math.min(520, Math.trunc(opts.offset!))) : 0;
  const monday = todayUtc - ((today.weekday + 6) % 7) * DAY_MS + offset * 7 * DAY_MS;
  const dates = Array.from({ length: weeks * 7 }, (_, i) => new Date(monday + i * DAY_MS).toISOString().slice(0, 10));
  const dayName = new Intl.DateTimeFormat(opts.locale ?? 'ko-KR', { weekday: 'short', timeZone: 'UTC' });
  const days = new Map<string, CalendarDay>(
    dates.map((d) => [d, { date: d, weekday: dayName.format(new Date(`${d}T00:00:00Z`)), today: d === today.date, items: [] }]),
  );
  const from = new Date(monday - DAY_MS).toISOString();
  const to = new Date(monday + (weeks * 7 + 1) * DAY_MS).toISOString();
  for (const post of store.postsBetween(from, to)) {
    const at = post.scheduledAt ?? post.createdAt;
    const l = local(new Date(at), timeZone);
    const day = days.get(l.date);
    if (!day) continue;
    day.items.push({
      postId: post.id,
      title: post.title,
      at,
      time: l.time,
      scheduled: Boolean(post.scheduledAt),
      targets: store.targetsForPost(post.id).map((t) => ({ platform: t.platform, account: t.account, state: t.state, ...(t.remoteUrl ? { url: t.remoteUrl } : {}) })),
    });
  }
  for (const d of days.values()) d.items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { timeZone, from: dates[0]!, to: dates.at(-1)!, days: [...days.values()] };
}
