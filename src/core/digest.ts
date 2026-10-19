import { signInExpiry } from './accounts.ts';
import { msg } from './i18n.ts';
import { computeInsights, validTimeZone } from './insights.ts';
import { notifyConfig, notifyEvent, DEFAULT_EVENTS } from './notify.ts';
import type { Provider, ProviderContext } from './provider.ts';

/**
 * Once a week, the week in short through the notify webhook (the `digest` event, off unless picked):
 * posts and views per platform with the top post, posts that failed, and sign-ins about to end. From
 * what fanout recorded; no platform calls. The week it was sent for is kept, so it goes once.
 */

/** ISO week of a moment in a time zone, e.g. "2026-W43". */
export function isoWeek(at: Date, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
  const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  // The week's Thursday decides its year (ISO 8601).
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function buildDigest(ctx: ProviderContext, providers: Map<string, Provider>, timeZone?: string): { week: string; text: string; data: Record<string, unknown> } {
  const tz = validTimeZone(timeZone) ?? validTimeZone(process.env.FANOUT_TZ) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = ctx.now();
  const insights = computeInsights(ctx.store, now, { days: 7, timeZone: tz });
  const since = now.getTime() - 7 * 86_400_000;
  const failed = ctx.store
    .listPosts(500)
    .flatMap((p) => ctx.store.targetsForPost(p.id).filter((t) => t.state === 'failed' && Date.parse(t.updatedAt) >= since).map((t) => ({ title: p.title, platform: t.platform, account: t.account })));
  const expiring = ctx.store
    .listAccounts()
    .map((a) => ({ platform: a.platform, account: a.name, expiry: signInExpiry(ctx, providers, a.platform, a.name) }))
    .filter((a) => a.expiry?.soon)
    .map((a) => ({ platform: a.platform, account: a.account, expiresAt: new Date(a.expiry!.expiresAt).toISOString() }));
  const fmt = (n?: number) => (n === undefined ? '-' : n.toLocaleString('en-US'));
  const lines = [msg('📊 fanout 주간 요약 (최근 7일)')];
  if (!insights.groups.length) lines.push(msg('게시된 영상이 없습니다'));
  for (const g of insights.groups) {
    const top = g.top[0];
    lines.push(msg('{platform}/{account}: 게시물 {posts}개, 조회 {views}', { platform: g.platform, account: g.account, posts: g.posts, views: fmt(g.totalViews) }) + (top ? ` — ${msg('최고 "{title}" {views}', { title: top.title, views: fmt(top.views) })}` : ''));
  }
  if (failed.length) lines.push(msg('실패한 게시 {n}건: {list}', { n: failed.length, list: failed.slice(0, 5).map((f) => `${f.platform} "${f.title}"`).join(', ') }));
  for (const e of expiring) lines.push(msg('🔑 {platform}/{account} 로그인 만료 {date}', { platform: e.platform, account: e.account, date: e.expiresAt.slice(0, 10) }));
  return { week: isoWeek(now, tz), text: lines.join('\n'), data: { groups: insights.groups, failed, expiring } };
}

/** Send this week's digest if it is picked and hasn't gone yet. Resolves whether it was sent. */
export function sendWeeklyDigest(ctx: ProviderContext, providers: Map<string, Provider>): boolean {
  const config = notifyConfig(ctx);
  if (!config || !(config.events ?? DEFAULT_EVENTS).includes('digest')) return false;
  const digest = buildDigest(ctx, providers);
  const last = ctx.store.getApp<{ week?: string }>('notify-digest')?.week;
  if (last === digest.week) return false;
  // Marked first: a webhook that is down loses one digest rather than sending it every few hours.
  ctx.store.setApp('notify-digest', { week: digest.week });
  notifyEvent(ctx, 'digest', digest.text, { week: digest.week, ...digest.data });
  return true;
}
