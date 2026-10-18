// Account upkeep that platform terms ask for. YouTube's Developer Policies (III.D.2, III.E.4) let
// fanout keep statistics only while it re-checks the user's authorization every 30 days, other
// API data (the channel title) only if re-read within 30 days, and ask for the data to go within
// 7 days of a disconnect and within 30 days of access being revoked on Google's side.

import { ProviderError } from './errors.ts';
import { msg } from './i18n.ts';
import type { Provider, ProviderContext } from './provider.ts';

const DAY_MS = 86_400_000;
/** Re-check each account this often (well inside the 30 days). */
export const VERIFY_EVERY_MS = DAY_MS;
/**
 * How long access may stay refused before the account's platform data is deleted. Not at the first
 * refusal: a consent screen left in "Testing" expires tokens the same way, and the user may just
 * reconnect. Checked daily, so deletion lands by day 22, inside the 30 days.
 */
export const FORGET_AFTER_MS = 21 * DAY_MS;

/** Kept in the account's (encrypted) credentials, never shown to the browser. */
interface Upkeep {
  /** Last check, successful or not. */
  checkedAt?: number;
  authFailedAt?: number;
  forgottenAt?: number;
}

/**
 * Disconnect one account: let the provider revoke its tokens and forget restricted data, then
 * remove it. A failed revoke is logged; the data goes and the account is removed anyway. Resolves
 * false when there was no such account.
 */
export async function disconnectAccount(ctx: ProviderContext, providers: Map<string, Provider>, platform: string, name: string): Promise<boolean> {
  const account = ctx.store.getAccount(platform, name);
  if (!account) return false;
  const provider = providers.get(platform);
  try {
    await provider?.disconnect?.(ctx, account);
  } catch (err) {
    ctx.log.warn(msg('{platform}/{name}: 토큰을 철회하지 못했습니다 ({err}). 계정은 지웁니다', { platform, name, err: err instanceof Error ? err.message : String(err) }));
  }
  provider?.forget?.(ctx, account);
  return ctx.store.removeAccount(platform, name);
}

/**
 * Verify accounts whose last check is older than VERIFY_EVERY_MS. Success refreshes the stored
 * profile and clears a past refusal; an auth refusal is remembered, and once it has lasted
 * FORGET_AFTER_MS the provider forgets the account's data (the account itself stays, to reconnect).
 * Other errors (network, quota) are left for the next round. Resolves to how many were checked.
 */
export async function verifyDueAccounts(ctx: ProviderContext, providers: Map<string, Provider>): Promise<number> {
  let checked = 0;
  for (const { platform, name } of ctx.store.listAccounts()) {
    const provider = providers.get(platform);
    if (!provider?.verify) continue;
    const account = ctx.store.getAccount(platform, name);
    if (!account) continue;
    const upkeep = account.credentials as Upkeep;
    const now = ctx.now().getTime();
    if (upkeep.checkedAt !== undefined && now - upkeep.checkedAt < VERIFY_EVERY_MS) continue;
    checked++;
    try {
      const fresh = await provider.verify(ctx, account);
      // Merge onto what is stored now: a refresh elsewhere may have saved newer tokens meanwhile.
      const latest = ctx.store.getAccount(platform, name) ?? fresh;
      const { authFailedAt: _, forgottenAt: __, ...credentials } = { ...latest.credentials, ...fresh.credentials } as Record<string, unknown> & Upkeep;
      ctx.store.saveAccount({ ...latest, profile: fresh.profile, credentials: { ...credentials, checkedAt: now } });
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind !== 'auth') {
        ctx.log.warn(`verify(${platform}/${name}): ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const latest = ctx.store.getAccount(platform, name);
      if (!latest) continue;
      const state = latest.credentials as Upkeep;
      const failedAt = state.authFailedAt ?? now;
      const next: Upkeep = { checkedAt: now, authFailedAt: failedAt, forgottenAt: state.forgottenAt };
      if (state.forgottenAt === undefined && now - failedAt >= FORGET_AFTER_MS) {
        provider.forget?.(ctx, latest);
        next.forgottenAt = now;
        ctx.log.warn(msg('{platform}/{name}: {days}일 넘게 접근이 거부돼 플랫폼에서 받은 데이터(반응 통계, 프로필)를 지웠습니다. 다시 연결하면 새로 받습니다', { platform, name, days: Math.round(FORGET_AFTER_MS / DAY_MS) }));
        ctx.store.saveAccount({ ...latest, profile: {}, credentials: { ...latest.credentials, ...next } });
      } else {
        ctx.store.saveAccount({ ...latest, credentials: { ...latest.credentials, ...next } });
      }
    }
  }
  return checked;
}
