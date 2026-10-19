import { msg } from './i18n.ts';
import { computeInsights, validTimeZone } from './insights.ts';
import type { Store } from './store.ts';
import type { TargetState } from './types.ts';

/**
 * When to schedule next, for a set of accounts: the coming hours that match the weekday and
 * 3-hour block insights found best for them (once there are enough posts to say), else early
 * evening, and never close to something already going out on the same account. From the store
 * only; nothing is read from the platforms and nothing is scheduled.
 */

export interface TimeSuggestion {
  /** The instant, ISO. */
  at: string;
  /** The same in the time zone, YYYY-MM-DDTHH:MM (what a datetime-local field takes). */
  local: string;
  /** Short and readable, e.g. "Fri 10/23 19:00". */
  label: string;
  /** Why this time: one message per reason (each translates on its own). */
  reasons: string[];
  basis: 'history' | 'default';
}

export interface TimeSuggestions {
  timeZone: string;
  suggestions: TimeSuggestion[];
  /** When the past says nothing yet. */
  note?: string;
}

export interface SuggestOptions {
  accounts: Array<{ platform: string; account: string }>;
  timeZone?: string;
  locale?: string;
  /** Up to this many, default 3. */
  count?: number;
  /** Keep this far from other posts on the same accounts and from each other, default 4. */
  gapHours?: number;
  /** Look this far ahead, default 14 days. */
  days?: number;
}

const H = 3600_000;
/** Without history: early evening, when short video is watched most. */
const DEFAULT_HOURS = new Set([18, 19, 20]);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Local date, weekday, hour and minute of instants in a time zone. */
function inZone(timeZone: string): (at: Date) => { date: string; weekday: number; hour: number; minute: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return (at) => {
    const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, weekday: WEEKDAYS.indexOf(p.weekday!), hour: Number(p.hour), minute: Number(p.minute) };
  };
}

/** Still on its way: it goes out at its schedule, or now. */
const PENDING: readonly TargetState[] = ['queued', 'transcoding', 'uploading', 'processing', 'needs_reauth'];

/**
 * When each of these accounts has something going out or just gone out: per target, not per post,
 * since a platform added later or a retry goes out long after the post was made.
 */
function takenTimes(store: Store, now: Date, accounts: SuggestOptions['accounts'], gap: number, horizon: number): number[] {
  const from = now.getTime() - gap;
  const to = now.getTime() + horizon + gap;
  // Posts scheduled in the window: a native schedule goes public then, long after its upload.
  const ahead = new Map(
    store
      .postsBetween(new Date(from).toISOString(), new Date(to).toISOString())
      .filter((p) => p.scheduledAt)
      .map((p) => [p.id, Date.parse(p.scheduledAt!)]),
  );
  const scheduledAt = (postId: string) => (ahead.get(postId) ?? Date.parse(store.getPost(postId)?.scheduledAt ?? '')) || 0;
  const out: number[] = [];
  for (const { platform, account } of accounts) {
    for (const state of PENDING) for (const t of store.targetsInState(platform, account, state)) out.push(Math.max(now.getTime(), scheduledAt(t.postId)));
    for (const state of ['published', 'handed_off'] as const) {
      for (const t of store.targetsInState(platform, account, state)) {
        // It went out at or before its last update, unless it goes public at a schedule still ahead.
        if (Date.parse(t.updatedAt) < from && !ahead.has(t.postId)) continue;
        out.push(Math.max((store.stateSince(t.id, state) ?? new Date(t.updatedAt)).getTime(), scheduledAt(t.postId)));
      }
    }
  }
  return out.filter((at) => at >= from && at <= to);
}

export function suggestTimes(store: Store, now: Date, opts: SuggestOptions): TimeSuggestions {
  const timeZone = validTimeZone(opts.timeZone) ?? validTimeZone(process.env.FANOUT_TZ) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const count = Math.min(Math.max(Math.floor(opts.count ?? 3), 1), 10);
  const gap = Math.min(Math.max(opts.gapHours ?? 4, 0), 48) * H;
  const horizon = Math.min(Math.max(opts.days ?? 14, 1), 60) * 24 * H;
  const parts = inZone(timeZone);
  const wanted = new Set(opts.accounts.map((a) => `${a.platform}/${a.account}`));

  // What the past says, per account asked about.
  const groups = computeInsights(store, now, { days: 90, timeZone, locale: opts.locale }).groups.filter((g) => wanted.has(`${g.platform}/${g.account}`));
  const weekdays = groups.flatMap((g) => (g.bestWeekday ? [{ who: `${g.platform}/${g.account}`, value: g.bestWeekday.value, label: g.bestWeekday.label }] : []));
  const blocks = groups.flatMap((g) => (g.bestHours ? [{ who: `${g.platform}/${g.account}`, value: g.bestHours.value, label: g.bestHours.label }] : []));
  const history = weekdays.length > 0 || blocks.length > 0;

  const taken = takenTimes(store, now, opts.accounts, gap, horizon);

  // Every whole local hour from an hour ahead (quarter-hour steps catch zones offset by :30 and :45).
  const candidates: Array<{ at: number; score: number; reasons: string[]; basis: TimeSuggestion['basis'] }> = [];
  const STEP = 15 * 60_000;
  const start = Math.ceil((now.getTime() + H) / STEP) * STEP;
  for (let at = start; at <= now.getTime() + horizon; at += STEP) {
    const l = parts(new Date(at));
    if (l.minute !== 0) continue;
    if (taken.some((t) => Math.abs(t - at) < gap)) continue;
    let score = 0;
    const reasons: string[] = [];
    for (const b of blocks) {
      if (l.hour >= b.value && l.hour < b.value + 3) {
        score += 2;
        reasons.push(msg('{account}: {label}에 올린 게시물이 하루 뒤 가장 많이 보였습니다', { account: b.who, label: b.label }));
      }
    }
    for (const w of weekdays) {
      if (l.weekday === w.value) {
        score += 1;
        reasons.push(msg('{account}: {label}에 올린 게시물이 가장 잘 됐습니다', { account: w.who, label: w.label }));
      }
    }
    const fromHistory = reasons.length > 0;
    // Early evening fills in: with no history, or when the hours history names are all taken.
    if (!fromHistory && DEFAULT_HOURS.has(l.hour)) {
      score += 0.5;
      reasons.push(history ? msg('저녁 시간(18–21시)') : msg('아직 기록이 적어 저녁 시간(18–21시)을 권합니다'));
    }
    // Sooner is better among equals: a small nudge that never outweighs a match.
    if (score > 0) candidates.push({ at, score: score - (at - now.getTime()) / horizon / 10, reasons, basis: fromHistory ? 'history' : 'default' });
  }

  candidates.sort((a, b) => b.score - a.score || a.at - b.at);
  const chosen: typeof candidates = [];
  for (const c of candidates) {
    if (chosen.length >= count) break;
    if (chosen.some((x) => Math.abs(x.at - c.at) < Math.max(gap, H))) continue;
    chosen.push(c);
  }
  chosen.sort((a, b) => a.at - b.at);

  const label = new Intl.DateTimeFormat(opts.locale ?? 'ko-KR', { timeZone, weekday: 'short', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const suggestions = chosen.map((c) => {
    const l = parts(new Date(c.at));
    return { at: new Date(c.at).toISOString(), local: `${l.date}T${String(l.hour).padStart(2, '0')}:00`, label: label.format(new Date(c.at)), reasons: c.reasons, basis: c.basis };
  });
  return {
    timeZone,
    suggestions,
    ...(history ? {} : { note: msg('하루 뒤 조회수가 기록된 게시물이 계정마다 몇 개 더 쌓이면 그 계정에 맞는 시간을 권합니다') }),
  };
}
