// Posting limits of every connected account in one place (fanout limits, the dashboard, MCP), so a
// daily cap is seen before an upload runs into it rather than after.

import { msg } from './i18n.ts';
import { formatBytes } from './prune.ts';
import type { Limit, Provider, ProviderContext } from './provider.ts';

export interface AccountLimits {
  platform: string;
  account: string;
  limits: Limit[];
  /** Set when the limits couldn't be read (token, network); `limits` is then empty. */
  error?: string;
}

/**
 * Stop waiting after `ms`, without aborting the requests: a limits read may refresh a token first,
 * and a token rotation cut off mid-way (PeerTube, Bluesky) would lose the new pair. The read
 * finishes in the background and saves what it got.
 */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg('{seconds}초 안에 답이 없습니다', { seconds: ms / 1000 }))), ms);
    timer.unref();
  });
  work.catch(() => undefined);
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Read the limits of every account (or one platform's) whose provider can tell them, one at a time. */
export async function readLimits(ctx: ProviderContext, providers: Map<string, Provider>, platform?: string, timeoutMs = 20_000): Promise<AccountLimits[]> {
  const out: AccountLimits[] = [];
  for (const { platform: p, name } of ctx.store.listAccounts()) {
    if (platform && p !== platform) continue;
    const provider = providers.get(p);
    const account = ctx.store.getAccount(p, name);
    if (!provider?.limits || !account) continue;
    try {
      // One stuck host must not hold up the rest (or the dashboard card) for minutes.
      out.push({ platform: p, account: name, limits: await within(provider.limits({ ctx, account }), timeoutMs) });
    } catch (err) {
      out.push({ platform: p, account: name, limits: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * Warnings for a planned post from its target accounts' limits: nothing left, little left, or a
 * video bigger than the bytes left. Warnings only, never errors: a 24-hour window may free up by
 * the scheduled time, and YouTube's number is fanout's own count. A limit that can't be read is
 * left out, so a preview never fails over it.
 */
export async function addLimitWarnings(
  ctx: ProviderContext,
  providers: Map<string, Provider>,
  previews: Array<{ platform: string; account: string; warnings: string[] }>,
  sizeBytes: number,
  timeoutMs = 8_000,
): Promise<void> {
  const read = new Map<string, Promise<Limit[]>>();
  for (const p of previews) {
    const key = `${p.platform}/${p.account}`;
    const provider = providers.get(p.platform);
    const account = ctx.store.getAccount(p.platform, p.account);
    if (!provider?.limits || !account || read.has(key)) continue;
    read.set(key, within(provider.limits({ ctx, account }), timeoutMs).catch(() => []));
  }
  for (const p of previews) {
    const limits = await (read.get(`${p.platform}/${p.account}`) ?? Promise.resolve([]));
    for (const l of limits) {
      const warning = limitWarning(l, sizeBytes);
      if (warning) p.warnings.push(warning);
    }
  }
}

function limitWarning(l: Limit, sizeBytes: number): string | undefined {
  if (l.unlimited || l.remaining === undefined) return undefined;
  const n = (v: number) => (l.unit === 'bytes' ? formatBytes(v) : String(v));
  if (l.remaining === 0) {
    return l.note
      ? msg('{what}: 남은 한도가 없습니다 ({note}). 지금 올리면 거부될 수 있습니다', { what: l.what, note: l.note })
      : msg('{what}: 남은 한도가 없습니다. 지금 올리면 거부될 수 있습니다', { what: l.what });
  }
  if (l.unit === 'bytes' && sizeBytes > l.remaining) return msg('{what}: 영상({size})이 남은 {remaining}보다 큽니다', { what: l.what, size: formatBytes(sizeBytes), remaining: n(l.remaining) });
  if (l.unit === 'posts' && l.total && l.remaining / l.total < 0.1) return msg('{what}: 한도가 얼마 남지 않았습니다 ({used}/{total})', { what: l.what, used: n(l.used ?? l.total - l.remaining), total: n(l.total) });
  return undefined;
}
