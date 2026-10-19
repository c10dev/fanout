import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderError } from './errors.ts';
import { sleep } from './http.ts';
import { isStaleOwner, PROCESS_OWNER } from './lease.ts';
import { checkMedia, ensureVariant, fileHash, probe, type MediaInfo } from './media.ts';
import { targetSpec, type Provider, type ProviderContext, type PublishOutcome } from './provider.ts';
import { withTimeout } from './posting.ts';
import { isTerminal } from './state.ts';
import type { Target } from './types.ts';
import { msg } from './i18n.ts';

export const MAX_ATTEMPTS = 4;
/** Renewed every RENEW_MS while a step runs, so it only matters when the holder died or stalled. */
const LEASE_MS = 15 * 60_000;
const RENEW_MS = 5 * 60_000;
/** Renewals that may throw in a row before the lease is treated as lost (then at most 5 minutes are left). */
const RENEW_FAILURES_MAX = 2;
/** A platform that hasn't finished processing after this long is not going to. */
export const PROCESSING_MAX_MS = 24 * 3600_000;
const POLL_TIMEOUT_MS = 60_000;

export { isStaleOwner, PROCESS_OWNER };

/** Targets this process is stepping right now (leases are per process, so guard within it too). */
const inFlight = new Set<string>();

export interface RunnerDeps {
  ctx: ProviderContext;
  providers: Map<string, Provider>;
  /** Injectable for tests. */
  probe?: (path: string) => Promise<MediaInfo>;
  ensureVariant?: typeof ensureVariant;
  /** Lease owner id; defaults to this process. */
  owner?: string;
}

function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** (attempts - 1), 15 * 60_000);
}

/**
 * Advance one target by one step. Every platform call happens inside here, so failures land on the
 * target record (state, platform error code, attempts) instead of disappearing into a log.
 */
export async function step(deps: RunnerDeps, targetId: string): Promise<Target> {
  const { store } = deps.ctx;
  const owner = deps.owner ?? PROCESS_OWNER;
  const target = store.getTarget(targetId);
  if (!target) throw new Error(`no target ${targetId}`);
  if (isTerminal(target.state)) return target;
  // Another process (dashboard, CLI, watch, MCP) or another loop here may be on it: leave it alone.
  if (inFlight.has(targetId) || !store.claim(targetId, owner, LEASE_MS, isStaleOwner)) return target;
  // It may have been canceled (or finished elsewhere) between the read above and the claim.
  const fresh = store.getTarget(targetId);
  if (!fresh || isTerminal(fresh.state)) {
    store.release(targetId, owner);
    return fresh ?? target;
  }
  inFlight.add(targetId);
  // Keep the lease alive through long uploads. It counts as lost when another process holds it (we
  // were suspended past the lease) or renewing keeps failing (the database is full, locked, gone):
  // from then on this step starts no new platform request. One already in flight is left to finish,
  // since cutting it off could leave a post made with no record of it.
  let leaseLost = false;
  let renewFailures = 0;
  const renew = setInterval(() => {
    try {
      if (store.claim(targetId, owner, LEASE_MS)) {
        renewFailures = 0;
        return;
      }
      leaseLost = true;
      deps.ctx.log.warn(msg('작업 잠금을 다른 프로세스가 가져갔습니다. 이 대상은 지금 요청이 끝나면 멈춥니다'));
    } catch (err) {
      renewFailures++;
      deps.ctx.log.warn(msg('작업 잠금을 연장하지 못했습니다 ({n}번째): {err}', { n: renewFailures, err: err instanceof Error ? err.message : String(err) }));
      if (renewFailures >= RENEW_FAILURES_MAX) leaseLost = true;
    }
  }, RENEW_MS);
  renew.unref();
  const fetchWhileOwned = ((input, init) =>
    leaseLost
      ? Promise.reject(new ProviderError('retryable', 'lease_lost', msg('작업 잠금을 잃어 이 단계를 멈췄습니다. 이어서 할 정보는 남겨 두었습니다'), undefined, { keepResume: true }))
      : deps.ctx.fetch(input, init)) as typeof fetch;
  try {
    return await stepClaimed({ ...deps, ctx: { ...deps.ctx, fetch: fetchWhileOwned } }, targetId);
  } finally {
    clearInterval(renew);
    inFlight.delete(targetId);
    store.release(targetId, owner);
  }
}

/** False when our lease was lost mid-step: the new holder owns the target's state now. */
function stillOwner(deps: RunnerDeps, targetId: string): boolean {
  const holder = deps.ctx.store.leaseHolder(targetId);
  const owner = deps.owner ?? PROCESS_OWNER;
  if (holder === undefined || holder === owner) return true;
  deps.ctx.log.warn(msg('작업 잠금을 잃었습니다 ({holder}). 이 대상의 상태는 그 프로세스가 기록합니다', { holder }));
  return false;
}

async function stepClaimed(deps: RunnerDeps, targetId: string): Promise<Target> {
  const { ctx, providers } = deps;
  const { store } = ctx;
  let target = store.getTarget(targetId)!;

  const post = store.getPost(target.postId)!;
  const provider = providers.get(target.platform);
  if (!provider) {
    return store.transition(target.id, 'failed', { errorCode: 'unknown_platform', errorMessage: msg('지원하지 않는 플랫폼: {platform}', { platform: target.platform }) });
  }
  let account = store.getAccount(target.platform, target.account);
  if (!account) {
    return store.transition(target.id, 'needs_reauth', {
      errorCode: 'account_missing',
      errorMessage: msg('연결된 계정 없음: {platform}/{account} — fanout connect {platform} 실행', { platform: target.platform, account: target.account }),
    });
  }

  try {
    if (target.state === 'processing') {
      if (!target.remoteId) throw new ProviderError('rejected', 'missing_remote_id', 'processing target has no remote id');
      const since = store.stateSince(target.id, 'processing');
      if (since && ctx.now().getTime() - since.getTime() > PROCESSING_MAX_MS) {
        // The remote object may still finish later, so keep its ids: starting over could post twice.
        throw new ProviderError('rejected', 'processing_timeout', msg('플랫폼 처리가 {PROCESSING_MAX_MS}시간 넘게 끝나지 않았습니다. 플랫폼에서 직접 확인하세요', { PROCESSING_MAX_MS: PROCESSING_MAX_MS / 3600_000 }), undefined, { keepResume: true });
      }
      // Status checks are short calls: give them a deadline so a silent platform can't hold the loop.
      const pollCtx = withTimeout(ctx, POLL_TIMEOUT_MS);
      account = await provider.refresh(pollCtx, account);
      const outcome = await provider.poll({ ctx: pollCtx, post, target: { ...target, remoteId: target.remoteId }, account });
      return applyOutcome(deps, target, outcome);
    }

    // The video must still be the one the post was made with: one swapped since (a folder others
    // or an agent can write to) is refused rather than uploaded. The hash is cached per file version.
    if (post.mediaHash && existsSync(post.mediaPath) && (await fileHash(post.mediaPath)) !== post.mediaHash) {
      throw new ProviderError('rejected', 'media_changed', msg('영상 파일이 게시물을 만든 뒤 바뀌었습니다. 새 게시물로 다시 올리세요'));
    }
    const probeFn = deps.probe ?? probe;
    const media = await probeFn(post.mediaPath);
    const spec = targetSpec(provider, post, target);

    if (target.state === 'queued') {
      const issues = provider.validate(post, target, media, account);
      const violations = checkMedia(media, spec);
      const blocking = [
        ...issues.filter((i) => i.severity === 'error').map((i) => i.message),
        ...violations.filter((v) => !v.fixable).map((v) => v.message),
      ];
      if (blocking.length) {
        return store.transition(target.id, 'failed', { errorCode: 'preflight', errorMessage: blocking.join(' / ') }, 'preflight');
      }
      const warnings = issues.filter((i) => i.severity === 'warning').map((i) => i.message);
      if (warnings.length) target = store.updateTarget(target.id, { warnings });
      if (violations.some((v) => v.fixable)) target = store.transition(target.id, 'transcoding');
    }

    let mediaPath = post.mediaPath;
    let uploadMedia = media;
    if (target.state === 'transcoding' || target.state === 'uploading') {
      const variant = await (deps.ensureVariant ?? ensureVariant)(media, spec, join(ctx.home, 'variants'));
      if (variant.transcoded) {
        mediaPath = variant.path;
        uploadMedia = await probeFn(variant.path);
        if (target.state === 'transcoding') ctx.log.info(msg('트랜스코딩: {variant}', { variant: variant.reasons.join(' / ') }));
      }
    }

    if (target.state !== 'uploading') {
      target = store.transition(target.id, 'uploading', { attempts: target.attempts + 1 });
    }

    account = await provider.refresh(ctx, account);
    const outcome = await provider.publish({
      ctx,
      post,
      target,
      account,
      mediaPath,
      media: uploadMedia,
      saveResume: (resume) => {
        target = store.updateTarget(targetId, { resume });
      },
    });
    return applyOutcome(deps, target, outcome);
  } catch (err) {
    return handleError(deps, targetId, err);
  }
}

function applyOutcome(deps: RunnerDeps, target: Target, outcome: PublishOutcome): Target {
  const { store } = deps.ctx;
  if (!stillOwner(deps, target.id)) return store.getTarget(target.id)!;
  const warnings = [...target.warnings, ...(outcome.warnings ?? []).filter((w) => !target.warnings.includes(w))];
  const patch = { remoteId: outcome.remoteId, remoteUrl: outcome.remoteUrl ?? target.remoteUrl, warnings, errorCode: undefined, errorMessage: undefined, notBefore: undefined };
  if (outcome.state === target.state) return store.updateTarget(target.id, patch);
  return store.transition(target.id, outcome.state, patch);
}

function handleError(deps: RunnerDeps, targetId: string, err: unknown): Target {
  const { store, log } = deps.ctx;
  const target = store.getTarget(targetId)!;
  if (!stillOwner(deps, targetId)) return target;
  const pe =
    err instanceof ProviderError ? err : new ProviderError('retryable', 'unexpected', err instanceof Error ? err.message : String(err));
  const fields = { errorCode: pe.platformCode ? `${pe.code} (${pe.platformCode})` : pe.code, errorMessage: pe.message };

  if (pe.kind === 'auth') return store.transition(target.id, 'needs_reauth', fields, pe.code);

  if (pe.retryAt && target.state === 'processing') {
    // The video is up; only the status check hit the limit. Keep its ids and check again later:
    // failing here would clear them, and a retry would upload the video a second time.
    log.warn(msg('{platform}: {message} — {notBefore}에 다시 시도합니다', { platform: target.platform, message: pe.message, notBefore: pe.retryAt }));
    // Parked until the limit resets: checking every few seconds until then would only repeat the error.
    return store.updateTarget(target.id, { ...fields, notBefore: pe.retryAt });
  }
  if (pe.retryAt) {
    // A daily limit, not a broken post: wait for its reset rather than fail and need a manual retry.
    // Resume data stays, so an upload that already landed isn't redone, and the attempt that
    // entering `uploading` counted is given back: days of waiting mustn't use up the retries.
    log.warn(msg('{platform}: {message} — {notBefore}에 다시 시도합니다', { platform: target.platform, message: pe.message, notBefore: pe.retryAt }));
    const attempts = target.state === 'uploading' ? Math.max(0, target.attempts - 1) : target.attempts;
    if (target.state === 'queued') return store.updateTarget(target.id, { ...fields, attempts, notBefore: pe.retryAt });
    return store.transition(target.id, 'queued', { ...fields, attempts, notBefore: pe.retryAt }, pe.code);
  }

  if (pe.kind === 'retryable') {
    if (target.state === 'processing') {
      // The upload already landed; keep polling instead of re-uploading.
      log.warn(msg('{platform}: 상태 조회 실패, 다음에 다시 확인 — {message}', { platform: target.platform, message: pe.message }));
      return store.updateTarget(target.id, fields);
    }
    // Entering `uploading` already counted this attempt; failures before that (probe, transcode) count here.
    const attempts = target.state === 'uploading' ? target.attempts : target.attempts + 1;
    if (attempts < MAX_ATTEMPTS) {
      const notBefore = new Date(deps.ctx.now().getTime() + backoffMs(attempts)).toISOString();
      log.warn(msg('{platform}: {message} — {notBefore}에 재시도', { platform: target.platform, message: pe.message, notBefore }));
      if (target.state === 'queued') return store.updateTarget(target.id, { ...fields, attempts, notBefore });
      return store.transition(target.id, 'queued', { ...fields, attempts, notBefore }, pe.code);
    }
    return store.transition(target.id, 'failed', { ...fields, attempts }, pe.code);
  }
  if (target.state === 'processing' && !pe.keepResume) {
    // The platform rejected the remote object itself (processing failed, container expired…). Forget it
    // so a manual retry uploads afresh instead of polling the same dead id again.
    return store.transition(target.id, 'failed', { ...fields, remoteId: undefined, remoteUrl: undefined, resume: undefined }, pe.code);
  }
  return store.transition(target.id, 'failed', fields, pe.code);
}

export interface SettleOptions {
  pollIntervalMs: number;
  /** Stop waiting after this long; unfinished targets stay in the store for `fanout run`. */
  timeoutMs: number;
  onChange?: (target: Target) => void;
}

/**
 * Drive the given targets until each is terminal or the timeout passes. Targets on the same
 * platform run one at a time; different platforms run in parallel.
 */
export async function settle(deps: RunnerDeps, targetIds: string[], opts: SettleOptions): Promise<Target[]> {
  const { store } = deps.ctx;
  const deadline = Date.now() + opts.timeoutMs;
  const byPlatform = new Map<string, string[]>();
  for (const id of targetIds) {
    const t = store.getTarget(id)!;
    byPlatform.set(t.platform, [...(byPlatform.get(t.platform) ?? []), id]);
  }

  await Promise.all(
    [...byPlatform.values()].map(async (ids) => {
      for (const id of ids) {
        let last = store.getTarget(id)!.state;
        while (Date.now() < deadline) {
          const current = store.getTarget(id)!;
          if (isTerminal(current.state)) break;
          // Someone else is working on it; this loop would only spin.
          const holder = store.leaseHolder(id);
          if ((holder && holder !== (deps.owner ?? PROCESS_OWNER) && !isStaleOwner(holder)) || inFlight.has(id)) break;
          if ((current.state === 'queued' || current.state === 'processing') && current.notBefore && new Date(current.notBefore) > deps.ctx.now()) {
            // Waiting past the deadline (a daily limit's reset, a far schedule) would only hold up the
            // platform's other targets: leave it to the worker.
            if (new Date(current.notBefore).getTime() - deps.ctx.now().getTime() > deadline - Date.now()) break;
            await sleep(Math.min(opts.pollIntervalMs, new Date(current.notBefore).getTime() - Date.now()));
            continue;
          }
          const next = await step(deps, id);
          if (next.state !== last || next.errorCode) opts.onChange?.(next);
          last = next.state;
          if (next.state === 'processing') await sleep(opts.pollIntervalMs);
        }
      }
    }),
  );
  return targetIds.map((id) => store.getTarget(id)!);
}
