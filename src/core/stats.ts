import type { Provider, ProviderContext } from './provider.ts';
import type { Store } from './store.ts';
import type { StatsTrend } from './types.ts';

/** How long after a hand-off fanout keeps looking for the post the creator finished in the app. */
export const FIND_HANDED_OFF_DAYS = 14;

const METRICS = ['views', 'likes', 'comments', 'shares'] as const;

/**
 * How much each count grew over the last `hours`: the latest reading minus the latest one at least
 * that old. Undefined until a reading that old exists, so a young post shows no misleading jump.
 */
export function statsTrend(store: Store, targetId: string, now: Date, hours = 24): StatsTrend | undefined {
  // However old the baseline is (a CLI user may read only every few days), it is the latest one
  // from before the window.
  const base = store.statsBaseline(targetId, new Date(now.getTime() - hours * 3600_000).toISOString());
  const latest = store.latestStats(targetId);
  if (!base || !latest || latest.at === base.at) return undefined;
  const trend: StatsTrend = { since: base.at };
  for (const m of METRICS) {
    if (latest[m] !== undefined && base[m] !== undefined) trend[m] = latest[m]! - base[m]!;
  }
  return trend;
}

/**
 * Recorded view counts of a target over the last `days`, thinned to at most `max` points spread
 * evenly (the latest always kept), for a small chart. Undefined until there are two readings.
 */
export function viewsSeries(store: Store, targetId: string, now: Date, days = 30, max = 24): Array<{ at: string; views: number }> | undefined {
  const points = store
    .viewsHistory(targetId, new Date(now.getTime() - days * 86_400_000).toISOString())
  if (points.length < 2) return undefined;
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}

export interface AutoStatsOptions {
  /** Re-read a target's stats once they are this old. */
  everyMs: number;
  /** Stop following posts older than this. */
  windowDays?: number;
  /** At most this many targets per run, to stay gentle on quotas. */
  limit?: number;
}

/**
 * Re-read stats of recently published targets that are due, skipping platforms that can't read
 * them or charge for it (X). Returns how many targets were refreshed. Every reading lands in the
 * stats history, which is where trends come from.
 */
export async function refreshDueStats(
  ctx: ProviderContext,
  providers: Map<string, Provider>,
  refresh: (postId: string, platform: string) => Promise<unknown>,
  opts: AutoStatsOptions,
): Promise<number> {
  const now = ctx.now().getTime();
  const readable = [...providers.values()].filter((p) => p.stats && !p.statsCost).map((p) => p.id);
  const stale = new Date(now - opts.everyMs).toISOString();
  const due = ctx.store.statsDue(new Date(now - (opts.windowDays ?? 30) * 86_400_000).toISOString(), stale, readable, opts.limit ?? 50);
  // Posts finished in the platform app: look for them on the same rhythm while they are recent.
  const findable = [...providers.values()].filter((p) => p.findHandedOff).map((p) => p.id);
  due.push(...ctx.store.statsDue(new Date(now - FIND_HANDED_OFF_DAYS * 86_400_000).toISOString(), stale, findable, opts.limit ?? 50, 'handed_off'));
  // One call per post and platform covers every account of that platform on the post.
  const done = new Set<string>();
  for (const t of due) {
    const key = `${t.postId}/${t.platform}`;
    if (done.has(key)) continue;
    done.add(key);
    try {
      await refresh(t.postId, t.platform);
    } catch (err) {
      ctx.log.warn(`stats(${t.platform}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return done.size;
}
