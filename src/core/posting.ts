import { firstCommentWarnings } from './followup.ts';
import { remoteIdUnknown, remoteIdUnknownNote } from './remote.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ProviderError } from './errors.ts';
import { isStaleOwner } from './lease.ts';
import { checkMedia, FITS, probe as probeMedia, type MediaInfo, type Violation } from './media.ts';
import { computeInsights, isoInZone, validTimeZone } from './insights.ts';
import { notifyEvent } from './notify.ts';
import { isTerminal } from './state.ts';
import { targetSpec, withFit, type Provider, type ProviderContext } from './provider.ts';
import type { Store } from './store.ts';
import { FIND_HANDED_OFF_DAYS, statsTrend } from './stats.ts';
import type { Comment, Post, PostInput, PostStats, StatsTrend, Target, TargetInput } from './types.ts';
import { msg } from './i18n.ts';

export type Verdict = 'as_is' | 'transcode' | 'blocked';

export interface Assessment {
  platform: string;
  verdict: Verdict;
  violations: Violation[];
  /** Blocked only by what a vertical fit solves: posting needs the fit chosen (fit option, --vertical). */
  fittable?: true;
}

/** Blocked, and a vertical fit would take every block away. */
function onlyFittable(violations: Violation[]): boolean {
  const blocks = violations.filter((v) => !v.fixable);
  return blocks.length > 0 && blocks.every((v) => v.fittable);
}

/**
 * Per-platform verdict for one file: upload the original, transcode first, or cannot post. `options`
 * (by platform) bring a fit someone chose; without one, a shape a fit would solve stays blocked.
 */
export function assessMedia(media: MediaInfo, providers: Iterable<Provider>, options: Record<string, Record<string, unknown>> = {}): Assessment[] {
  return [...providers].map((p) => {
    const violations = checkMedia(media, withFit(p.spec, options[p.id]));
    const verdict: Verdict = violations.some((v) => !v.fixable) ? 'blocked' : violations.length ? 'transcode' : 'as_is';
    return { platform: p.id, verdict, violations, ...(onlyFittable(violations) ? { fittable: true as const } : {}) };
  });
}

/**
 * Create a post and its targets. With a schedule, platforms that schedule natively get the upload
 * now; the rest wait in `queued` until `scheduledAt`.
 */
export function createScheduledPost(
  store: Store,
  providers: Map<string, Provider>,
  input: PostInput,
  targets: TargetInput[],
): { post: Post; targets: Target[] } {
  return store.transaction(() => {
    const { post, targets: created } = store.createPost(input, targets);
    if (!input.scheduledAt) return { post, targets: created };
    const updated = created.map((t) => {
      const hold = holdUntil(providers.get(t.platform), input.scheduledAt, Date.now(), t.options);
      return hold ? store.updateTarget(t.id, { notBefore: hold }) : t;
    });
    return { post, targets: updated };
  });
}

const DAY_MS = 86_400_000;

/**
 * When a scheduled target should start: platforms without native scheduling wait for the time
 * itself; native ones upload now, unless the time is beyond what the platform accepts, in which
 * case they wait until it is a day inside that limit. Undefined: start now.
 */
export function holdUntil(provider: Provider | undefined, scheduledAt: string | undefined, now: number, options?: Record<string, unknown>): string | undefined {
  // A draft (Facebook) isn't scheduled at all: it goes to the drafts now and the user posts it.
  if (!scheduledAt || options?.draft === true) return undefined;
  const at = Date.parse(scheduledAt);
  if (!(at > now)) return undefined;
  if (!provider?.capabilities.nativeSchedule) return scheduledAt;
  const max = provider.scheduleMaxAheadMs;
  if (!max || at - now <= max - DAY_MS) return undefined;
  return new Date(at - (max - DAY_MS)).toISOString();
}

/** True when the platform needs no developer app, or its app credentials are saved. */
export function appReady(store: Store, p: Provider): boolean {
  return p.appFields.every((f) => f.optional) || Boolean(store.getApp(p.appKey ?? p.id));
}

/** Human name for a connected account: channel title, @username, page name or display name. */
export function accountLabel(profile: Record<string, unknown>, name: string): string {
  const pr = profile as Record<string, string | undefined>;
  return pr.channelTitle ?? (pr.username ? `@${pr.username}` : undefined) ?? pr.pageName ?? pr.displayName ?? name;
}

/**
 * Where a post ends up and who can see it, as shown before uploading (YouTube policy asks for this),
 * in words for the terminal and agents. `when` is the scheduled time as its reader should see it
 * (local in the CLI, ISO with an offset over MCP and the API), or a note in its place.
 */
export function visibilityLabel(t: TargetInput, when?: string): string {
  const o = t.options as Record<string, unknown>;
  // A draft waits in the Page's drafts; it isn't scheduled (holdUntil).
  if (t.platform === 'facebook' && o.draft === true) return msg('draft (Meta Business Suite에서 마무리)');
  switch (t.platform) {
    case 'youtube':
      return when ? msg('private → {scheduledAt}에 public', { scheduledAt: when }) : String(o.privacy ?? msg('(미지정)'));
    case 'mastodon':
      return when ? msg('{visibility}, {time}에 게시', { visibility: String(o.visibility ?? msg('(공개 범위 미지정)')), time: when }) : String(o.visibility ?? msg('(공개 범위 미지정)'));
    case 'peertube':
      return when ? msg('private → {time}에 {privacy}', { time: when, privacy: String(o.privacy ?? msg('(미지정)')) }) : String(o.privacy ?? msg('(공개 범위 미지정)'));
    case 'tiktok': {
      // fanout holds a scheduled TikTok post and sends it at the time.
      if (o.mode !== 'direct') return when ? msg('{visibility}, {time}에 보냄', { visibility: msg('inbox (TikTok 앱에서 마무리)'), time: when }) : msg('inbox (TikTok 앱에서 마무리)');
      const direct = 'direct, ' + String(o.privacyLevel ?? msg('(공개 범위 미지정)'));
      return when ? msg('{visibility}, {time}에 게시', { visibility: direct, time: when }) : direct;
    }
    default:
      return when ? msg('{visibility}, {time}에 게시', { visibility: 'public', time: when }) : 'public';
  }
}

/**
 * The same as fields, for a client that words them itself (the dashboard, in the viewer's language
 * and time zone): the platform's own visibility value, when it goes out or public, and how.
 */
function visibilityFields(t: TargetInput, scheduledAt?: string): Pick<TargetPreview, 'privacy' | 'publishAt' | 'mode'> {
  const o = t.options as Record<string, unknown>;
  const value = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  if (t.platform === 'facebook' && o.draft === true) return { mode: 'draft' };
  switch (t.platform) {
    case 'youtube':
    case 'peertube':
      // Uploaded private, and the platform switches it at the time.
      return scheduledAt ? { privacy: value(o.privacy), publishAt: scheduledAt, mode: 'private_until' } : { privacy: value(o.privacy) };
    case 'mastodon':
      return { privacy: value(o.visibility), publishAt: scheduledAt };
    case 'tiktok':
      return o.mode === 'direct' ? { privacy: value(o.privacyLevel), publishAt: scheduledAt, mode: 'direct' } : { publishAt: scheduledAt, mode: 'inbox' };
    default:
      return { privacy: 'public', publishAt: scheduledAt };
  }
}

export interface TargetPreview {
  platform: string;
  account: string;
  accountLabel?: string;
  connected: boolean;
  /** visibilityLabel: who sees it and when, in words, the time in ISO-8601 with the zone's offset. */
  visibility: string;
  /** The platform's visibility value (public, unlisted, SELF_ONLY…); none while unchosen or when the app decides (TikTok inbox, Facebook draft). */
  privacy?: string;
  /** When it goes out, or goes public, if scheduled (ISO-8601, UTC). */
  publishAt?: string;
  /** How it goes out: TikTok 'inbox' or 'direct', Facebook 'draft', or 'private_until' (YouTube, PeerTube: private until publishAt). */
  mode?: string;
  verdict: Verdict;
  /** Anything here stops the upload. */
  errors: string[];
  warnings: string[];
  /** What a transcode would fix first. */
  transcode: string[];
  /** The video's only blocks are ones a vertical fit solves (see Assessment.fittable). */
  fittable?: true;
}

/** Everything the runner's preflight would say, without creating anything. */
export function previewPost(
  store: Store,
  providers: Map<string, Provider>,
  input: PostInput,
  targets: TargetInput[],
  media: MediaInfo,
  opts: { timeZone?: string } = {},
): TargetPreview[] {
  const post: Post = { ...input, id: 'preview', createdAt: new Date(0).toISOString() };
  const prior = priorPosts(store, input.mediaHash, targets);
  // The words carry the time with an offset in the reader's zone (the dashboard's, else FANOUT_TZ or this machine's).
  const when = input.scheduledAt ? isoInZone(input.scheduledAt, validTimeZone(opts.timeZone) ?? validTimeZone(process.env.FANOUT_TZ)) : undefined;
  return targets.map((t) => {
    const provider = providers.get(t.platform);
    const account = store.getAccount(t.platform, t.account);
    const base = { platform: t.platform, account: t.account, connected: Boolean(account), visibility: visibilityLabel(t, when), ...visibilityFields(t, input.scheduledAt) };
    if (!provider) return { ...base, verdict: 'blocked' as const, errors: [msg('알 수 없는 플랫폼: {platform}', { platform: t.platform })], warnings: [], transcode: [] };
    const target: Target = { id: 'preview', postId: post.id, platform: t.platform, account: t.account, options: t.options, state: 'queued', warnings: [], attempts: 0, updatedAt: post.createdAt };
    const issues = provider.validate(post, target, media, account ?? undefined);
    const fit = (t.options as { fit?: unknown }).fit;
    if (fit !== undefined && !FITS.includes(fit as never)) issues.push({ severity: 'error', code: 'fit', message: msg('fit은 pad 또는 crop') });
    const violations = checkMedia(media, targetSpec(provider, post, target));
    const errors = [...issues.filter((i) => i.severity === 'error').map((i) => i.message), ...violations.filter((v) => !v.fixable).map((v) => v.message)];
    if (!account) errors.push(msg('연결되지 않은 계정: {platform}/{account}', { platform: t.platform, account: t.account }));
    return {
      ...base,
      accountLabel: account ? accountLabel(account.profile, t.account) : undefined,
      verdict: errors.length ? 'blocked' : violations.length ? 'transcode' : 'as_is',
      errors,
      warnings: [
        ...(prior.get(`${t.platform}/${t.account}`) ?? []).slice(0, 1).map(describePrior),
        ...issues.filter((i) => i.severity === 'warning').map((i) => i.message),
        ...firstCommentWarnings(provider, input.firstComment, t.options, account ?? undefined),
      ],
      transcode: violations.filter((v) => v.fixable).map((v) => v.message),
      ...(onlyFittable(violations) ? { fittable: true as const } : {}),
    };
  });
}

/** States in which a target already covers its platform account on this post. */
// needs_reauth goes back to queued once the account is reconnected, so it still covers its account.
const COVERING_STATES: ReadonlySet<Target['state']> = new Set(['queued', 'transcoding', 'uploading', 'processing', 'published', 'handed_off', 'needs_reauth']);

export interface AddTargetsPlan {
  post: Post;
  preview: TargetPreview[];
  /** Attachments whose files are gone; they are left off the new targets. */
  dropped: string[];
}

/**
 * Check adding platforms to an existing post. Throws when it can't be done at all (no such post,
 * original already cleaned up, platform account already on the post); everything else is in the
 * preview, like a new post's.
 */
export function planAddTargets(store: Store, providers: Map<string, Provider>, postId: string, targets: TargetInput[], media: MediaInfo, opts: { timeZone?: string } = {}): AddTargetsPlan {
  const post = store.getPost(postId);
  if (!post) throw new Error(msg('게시물 없음: {postId}', { postId }));
  if (!targets.length) throw new Error(msg('추가할 플랫폼을 하나 이상 고르세요'));
  if (!existsSync(post.mediaPath)) {
    throw new Error(msg('원본 영상이 이미 정리돼 없습니다(게시가 끝난 원본은 기본 7일 뒤 지워집니다). 영상을 다시 골라 새 게시물로 올리세요'));
  }
  const existing = store.targetsForPost(postId);
  const seen = new Set<string>();
  for (const t of targets) {
    const key = `${t.platform}/${t.account}`;
    if (seen.has(key)) throw new Error(msg('{key}를 두 번 골랐습니다', { key }));
    seen.add(key);
    const prev = existing.find((e) => e.platform === t.platform && e.account === t.account && (COVERING_STATES.has(e.state) || (e.state === 'failed' && mayBeLive(e))));
    if (prev) throw new Error(msg('{key}는 이 게시물에 이미 있습니다 ({state})', { key, state: prev.errorCode ? `${prev.state}, ${prev.errorCode}` : prev.state }));
  }
  // Attachments live beside uploads and may have been cleaned up with them.
  const dropped: string[] = [];
  let input: Post = post;
  if (post.thumbnailPath && !existsSync(post.thumbnailPath)) {
    dropped.push(msg('썸네일'));
    input = { ...input, thumbnailPath: undefined };
  }
  const captions = post.captions.filter((c) => existsSync(c.path));
  if (captions.length < post.captions.length) {
    dropped.push(...post.captions.filter((c) => !captions.includes(c)).map((c) => msg('자막({language})', { language: c.language })));
    input = { ...input, captions };
  }
  const preview = previewPost(store, providers, input, targets, media, opts).map((p) =>
    dropped.length ? { ...p, warnings: [msg('파일이 없어 빼고 올립니다: {dropped}', { dropped: dropped.join(', ') }), ...p.warnings] } : p,
  );
  return { post: input, preview, dropped };
}

/** Add platforms to an existing post after the same checks as a new one; refuses if any target is blocked. */
export function addTargets(store: Store, providers: Map<string, Provider>, postId: string, targets: TargetInput[], media: MediaInfo): Target[] {
  const plan = planAddTargets(store, providers, postId, targets, media);
  const blocked = plan.preview.filter((p) => p.errors.length);
  if (blocked.length) throw new Error(blocked.map((p) => `${p.platform}/${p.account}: ${p.errors.join(' / ')}`).join('\n'));
  if (plan.dropped.length) store.updatePost(postId, { thumbnailPath: plan.post.thumbnailPath, captions: plan.post.captions });
  // Like a new post: wait for the time where the platform can't hold the schedule itself.
  return store.addTargets(postId, targets, (t) => holdUntil(providers.get(t.platform), plan.post.scheduledAt, Date.now(), t.options));
}

/**
 * Why trying a target again could post it a second time: the last attempt sent the request that
 * creates the post and never learned the answer (X, Mastodon: `posting` left set), or the provider
 * said so (`*.maybe_posted`, `*.media_attached`). Platforms without an idempotency key would take
 * a repeat as a new post. Resuming from saved upload ids (YouTube session, Instagram container,
 * Facebook, TikTok) is not a repeat and isn't gated.
 */
export function mayBeDuplicate(t: Target): string | undefined {
  if (t.errorCode && /maybe_posted|media_attached/.test(t.errorCode)) return msg('"{errorCode}"로 멈췄습니다', { errorCode: t.errorCode });
  if ((t.resume as { posting?: unknown } | undefined)?.posting === true) return msg('지난 시도가 게시 요청을 보낸 뒤 결과를 받지 못했습니다');
  return undefined;
}

export class MaybeDuplicateError extends Error {
  readonly code = 'maybe_duplicate';
  constructor(t: Target, reason: string) {
    super(
      msg('{platform}/{account}: {reason}. 이미 게시됐을 수 있습니다. 플랫폼에서 올라가지 않은 것을 확인한 뒤에만 다시 시도하세요. 그렇지 않으면 두 번 올라갑니다', {
        platform: t.platform,
        account: t.account,
        reason,
      }),
    );
  }
}

/**
 * Queue a failed or needs_reauth target again on the user's request. Clears the error and backoff,
 * and the `posting` marker a provider leaves when a post's outcome was unknown. A target that may
 * already be on the platform (mayBeDuplicate) is queued only once the user has checked and says
 * it isn't (`confirmedNotPosted`), as for cancel.
 */
export function retryTarget(store: Store, id: string, via: string, opts: { confirmedNotPosted?: boolean } = {}): Target {
  const t = store.getTarget(id);
  if (!t) throw new Error(msg('대상 없음: {id}', { id }));
  if (t.state !== 'failed' && t.state !== 'needs_reauth') throw new Error(msg('{state} 상태는 다시 시도할 수 없습니다', { state: t.state }));
  const dup = mayBeDuplicate(t);
  if (dup && !opts.confirmedNotPosted) throw new MaybeDuplicateError(t, dup);
  const resume = t.resume && 'posting' in t.resume ? { ...t.resume, posting: false } : t.resume;
  return store.transition(t.id, 'queued', { attempts: 0, errorCode: undefined, errorMessage: undefined, notBefore: undefined, resume }, via);
}

export interface PriorPost {
  postId: string;
  createdAt: string;
  state: Target['state'];
  url?: string;
}

/**
 * Earlier posts of the same video to the same platform account that did (or still may) go out —
 * anything except a failure. Keyed "platform/account".
 */
export function priorPosts(store: Store, hash: string | undefined, targets: TargetInput[], excludePostId?: string): Map<string, PriorPost[]> {
  const out = new Map<string, PriorPost[]>();
  if (!hash) return out;
  const wanted = new Set(targets.map((t) => `${t.platform}/${t.account}`));
  for (const p of store.postsWithHash(hash)) {
    if (p.id === excludePostId) continue;
    for (const t of store.targetsForPost(p.id)) {
      const key = `${t.platform}/${t.account}`;
      // Failed posts never went out (unless they stopped not knowing); removed ones were taken down on
      // purpose and canceled ones confirmed absent, so posting again is fine.
      if (!wanted.has(key) || t.state === 'removed' || t.state === 'canceled' || (t.state === 'failed' && !mayBeLive(t))) continue;
      out.set(key, [...(out.get(key) ?? []), { postId: p.id, createdAt: p.createdAt, state: t.state, url: t.remoteUrl }]);
    }
  }
  return out;
}

export function describePrior(prior: PriorPost): string {
  const when = prior.createdAt.slice(0, 16).replace('T', ' ');
  return msg('이 영상은 {when}(UTC)에 이미 올렸습니다 — {state}', { when, state: prior.url ? `${prior.state} ${prior.url}` : prior.state });
}

export interface StatsResult {
  targetId: string;
  platform: string;
  account: string;
  stats?: PostStats;
  /** Change over the last day, once there is a reading from a day ago. */
  trend?: StatsTrend;
  /** Why nothing was fetched for this target. */
  skipped?: string;
}

/**
 * Fetch stats for a post's published targets and store them. Platforms that bill for reads (X) are
 * skipped unless `includePaid`; failures become notes instead of failing the whole refresh.
 */
export async function refreshStats(
  baseCtx: ProviderContext,
  providers: Map<string, Provider>,
  postId: string,
  opts: { includePaid?: boolean; platform?: string } = {},
): Promise<StatsResult[]> {
  const ctx = withTimeout(baseCtx);
  const out: StatsResult[] = [];
  for (let t of ctx.store.targetsForPost(postId)) {
    if (opts.platform && t.platform !== opts.platform) continue;
    const base = { targetId: t.id, platform: t.platform, account: t.account };
    const provider = providers.get(t.platform);
    if (t.state === 'handed_off' && provider?.findHandedOff) {
      const found = await findHandedOff(ctx, provider, t);
      if (!found.target) {
        // Marked as looked at, so the background refresh moves on until it is due again.
        ctx.store.saveStats(t.id, { ...(t.stats ?? {}), fetchedAt: ctx.now().toISOString(), note: found.note });
        out.push({ ...base, skipped: found.note });
        continue;
      }
      t = found.target;
    }
    if (t.state !== 'published' || !t.remoteId) {
      const why = t.state === 'handed_off' ? msg('앱에서 마무리한 게시물은 id를 몰라 가져올 수 없습니다') : t.state === 'removed' ? msg('플랫폼에서 삭제했습니다') : msg('게시되지 않았습니다');
      out.push({ ...base, skipped: why });
      continue;
    }
    if (remoteIdUnknown(t)) {
      // Saved, so the background refresh moves on instead of picking this target first every run.
      ctx.store.saveStats(t.id, { ...(t.stats ?? {}), fetchedAt: ctx.now().toISOString(), note: remoteIdUnknownNote() });
      out.push({ ...base, skipped: remoteIdUnknownNote() });
      continue;
    }
    if (!provider?.stats) {
      out.push({ ...base, skipped: msg('{provider}는 반응 통계를 가져올 수 없습니다', { provider: provider?.displayName ?? t.platform }) });
      continue;
    }
    if (provider.statsCost && !opts.includePaid) {
      out.push({ ...base, skipped: provider.statsCost });
      continue;
    }
    let account = ctx.store.getAccount(t.platform, t.account);
    if (!account) {
      // Mark it read so background refresh moves on to the next target instead of retrying this one.
      ctx.store.saveStats(t.id, { ...(t.stats ?? {}), fetchedAt: ctx.now().toISOString(), note: msg('연결된 계정이 없습니다') });
      out.push({ ...base, skipped: msg('연결된 계정이 없습니다') });
      continue;
    }
    let stats: PostStats;
    let failed = false;
    try {
      account = await provider.refresh(ctx, account);
      stats = { ...(await provider.stats({ ctx, account, target: { ...t, remoteId: t.remoteId } })), fetchedAt: ctx.now().toISOString() };
    } catch (err) {
      failed = true;
      stats = { ...(t.stats ?? {}), fetchedAt: ctx.now().toISOString(), note: msg('가져오지 못함: {err}', { err: err instanceof Error ? err.message : String(err) }) };
    }
    ctx.store.saveStats(t.id, stats);
    if (!failed) ctx.store.recordStats(t.id, stats);
    // Alerts (a copyright block) belong with the target's warnings, where every view shows them.
    const fresh = (stats.alerts ?? []).filter((a) => !t.warnings.includes(a));
    if (fresh.length) {
      ctx.store.updateTarget(t.id, { warnings: [...t.warnings, ...fresh] });
      const title = ctx.store.getPost(t.postId)?.title ?? t.postId;
      for (const a of fresh) {
        ctx.log.warn(`${t.platform}/${t.account}: ${a}`);
        notifyEvent(ctx, 'alert', `⚠️ ${t.platform}/${t.account} "${title}": ${a}${t.remoteUrl ? `\n${t.remoteUrl}` : ''}`, { platform: t.platform, account: t.account, postId: t.postId, targetId: t.id, title, url: t.remoteUrl, alert: a });
      }
    }
    out.push({ ...base, stats, trend: statsTrend(ctx.store, t.id, ctx.now()) });
  }
  return out;
}

/**
 * Link a handed-off target (TikTok inbox) to the post the creator finished in the app: only when
 * exactly one of the platform's candidates fits and no other target already has it, else a note.
 */
async function findHandedOff(ctx: ProviderContext, provider: Provider, t: Target): Promise<{ target?: Target; note: string }> {
  const handedOff = ctx.store.stateSince(t.id, 'handed_off') ?? new Date(t.updatedAt);
  // The post can't predate the upload; fanout may only have noticed the hand-off later.
  const since = ctx.store.stateSince(t.id, 'uploading') ?? handedOff;
  if (ctx.now().getTime() - handedOff.getTime() > FIND_HANDED_OFF_DAYS * 86_400_000) {
    return { note: msg('앱에서 마무리한 게시물을 {days}일 동안 찾지 못해 더 찾지 않습니다', { days: FIND_HANDED_OFF_DAYS }) };
  }
  let account = ctx.store.getAccount(t.platform, t.account);
  if (!account) return { note: msg('연결된 계정이 없습니다') };
  try {
    account = await provider.refresh(ctx, account);
    const { matches, note } = await provider.findHandedOff!({ ctx, account, target: t, since });
    const free = matches.filter((m) => !ctx.store.remoteIdInUse(t.platform, t.account, m.remoteId, t.id));
    if (free.length === 1) {
      const m = free[0]!;
      // Another process may have linked it a moment ago.
      const now = ctx.store.getTarget(t.id)!;
      if (now.state !== 'handed_off') return { target: now, note: '' };
      const target = ctx.store.transition(t.id, 'published', { remoteId: m.remoteId, remoteUrl: m.remoteUrl }, 'found the post finished in the app');
      ctx.log.info(msg('{platform}/{account}: 앱에서 마무리한 게시물을 찾았습니다 ({url})', { platform: t.platform, account: t.account, url: m.remoteUrl ?? m.remoteId }));
      return { target, note: '' };
    }
    if (free.length > 1) return { note: msg('앱에서 올린 게시물 후보가 {n}개라 고르지 않았습니다', { n: free.length }) };
    return { note: note ?? msg('아직 앱에서 게시된 영상을 찾지 못했습니다 (마무리하면 다음 확인 때 연결됩니다)') };
  } catch (err) {
    return { note: msg('가져오지 못함: {err}', { err: err instanceof Error ? err.message : String(err) }) };
  }
}

/**
 * Delete a published post from its platform and mark the target removed. Irreversible on the
 * platform side, so callers confirm with the user first.
 */
export async function removeTarget(baseCtx: ProviderContext, providers: Map<string, Provider>, targetId: string): Promise<Target> {
  const ctx = withTimeout(baseCtx);
  const t = ctx.store.getTarget(targetId);
  if (!t) throw new Error(msg('대상 없음: {targetId}', { targetId }));
  if (t.state !== 'published' || !t.remoteId) throw new Error(msg('게시된 대상만 삭제할 수 있습니다 (지금: {state})', { state: t.state }));
  const provider = providers.get(t.platform);
  if (!provider?.remove) throw new Error(msg('{provider}는 API로 삭제할 수 없습니다. 앱에서 직접 지우세요', { provider: provider?.displayName ?? t.platform }));
  let account = ctx.store.getAccount(t.platform, t.account);
  if (!account) throw new Error(msg('연결된 계정이 없습니다: {platform}/{account}', { platform: t.platform, account: t.account }));
  // A first comment not yet tried is taken first, before anything waits on the network, so neither
  // the worker nor a retry can post it to a post being removed. If the post can't be removed after
  // all, it is handed back and goes up as planned.
  const now = () => ctx.now().toISOString();
  const held = !t.followup && Boolean(ctx.store.getPost(t.postId)?.firstComment) && ctx.store.claimFollowup(t.id, undefined, { state: 'canceled', at: now() });
  const notes: string[] = [];
  let replyRemoved = false;
  try {
    account = await provider.refresh(ctx, account);
    // Where the first comment is a post of its own (X), it goes first: a failure then leaves the post
    // up with its reply, never a reply with nothing to answer.
    const f = ctx.store.getTarget(t.id)?.followup;
    if (provider.firstCommentIsPost && f?.state === 'posted' && f.id) {
      await provider.remove({ ctx, account, target: { ...t, remoteId: f.id } });
      replyRemoved = true;
    } else if (provider.firstCommentIsPost && (f?.state === 'sending' || f?.maybePosted)) {
      notes.push(msg('첫 댓글 답글이 올라갔는지 알 수 없어 지우지 못했습니다. {platform}에서 확인해 직접 지우세요', { platform: provider.displayName }));
    }
    await provider.remove({ ctx, account, target: { ...t, remoteId: t.remoteId } });
  } catch (err) {
    // The post stays up: its first comment goes back to waiting, or, if its reply is already gone,
    // can be posted again.
    if (held) ctx.store.setFollowup(t.id, null);
    if (replyRemoved) ctx.store.setFollowup(t.id, { state: 'failed', at: now(), error: msg('게시물을 지우려고 첫 댓글 답글을 먼저 지웠습니다') });
    throw err;
  }
  if (replyRemoved) ctx.store.setFollowup(t.id, { state: 'canceled', at: now() });
  return ctx.store.transition(t.id, 'removed', notes.length ? { warnings: [...t.warnings, ...notes] } : {}, 'removed by user');
}

/**
 * Change a published target's visibility on the platform (YouTube), optionally scheduling it to go
 * public at `publishAt`. The target's options record the new value.
 */
export async function changeVisibility(
  baseCtx: ProviderContext,
  providers: Map<string, Provider>,
  targetId: string,
  visibility: string,
  publishAt?: string,
): Promise<Target> {
  const ctx = withTimeout(baseCtx);
  const t = ctx.store.getTarget(targetId);
  if (!t) throw new Error(msg('대상 없음: {targetId}', { targetId }));
  if (t.state !== 'published' || !t.remoteId) throw new Error(msg('게시된 대상만 공개 범위를 바꿀 수 있습니다 (지금: {state})', { state: t.state }));
  const provider = providers.get(t.platform);
  if (!provider?.setVisibility) throw new Error(msg('{provider}는 API로 공개 범위를 바꿀 수 없습니다', { provider: provider?.displayName ?? t.platform }));
  if (!provider.visibilities?.includes(visibility)) throw new Error(msg('공개 범위는 {values} 중 하나', { values: (provider.visibilities ?? []).join(', ') }));
  if (publishAt !== undefined) {
    const at = Date.parse(publishAt);
    if (Number.isNaN(at) || at <= ctx.now().getTime()) throw new Error(msg('예약 공개 시각은 앞으로의 ISO-8601 시각이어야 합니다'));
    if (visibility !== 'public') throw new Error(msg('예약해서 바꿀 수 있는 것은 공개(public)뿐입니다'));
  }
  let account = ctx.store.getAccount(t.platform, t.account);
  if (!account) throw new Error(msg('연결된 계정이 없습니다: {platform}/{account}', { platform: t.platform, account: t.account }));
  account = await provider.refresh(ctx, account);
  const now = await provider.setVisibility({ ctx, account, target: { ...t, remoteId: t.remoteId }, visibility, publishAt });
  // Recorded as the platform reports it, so the board shows the real state; a mismatch is said out loud.
  const { publishAt: _, ...rest } = t.options;
  const wanted = publishAt ? 'private' : visibility;
  const warnings = now.visibility === wanted ? t.warnings : [...t.warnings, msg('{requested}로 요청했지만 플랫폼이 {actual}로 두었습니다', { requested: visibility, actual: now.visibility })];
  // null, not absent: the upload's own schedule no longer applies once the visibility was changed.
  return ctx.store.updateTarget(t.id, { options: { ...rest, privacy: now.visibility, publishAt: now.publishAt ?? null }, warnings });
}

export interface EditResult {
  targetId: string;
  platform: string;
  account: string;
  status: 'updated' | 'skipped' | 'failed';
  detail?: string;
}

/**
 * Change a post's title/description/tags and push the change to every published target whose
 * platform can edit posts. The post record is updated first, so targets still queued pick it up.
 */
export async function editPost(
  baseCtx: ProviderContext,
  providers: Map<string, Provider>,
  postId: string,
  patch: Partial<Pick<Post, 'title' | 'description' | 'tags'>>,
): Promise<EditResult[]> {
  const ctx = withTimeout(baseCtx);
  const current = ctx.store.getPost(postId);
  if (!current) throw new Error(msg('게시물 없음: {postId}', { postId }));
  if (patch.title !== undefined && !patch.title.trim()) throw new Error(msg('제목이 비어 있습니다'));
  const post = ctx.store.updatePost(postId, patch);
  const out: EditResult[] = [];
  for (const t of ctx.store.targetsForPost(postId)) {
    const base = { targetId: t.id, platform: t.platform, account: t.account };
    const provider = providers.get(t.platform);
    if (t.state !== 'published' || !t.remoteId) {
      // A queued target that already started uploading (resume data) keeps the text it started with.
      const fresh = (t.state === 'queued' || t.state === 'transcoding') && !t.resume;
      const detail = isTerminal(t.state)
        ? msg('{state} 상태라 고치지 않았습니다', { state: t.state })
        : fresh
          ? msg('아직 올리기 전이라 바뀐 내용으로 올라갑니다')
          : msg('올리는 중이라 반영되지 않았습니다. 게시된 뒤 다시 수정하세요');
      out.push({ ...base, status: 'skipped', detail });
      continue;
    }
    if (!provider?.update) {
      out.push({ ...base, status: 'skipped', detail: msg('{provider}는 API로 게시물을 고칠 수 없습니다', { provider: provider?.displayName ?? t.platform }) });
      continue;
    }
    // Posted with its own caption/text: the title/description edit wouldn't change what it shows.
    const own = t.options.caption ?? t.options.text;
    if (typeof own === 'string' && own.trim()) {
      out.push({ ...base, status: 'skipped', detail: msg('이 대상은 플랫폼별 글(caption/text)을 따로 지정해 올려서 바꾸지 않았습니다') });
      continue;
    }
    try {
      let account = ctx.store.getAccount(t.platform, t.account);
      if (!account) throw new Error(msg('연결된 계정이 없습니다'));
      account = await provider.refresh(ctx, account);
      await provider.update({ ctx, account, target: { ...t, remoteId: t.remoteId }, post });
      out.push({ ...base, status: 'updated' });
    } catch (err) {
      out.push({ ...base, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/**
 * The same context with a deadline on every request that doesn't bring its own signal. For short
 * API calls (stats, comments, edit, delete) — never for uploads, which can legitimately run long.
 */
export function withTimeout(ctx: ProviderContext, ms = 20_000): ProviderContext {
  // A request that brings its own signal keeps it: token rotations pass a longer one (http.rotationContext).
  return { ...ctx, fetch: ((input, init) => ctx.fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) })) as typeof fetch };
}

export interface CommentsResult {
  targetId: string;
  platform: string;
  account: string;
  comments?: Comment[];
  /** The platform lets fanout reply to these comments. */
  canReply?: boolean;
  /** The platform lets fanout hide these comments. */
  canHide?: boolean;
  skipped?: string;
  error?: string;
}

/** Newest comments for each published target of a post, read live (nothing is stored). */
export async function fetchComments(baseCtx: ProviderContext, providers: Map<string, Provider>, postId: string, limit = 20, only?: (platform: string) => boolean): Promise<CommentsResult[]> {
  const ctx = withTimeout(baseCtx);
  const out: CommentsResult[] = [];
  for (const t of ctx.store.targetsForPost(postId).filter((t) => !only || only(t.platform))) {
    const base = { targetId: t.id, platform: t.platform, account: t.account };
    const provider = providers.get(t.platform);
    if (t.state !== 'published' || !t.remoteId) {
      out.push({ ...base, skipped: t.state === 'removed' ? msg('플랫폼에서 삭제했습니다') : msg('게시된 대상이 아닙니다') });
      continue;
    }
    if (remoteIdUnknown(t)) {
      out.push({ ...base, skipped: remoteIdUnknownNote() });
      continue;
    }
    if (!provider?.comments) {
      out.push({ ...base, skipped: msg('{provider} 댓글은 아직 가져올 수 없습니다', { provider: provider?.displayName ?? t.platform }) });
      continue;
    }
    try {
      let account = ctx.store.getAccount(t.platform, t.account);
      if (!account) throw new Error(msg('연결된 계정이 없습니다'));
      account = await provider.refresh(ctx, account);
      const comments = withHidden(await provider.comments({ ctx, account, target: { ...t, remoteId: t.remoteId }, limit }), t);
      out.push({ ...base, comments, canReply: Boolean(provider.reply), canHide: Boolean(provider.hideComment) });
    } catch (err) {
      out.push({ ...base, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Comments fanout hid on this target, kept so they can be shown again once the platform stops listing them. */
function hiddenByFanout(t: Target): Comment[] {
  return ((t.resume as { hiddenComments?: Comment[] } | undefined)?.hiddenComments ?? []).filter((c) => typeof c?.id === 'string');
}

/**
 * A listed comment is hidden only if the platform says so (YouTube doesn't list held comments at
 * all); the ones fanout hid that are no longer listed are added back, marked hidden, so they can
 * be shown again.
 */
function withHidden(listed: Comment[], t: Target): Comment[] {
  const ids = new Set(listed.map((c) => c.id));
  const gone = hiddenByFanout(t).filter((c) => !ids.has(c.id));
  return [...listed.map((c) => ({ ...c, hidden: c.hidden === true })), ...gone.map((c) => ({ ...c, hidden: true }))];
}

export interface CrossPostSuggestion {
  postId: string;
  title: string;
  /** Views where it did best. */
  views: number;
  platform: string;
  /** Connected accounts it hasn't gone to, whose rules the post and video meet (converted if need be). */
  targets: Array<{ platform: string; account: string; transcode: boolean; vertical?: boolean }>;
  /** Choices the add still needs on some platform (e.g. YouTube visibility), named by validate. */
  needsChoices: string[];
  command: string;
}

/** Validate codes that only mean "pick this on the add", not "this post can't go there". */
const CHOICE_CODES = new Set(['privacy', 'made_for_kids', 'visibility', 'music_consent', 'schedule_privacy']);
/** States after which the user meant it to be gone from there (or it's still going): no suggestion. */
const SETTLED_STATES: ReadonlySet<Target['state']> = new Set([...COVERING_STATES, 'removed', 'canceled']);

/**
 * Top posts of the last `days` that could also go where they haven't: connected accounts (with their
 * app set up and access not refused) not on the post, whose rules the post and the original video
 * meet — as is, after conversion, or with a vertical fit. Only posts whose original is still there
 * (`fanout add` needs it). Suggestions only: nothing is posted.
 */
export async function suggestCrossPosts(
  ctx: ProviderContext,
  providers: Map<string, Provider>,
  opts: { days?: number; max?: number; probe?: (path: string) => Promise<MediaInfo> } = {},
): Promise<CrossPostSuggestion[]> {
  const insights = computeInsights(ctx.store, ctx.now(), { days: opts.days ?? 30 });
  // The best showing of each post, best first.
  const best = new Map<string, { title: string; views: number; platform: string }>();
  for (const g of insights.groups) {
    for (const t of g.top) if ((best.get(t.postId)?.views ?? -1) < t.views) best.set(t.postId, { title: t.title, views: t.views, platform: g.platform });
  }
  const accounts = ctx.store.listAccounts().filter((a) => {
    const p = providers.get(a.platform);
    if (!p || !appReady(ctx.store, p)) return false;
    const c = ctx.store.getAccount(a.platform, a.name)?.credentials as { authFailedAt?: number; forgottenAt?: number } | undefined;
    return Boolean(c) && c!.authFailedAt === undefined && c!.forgottenAt === undefined;
  });
  const out: CrossPostSuggestion[] = [];
  for (const [postId, b] of [...best.entries()].sort((x, y) => y[1].views - x[1].views)) {
    if (out.length >= (opts.max ?? 5)) break;
    const post = ctx.store.getPost(postId);
    if (!post || !existsSync(post.mediaPath)) continue;
    const onPost = ctx.store.targetsForPost(postId);
    const settled = (platform: string, account: string) => onPost.some((t) => t.platform === platform && t.account === account && (SETTLED_STATES.has(t.state) || (t.state === 'failed' && mayBeLive(t))));
    const open = accounts.filter((a) => !settled(a.platform, a.name));
    if (!open.length) continue;
    let media: MediaInfo;
    try {
      media = await (opts.probe ?? probeMedia)(post.mediaPath);
    } catch {
      continue;
    }
    const targets: CrossPostSuggestion['targets'] = [];
    const choices = new Set<string>();
    for (const a of open) {
      const provider = providers.get(a.platform)!;
      // What `fanout add` would run: the post's own text and the platform's rules (TikTok defaults to inbox).
      const check = (options: Record<string, unknown>) => {
        const target: Target = { id: 'suggest', postId, platform: a.platform, account: a.name, options, state: 'queued', warnings: [], attempts: 0, updatedAt: post.createdAt };
        const errors = provider.validate(post, target, media, ctx.store.getAccount(a.platform, a.name)).filter((i) => i.severity === 'error');
        const media_ = checkMedia(media, targetSpec(provider, post, target));
        return { hard: errors.filter((e) => !CHOICE_CODES.has(e.code)), choices: errors.filter((e) => CHOICE_CODES.has(e.code)), blocked: media_.some((v) => !v.fixable), transcode: media_.length > 0 };
      };
      const base = a.platform === 'tiktok' ? { mode: 'inbox' } : {};
      let r = check(base);
      let vertical = false;
      // A landscape video stopped only by the shape can go with a vertical fit.
      if (r.blocked && !r.hard.length) {
        const fitted = check({ ...base, fit: 'pad' });
        if (!fitted.blocked) [r, vertical] = [fitted, true];
      }
      if (r.blocked || r.hard.length) continue;
      for (const c of r.choices) choices.add(c.message);
      targets.push({ platform: a.platform, account: a.name, transcode: r.transcode, ...(vertical ? { vertical: true } : {}) });
    }
    if (!targets.length) continue;
    // A bare platform means main, or its only account (as `fanout add` reads it).
    const plain = (platform: string, account: string) => {
      const names = accounts.filter((x) => x.platform === platform).map((x) => x.name);
      return account === 'main' || (names.length === 1 && !names.includes('main'));
    };
    const to = targets.map((t) => (plain(t.platform, t.account) ? t.platform : `${t.platform}:${t.account}`)).join(',');
    const fit = targets.some((t) => t.vertical) ? ' --vertical pad' : '';
    out.push({ postId, title: b.title, views: b.views, platform: b.platform, targets, needsChoices: [...choices], command: `fanout add ${postId.slice(0, 8)} --to ${to}${fit}` });
  }
  return out;
}

export interface InboxItem {
  postId: string;
  title: string;
  targetId: string;
  platform: string;
  account: string;
  comment: Comment;
  canReply: boolean;
  canHide: boolean;
}

/**
 * Comments still waiting for the account's reply, across the posts published in the last `days`
 * (newest posts first, at most `maxPosts` of them: each read is a platform call). Comments the
 * account wrote, hidden ones and ones the platform can't say about are left out; how many couldn't
 * be told is counted.
 */
export async function commentInbox(
  ctx: ProviderContext,
  providers: Map<string, Provider>,
  opts: { days?: number; maxPosts?: number; perPost?: number } = {},
): Promise<{ items: InboxItem[]; posts: number; unknown: number; errors: string[] }> {
  const since = ctx.now().getTime() - (opts.days ?? 7) * 86_400_000;
  const recent = new Map<string, number>();
  // Only platforms that can say whether a comment was answered: the rest would just cost calls.
  const knows = (platform: string) => Boolean(providers.get(platform)?.comments && providers.get(platform)?.commentsKnowAnswers);
  for (const t of ctx.store.publishedTargets()) {
    if (!knows(t.platform)) continue;
    const at = (ctx.store.stateSince(t.id, 'published') ?? new Date(t.updatedAt)).getTime();
    if (at >= since) recent.set(t.postId, Math.max(recent.get(t.postId) ?? 0, at));
  }
  const postIds = [...recent.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.maxPosts ?? 20).map(([id]) => id);
  const items: InboxItem[] = [];
  const errors: string[] = [];
  let unknown = 0;
  for (const postId of postIds) {
    const title = ctx.store.getPost(postId)?.title ?? postId;
    for (const r of await fetchComments(ctx, providers, postId, opts.perPost ?? 50, knows)) {
      if (r.error) errors.push(`${r.platform}/${r.account}: ${r.error}`);
      for (const c of r.comments ?? []) {
        if (c.mine || c.hidden) continue;
        if (c.answered === undefined) unknown++;
        else if (!c.answered) items.push({ postId, title, targetId: r.targetId, platform: r.platform, account: r.account, comment: c, canReply: Boolean(r.canReply), canHide: Boolean(r.canHide) });
      }
    }
  }
  items.sort((a, b) => Date.parse(b.comment.at) - Date.parse(a.comment.at));
  return { items, posts: postIds.length, unknown, errors };
}

export const REPLY_MAX_CHARS = 5000;
/** How far back a reply's comment is looked up; older comments can be answered on the platform itself. */
const REPLY_LOOKBACK = 100;

/**
 * Reply to a top-level comment on a published target, as the connected account. The comment must
 * be among the post's recent comments, so a stray or injected id can't make fanout answer some
 * other thread. Exactly one attempt: a reply whose response was lost may already be up.
 */
export async function replyToComment(
  baseCtx: ProviderContext,
  providers: Map<string, Provider>,
  targetId: string,
  commentId: string,
  text: string,
): Promise<{ id: string; url?: string }> {
  const ctx = withTimeout(baseCtx);
  const t = ctx.store.getTarget(targetId);
  if (!t) throw new Error(msg('대상 없음: {targetId}', { targetId }));
  if (t.state !== 'published' || !t.remoteId) throw new Error(msg('게시된 대상의 댓글에만 답글을 달 수 있습니다'));
  const provider = providers.get(t.platform);
  if (!provider?.reply || !provider.comments) throw new Error(msg('{provider}에는 아직 답글을 달 수 없습니다', { provider: provider?.displayName ?? t.platform }));
  const body = text.trim();
  if (!body) throw new Error(msg('답글 내용을 입력하세요'));
  if (body.length > REPLY_MAX_CHARS) throw new Error(msg('답글은 {REPLY_MAX_CHARS}자 이하로 써 주세요', { REPLY_MAX_CHARS }));
  let account = ctx.store.getAccount(t.platform, t.account);
  if (!account) throw new Error(msg('연결된 계정이 없습니다: {platform}/{account}', { platform: t.platform, account: t.account }));
  account = await provider.refresh(ctx, account);
  const target = { ...t, remoteId: t.remoteId };
  const comment = (await provider.comments({ ctx, account, target, limit: REPLY_LOOKBACK })).find((c) => c.id === commentId);
  if (!comment) throw new Error(msg('이 게시물의 최근 댓글 중에 그 댓글이 없습니다. 댓글을 다시 불러온 뒤 시도하세요'));
  let sent = false;
  try {
    const out = await provider.reply({ ctx, account, target, comment, text: body, sending: () => (sent = true) });
    ctx.log.info(msg('{platform}/{account}: 댓글 {commentId}에 답글 {id}', { platform: t.platform, account: t.account, commentId, id: out.id }));
    return out;
  } catch (err) {
    // A refusal is final and nothing was posted; anything else (timeout, 5xx) may have gone through.
    if (!sent || (err instanceof ProviderError && (err.kind === 'rejected' || err.kind === 'auth'))) throw err;
    throw new Error(msg('답글 응답을 받지 못했습니다({err}). 이미 달렸을 수 있으니 댓글을 다시 불러와 확인한 뒤 필요하면 다시 쓰세요', { err: err instanceof Error ? err.message : String(err) }));
  }
}

/**
 * Hide (or show again) one of a published post's comments. The id must be among the post's recent
 * comments, or (to show again) one fanout hid on this post itself: an id from anywhere else (a
 * prompt-injected agent asking to publish a comment the platform held as spam) is refused.
 */
export async function hideComment(baseCtx: ProviderContext, providers: Map<string, Provider>, targetId: string, commentId: string, hidden = true): Promise<void> {
  const ctx = withTimeout(baseCtx);
  const t = ctx.store.getTarget(targetId);
  if (!t) throw new Error(msg('대상 없음: {targetId}', { targetId }));
  if (t.state !== 'published' || !t.remoteId) throw new Error(msg('게시된 대상의 댓글만 숨길 수 있습니다'));
  const provider = providers.get(t.platform);
  if (!provider?.hideComment || !provider.comments) throw new Error(msg('{provider}는 API로 댓글을 숨길 수 없습니다', { provider: provider?.displayName ?? t.platform }));
  let account = ctx.store.getAccount(t.platform, t.account);
  if (!account) throw new Error(msg('연결된 계정이 없습니다: {platform}/{account}', { platform: t.platform, account: t.account }));
  account = await provider.refresh(ctx, account);
  const target = { ...t, remoteId: t.remoteId };
  const ours = hiddenByFanout(t);
  const remember = (list: Comment[]) => ctx.store.updateTarget(t.id, { resume: { ...ctx.store.getTarget(t.id)!.resume, hiddenComments: list } });
  const rest = ours.filter((c) => c.id !== commentId);
  // Showing again only undoes fanout's own hides: Meta also lists comments its filters or another
  // admin hid, and YouTube holds spam, and none of those are for an agent to publish.
  if (!hidden && rest.length === ours.length) {
    throw new Error(msg('fanout이 이 게시물에서 숨긴 댓글만 다시 보이게 할 수 있습니다. 다른 댓글은 플랫폼에서 직접 확인하세요'));
  }
  const listed = hidden ? (await provider.comments({ ctx, account, target, limit: REPLY_LOOKBACK })).find((c) => c.id === commentId) : undefined;
  if (hidden && !listed) throw new Error(msg('이 게시물의 최근 댓글 중에 그 댓글이 없습니다. 댓글을 다시 불러온 뒤 시도하세요'));
  // Instagram accepts the call but keeps the owner's own comments visible: say so instead.
  if (hidden && listed?.hideable === false) throw new Error(msg('이 계정이 직접 쓴 댓글은 {platform}에서 숨겨지지 않습니다. 지우려면 앱에서 삭제하세요', { platform: provider.displayName }));
  try {
    await provider.hideComment({ ctx, account, target, commentId, hidden });
  } catch (err) {
    // Deleted since (by its author or on the platform): nothing left to show, so stop listing it.
    if (!hidden && err instanceof ProviderError && err.kind === 'rejected' && /^(commentNotFound|notFound|100)/.test(err.platformCode ?? '')) {
      remember(rest);
      throw new Error(msg('그 댓글은 플랫폼에 더 이상 없습니다 (삭제됨). 숨긴 목록에서 뺐습니다'));
    }
    throw err;
  }
  // Remember what fanout hid (a held YouTube comment drops out of the list) so it can be shown again.
  remember(hidden && listed ? [...rest, { id: listed.id, author: listed.author, text: listed.text, at: listed.at, ...(listed.url ? { url: listed.url } : {}) }] : rest);
  const vars = { platform: t.platform, account: t.account, commentId };
  ctx.log.info(hidden ? msg('{platform}/{account}: 댓글 {commentId}을(를) 숨겼습니다', vars) : msg('{platform}/{account}: 댓글 {commentId}을(를) 다시 보이게 했습니다', vars));
}

/** Resume keys that mean something was created on the platform, or the final request was sent. */
const REMOTE_PROGRESS_KEYS = ['posting', 'sessionUri', 'videoId', 'finalSent', 'publishId', 'finished', 'mediaId', 'statusId', 'tweetId', 'containerId', 'rkey', 'postUri'];

/** Why this not-yet-published target might still be (or become) live on the platform, if it might. */
export function mayBeLive(t: Target): string | undefined {
  if (t.errorCode && /maybe_posted|media_attached|processing_timeout/.test(t.errorCode)) return msg('"{errorCode}"로 멈췄습니다', { errorCode: t.errorCode });
  if (t.remoteId) return msg('플랫폼에 이미 만들어진 항목이 있습니다');
  const keys = Object.keys(t.resume ?? {}).filter((k) => REMOTE_PROGRESS_KEYS.includes(k));
  if (keys.length) return msg('업로드가 중간까지 진행됐습니다 ({keys})', { keys: keys.join(', ') });
  return undefined;
}

export class MaybeLiveError extends Error {
  readonly code = 'maybe_live';
  constructor(t: Target, reason: string) {
    super(
      msg('{platform}/{account}: {reason}. 이미 게시됐거나 나중에 게시될 수 있습니다. 플랫폼에서 올라가지 않은 것을 확인한 뒤에만 취소하세요. 취소하면 다시 시도하거나 삭제할 수 없습니다', {
        platform: t.platform,
        account: t.account,
        reason,
      }),
    );
  }
}

/**
 * Give up on a target that hasn't gone out: queued (incl. scheduled for later), failed or
 * needs_reauth. Refuses while a process is working on it, since an upload may be mid-flight.
 */
export function cancelTarget(store: Store, id: string, opts: { confirmedNotPosted?: boolean } = {}): Target {
  const t = store.getTarget(id);
  if (!t) throw new Error(msg('대상 없음: {id}', { id }));
  if (!['queued', 'failed', 'needs_reauth'].includes(t.state)) {
    throw new Error(t.state === 'published' ? msg('이미 게시됐습니다. 지우려면 삭제를 쓰세요') : msg('{state} 상태는 취소할 수 없습니다', { state: t.state }));
  }
  // Canceled targets can't be retried or removed and stop counting as posted, so a target that may
  // already be on the platform is only canceled once the user has looked and vouched it isn't.
  const live = mayBeLive(t);
  if (live && !opts.confirmedNotPosted) throw new MaybeLiveError(t, live);
  // Take the target's lease so no worker can start uploading it between this check and the change.
  const owner = `cancel:${randomUUID()}`;
  if (!store.claim(id, owner, 30_000, isStaleOwner)) throw new Error(msg('지금 처리 중이라 취소할 수 없습니다. 잠시 뒤 다시 시도하세요'));
  try {
    return store.transition(id, 'canceled', { notBefore: undefined }, 'canceled by user');
  } finally {
    store.release(id, owner);
  }
}
