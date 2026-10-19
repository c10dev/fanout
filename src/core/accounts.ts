// Account upkeep that platform terms ask for. YouTube's Developer Policies (III.D.2, III.E.4) let
// fanout keep statistics only while it re-checks the user's authorization every 30 days, other
// API data (the channel title) only if re-read within 30 days, and ask for the data to go within
// 7 days of a disconnect and within 30 days of access being revoked on Google's side.

import { ProviderError } from './errors.ts';
import { msg } from './i18n.ts';
import { notifyEvent } from './notify.ts';
import type { Provider, ProviderContext } from './provider.ts';
import type { Account } from './store.ts';

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
  /** When to check next: a day after a check, sooner after a network or quota error. */
  nextCheckAt?: number;
  /** First refusal of a run of refusals; cleared by a successful check or a reconnect. */
  authFailedAt?: number;
  forgottenAt?: number;
}

/** After a network, quota or setup error, try again this much later. */
const RETRY_MS = 3 * 3600_000;

/**
 * Refusals that are fanout's own setup (no app, an app secret that changed, an OAuth client deleted
 * or disabled in the Cloud console), not the user taking access back: they never start the
 * deletion clock.
 */
function isSetupError(err: ProviderError): boolean {
  return err.code.endsWith('.app_missing') || ['invalid_client', 'unauthorized_client', 'deleted_client', 'disabled_client'].includes(err.platformCode ?? '');
}

/** A token that identifies the stored grant, to notice a reconnect while a check was running. */
const grant = (credentials: Record<string, unknown>) => credentials.refreshToken ?? credentials.accessToken;

/**
 * Disconnect one account: let the provider revoke its tokens and forget restricted data, then
 * remove it. A failed revoke is logged; the data goes and the account is removed anyway. Resolves
 * undefined when there was no such account.
 */
export async function disconnectAccount(
  ctx: ProviderContext,
  providers: Map<string, Provider>,
  platform: string,
  name: string,
): Promise<{ revoked: boolean; forgot: boolean } | undefined> {
  const account = ctx.store.getAccount(platform, name);
  if (!account) return undefined;
  const provider = providers.get(platform);
  let revoked = false;
  try {
    revoked = (await provider?.disconnect?.(ctx, account)) ?? false;
  } catch (err) {
    ctx.log.warn(msg('{platform}/{name}: 토큰을 철회하지 못했습니다 ({err}). 계정은 지웁니다', { platform, name, err: err instanceof Error ? err.message : String(err) }));
  }
  provider?.forget?.(ctx, account);
  if (!ctx.store.removeAccount(platform, name)) return undefined;
  return { revoked, forgot: Boolean(provider?.forget) };
}

/**
 * Verify accounts that are due (a day after their last check). Success refreshes the stored
 * profile and clears a past refusal; an auth refusal is remembered, and once refusals have lasted
 * FORGET_AFTER_MS the provider forgets the account's data (the account itself stays, to reconnect).
 * Network, quota and setup errors are retried a few hours later. Resolves to how many were checked.
 */
export async function verifyDueAccounts(ctx: ProviderContext, providers: Map<string, Provider>): Promise<number> {
  let checked = 0;
  for (const { platform, name } of ctx.store.listAccounts()) {
    const provider = providers.get(platform);
    if (!provider?.verify) continue;
    const account = ctx.store.getAccount(platform, name);
    if (!account) continue;
    const now = ctx.now().getTime();
    const next = (account.credentials as Upkeep).nextCheckAt;
    if (next !== undefined && now < next) continue;
    checked++;
    // Every save goes onto what is stored by then, and only if it is still the same grant: the
    // account may have been removed, reconnected or refreshed elsewhere while the check ran.
    const update = (change: (stored: Account) => Account) => {
      const stored = ctx.store.getAccount(platform, name);
      if (stored && grant(stored.credentials) === grant(account.credentials)) ctx.store.saveAccount(change(stored));
      return stored;
    };
    const marks = (stored: Account, upkeep: Upkeep): Account['credentials'] => {
      const { nextCheckAt: _, authFailedAt: __, forgottenAt: ___, ...rest } = stored.credentials as Record<string, unknown> & Upkeep;
      return { ...rest, ...Object.fromEntries(Object.entries(upkeep).filter(([, v]) => v !== undefined)) };
    };
    try {
      const fresh = await provider.verify(ctx, account);
      update((stored) => ({ ...stored, profile: fresh.profile, credentials: marks(stored, { nextCheckAt: now + VERIFY_EVERY_MS }) }));
    } catch (err) {
      const refusal = err instanceof ProviderError && err.kind === 'auth' && !isSetupError(err);
      if (!refusal) {
        ctx.log.warn(`verify(${platform}/${name}): ${err instanceof Error ? err.message : String(err)}`);
        update((stored) => {
          const { authFailedAt, forgottenAt } = stored.credentials as Upkeep;
          return { ...stored, credentials: marks(stored, { authFailedAt, forgottenAt, nextCheckAt: now + RETRY_MS }) };
        });
        continue;
      }
      update((stored) => {
        const state = stored.credentials as Upkeep;
        const failedAt = state.authFailedAt ?? now;
        const upkeep: Upkeep = { nextCheckAt: now + VERIFY_EVERY_MS, authFailedAt: failedAt, forgottenAt: state.forgottenAt };
        if (state.authFailedAt === undefined) {
          ctx.log.warn(msg('{platform}/{name}: 접근이 거부됐습니다 ({err}). {days}일 안에 다시 연결하지 않으면 플랫폼에서 받은 데이터(반응 통계, 프로필)를 지웁니다', { platform, name, err: (err as Error).message, days: Math.round(FORGET_AFTER_MS / DAY_MS) }));
        }
        if (state.forgottenAt !== undefined || now - failedAt < FORGET_AFTER_MS) return { ...stored, credentials: marks(stored, upkeep) };
        provider.forget?.(ctx, stored);
        ctx.log.warn(msg('{platform}/{name}: {days}일 넘게 접근이 거부돼 플랫폼에서 받은 데이터(반응 통계, 프로필)를 지웠습니다. 다시 연결하면 새로 받습니다', { platform, name, days: Math.round(FORGET_AFTER_MS / DAY_MS) }));
        return { ...stored, profile: {}, credentials: marks(stored, { ...upkeep, forgottenAt: now }) };
      });
    }
  }
  return checked;
}

/** Warn this long before a sign-in ends (YouTube in "Testing" ends after 7 days, so always). */
export const EXPIRY_WARN_MS = 14 * DAY_MS;

/** When an account's sign-in ends, if its platform says (refresh token lifetimes), and whether that's soon. */
export function signInExpiry(ctx: ProviderContext, providers: Map<string, Provider>, platform: string, name: string): { expiresAt: number; soon: boolean } | undefined {
  const provider = providers.get(platform);
  const account = provider?.signInExpiresAt ? ctx.store.getAccount(platform, name) : undefined;
  const expiresAt = account ? provider!.signInExpiresAt!(account) : undefined;
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) return undefined;
  return { expiresAt, soon: expiresAt - ctx.now().getTime() < EXPIRY_WARN_MS };
}

/**
 * Tell the owner once (log and webhook) about each sign-in ending within two weeks, so a scheduled
 * post doesn't fail on it. The mark is the expiry it warned about: a reconnect gives a new one.
 */
export async function warnExpiringAccounts(ctx: ProviderContext, providers: Map<string, Provider>): Promise<number> {
  let warned = 0;
  for (const { platform, name } of ctx.store.listAccounts()) {
    const expiry = signInExpiry(ctx, providers, platform, name);
    const account = ctx.store.getAccount(platform, name);
    // The same expiry, give or take the drift of a refresh (it's recomputed from "expires in" each time).
    const warnedFor = (account?.credentials as { expiryWarnedFor?: number } | undefined)?.expiryWarnedFor;
    if (!expiry?.soon || !account || (warnedFor !== undefined && Math.abs(warnedFor - expiry.expiresAt) < DAY_MS)) continue;
    const when = new Date(expiry.expiresAt).toISOString().slice(0, 16).replace('T', ' ');
    const text = expiry.expiresAt <= ctx.now().getTime()
      ? msg('🔑 {platform}/{name} 로그인이 만료됐습니다 ({when} UTC) — fanout connect {platform} 로 다시 연결하세요', { platform, name, when })
      : msg('🔑 {platform}/{name} 로그인이 {when} UTC에 만료됩니다 — 그 전에 fanout connect {platform} 로 다시 연결하세요', { platform, name, when });
    ctx.log.warn(text);
    notifyEvent(ctx, 'expiring', text, { platform, account: name, expiresAt: new Date(expiry.expiresAt).toISOString() });
    ctx.store.saveAccountIf({ ...account, credentials: { ...account.credentials, expiryWarnedFor: expiry.expiresAt } }, (stored) => grant(stored.credentials) === grant(account.credentials));
    warned++;
  }
  return warned;
}
