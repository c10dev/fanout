import type { Store } from './store.ts';
import type { Post, Target } from './types.ts';

export interface ExportRow {
  postId: string;
  createdAt: string;
  title: string;
  scheduledAt: string;
  platform: string;
  account: string;
  state: Target['state'];
  url: string;
  error: string;
  views: string;
  likes: string;
  comments: string;
  shares: string;
  reach: string;
  saves: string;
  avgWatchSec: string;
  watchTimeSec: string;
  avgViewPct: string;
  subscribersGained: string;
  statsAt: string;
}

/** One row per post × platform target: what went where, how it ended, and the last known stats. */
export function exportRows(store: Store, limit = 100_000): ExportRow[] {
  const rows: ExportRow[] = [];
  const posts: Post[] = store.listPosts(limit);
  for (const p of posts) {
    for (const t of store.targetsForPost(p.id)) {
      const n = (v?: number) => (v === undefined ? '' : String(v));
      rows.push({
        postId: p.id,
        createdAt: p.createdAt,
        title: p.title,
        scheduledAt: p.scheduledAt ?? '',
        platform: t.platform,
        account: t.account,
        state: t.state,
        url: t.remoteUrl ?? '',
        error: t.errorCode ? `${t.errorCode}: ${t.errorMessage ?? ''}` : '',
        views: n(t.stats?.views),
        likes: n(t.stats?.likes),
        comments: n(t.stats?.comments),
        shares: n(t.stats?.shares),
        reach: n(t.stats?.reach),
        saves: n(t.stats?.saves),
        avgWatchSec: n(t.stats?.avgWatchSec),
        watchTimeSec: n(t.stats?.watchTimeSec),
        avgViewPct: n(t.stats?.avgViewPct),
        subscribersGained: n(t.stats?.subscribersGained),
        statsAt: t.stats?.fetchedAt ?? '',
      });
    }
  }
  return rows;
}

/** RFC 4180 CSV with a BOM so spreadsheet apps open Korean text correctly. */
export function toCsv(rows: ExportRow[]): string {
  const cols: Array<keyof ExportRow> = ['postId', 'createdAt', 'title', 'scheduledAt', 'platform', 'account', 'state', 'url', 'error', 'views', 'likes', 'comments', 'shares', 'statsAt', 'reach', 'saves', 'avgWatchSec', 'watchTimeSec', 'avgViewPct', 'subscribersGained'];
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  // Cells starting with = + - @ would run as formulas in spreadsheets; prefix them.
  const safe = (v: string) => (/^[=+\-@]/.test(v) ? `'${v}` : v);
  return `\uFEFF${[cols.join(','), ...rows.map((r) => cols.map((c) => cell(safe(String(r[c])))).join(','))].join('\r\n')}\r\n`;
}
