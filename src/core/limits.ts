// Posting limits of every connected account in one place (fanout limits, the dashboard, MCP), so a
// daily cap is seen before an upload runs into it rather than after.

import { withTimeout } from './posting.ts';
import type { Limit, Provider, ProviderContext } from './provider.ts';

export interface AccountLimits {
  platform: string;
  account: string;
  limits: Limit[];
  /** Set when the limits couldn't be read (token, network); `limits` is then empty. */
  error?: string;
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
      out.push({ platform: p, account: name, limits: await provider.limits({ ctx: withTimeout(ctx, timeoutMs), account }) });
    } catch (err) {
      out.push({ platform: p, account: name, limits: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
