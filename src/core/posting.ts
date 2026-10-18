import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ProviderError } from './errors.ts';
import { isStaleOwner } from './lease.ts';
import { checkMedia, type MediaInfo, type Violation } from './media.ts';
import { isTerminal } from './state.ts';
import type { Provider, ProviderContext } from './provider.ts';
import type { Store } from './store.ts';
import { statsTrend } from './stats.ts';
import type { Comment, Post, PostInput, PostStats, StatsTrend, Target, TargetInput } from './types.ts';
import { msg } from './i18n.ts';

export type Verdict = 'as_is' | 'transcode' | 'blocked';

export interface Assessment {
  platform: string;
  verdict: Verdict;
  violations: Violation[];
}

/** Per-platform verdict for one file: upload the original, transcode first, or cannot post. */
export function assessMedia(media: MediaInfo, providers: Iterable<Provider>): Assessment[] {
  return [...providers].map((p) => {
    const violations = checkMedia(media, p.spec);
    const verdict: Verdict = violations.some((v) => !v.fixable) ? 'blocked' : violations.length ? 'transcode' : 'as_is';
    return { platform: p.id, verdict, violations };
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

/** Where a post ends up and who can see it, as shown before uploading (YouTube policy asks for this). */
export function visibilityLabel(t: TargetInput, scheduledAt?: string): string {
  const o = t.options as Record<string, unknown>;
  switch (t.platform) {
    case 'youtube':
      return scheduledAt ? msg('private → {scheduledAt}에 public', { scheduledAt }) : String(o.privacy ?? msg('(미지정)'));
    case 'mastodon':
      return scheduledAt ? msg('{visibility}, {time}에 게시', { visibility: String(o.visibility ?? msg('(공개 범위 미지정)')), time: scheduledAt }) : String(o.visibility ?? msg('(공개 범위 미지정)'));
    case 'peertube':
      return scheduledAt ? msg('private → {time}에 {privacy}', { time: scheduledAt, privacy: String(o.privacy ?? msg('(미지정)')) }) : String(o.privacy ?? msg('(공개 범위 미지정)'));
    case 'tiktok':
      return o.mode === 'direct' ? 'direct, ' + String(o.privacyLevel ?? msg('(공개 범위 미지정)')) : msg('inbox (TikTok 앱에서 마무리)');
    default:
      return scheduledAt ? `public, ${scheduledAt}` : 'public';
  }
}

export interface TargetPreview {
  platform: string;
  account: string;
  accountLabel?: string;
  connected: boolean;
  visibility: string;
  verdict: Verdict;
  /** Anything here stops the upload. */
  errors: string[];
  warnings: string[];
  /** What a transcode would fix first. */
  transcode: string[];
}

/** Everything the runner's preflight would say, without creating anything. */
export function previewPost(
  store: Store,
  providers: Map<string, Provider>,
  input: PostInput,
  targets: TargetInput[],
  media: MediaInfo,
): TargetPreview[] {
  const post: Post = { ...input, id: 'preview', createdAt: new Date(0).toISOString() };
  const prior = priorPosts(store, input.mediaHash, targets);
  return targets.map((t) => {
    const provider = providers.get(t.platform);
    const account = store.getAccount(t.platform, t.account);
    const base = { platform: t.platform, account: t.account, connected: Boolean(account), visibility: visibilityLabel(t, input.scheduledAt) };
    if (!provider) return { ...base, verdict: 'blocked' as const, errors: [msg('알 수 없는 플랫폼: {platform}', { platform: t.platform })], warnings: [], transcode: [] };
    const target: Target = { id: 'preview', postId: post.id, platform: t.platform, account: t.account, options: t.options, state: 'queued', warnings: [], attempts: 0, updatedAt: post.createdAt };
    const issues = provider.validate(post, target, media, account ?? undefined);
    const violations = checkMedia(media, provider.specFor?.(post, target) ?? provider.spec);
    const errors = [...issues.filter((i) => i.severity === 'error').map((i) => i.message), ...violations.filter((v) => !v.fixable).map((v) => v.message)];
    if (!account) errors.push(msg('연결되지 않은 계정: {platform}/{account}', { platform: t.platform, account: t.account }));
    return {
      ...base,
      accountLabel: account ? accountLabel(account.profile, t.account) : undefined,
      verdict: errors.length ? 'blocked' : violations.length ? 'transcode' : 'as_is',
      errors,
      warnings: [...(prior.get(`${t.platform}/${t.account}`) ?? []).slice(0, 1).map(describePrior), ...issues.filter((i) => i.severity === 'warning').map((i) => i.message)],
      transcode: violations.filter((v) => v.fixable).map((v) => v.message),
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
export function planAddTargets(store: Store, providers: Map<string, Provider>, postId: string, targets: TargetInput[], media: MediaInfo): AddTargetsPlan {
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
  const preview = previewPost(store, providers, input, targets, media).map((p) =>
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
 * Queue a failed or needs_reauth target again on the user's request. Clears the error and backoff,
 * and the `posting` marker a provider leaves when a post's outcome was unknown: the user retrying
 * means they checked it did not go out.
 */
export function retryTarget(store: Store, id: string, via: string): Target {
  const t = store.getTarget(id);
  if (!t) throw new Error(msg('대상 없음: {id}', { id }));
  if (t.state !== 'failed' && t.state !== 'needs_reauth') throw new Error(msg('{state} 상태는 다시 시도할 수 없습니다', { state: t.state }));
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
  for (const t of ctx.store.targetsForPost(postId)) {
    if (opts.platform && t.platform !== opts.platform) continue;
    const base = { targetId: t.id, platform: t.platform, account: t.account };
    const provider = providers.get(t.platform);
    if (t.state !== 'published' || !t.remoteId) {
      const why = t.state === 'handed_off' ? msg('앱에서 마무리한 게시물은 id를 몰라 가져올 수 없습니다') : t.state === 'removed' ? msg('플랫폼에서 삭제했습니다') : msg('게시되지 않았습니다');
      out.push({ ...base, skipped: why });
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
    out.push({ ...base, stats, trend: statsTrend(ctx.store, t.id, ctx.now()) });
  }
  return out;
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
  account = await provider.refresh(ctx, account);
  await provider.remove({ ctx, account, target: { ...t, remoteId: t.remoteId } });
  return ctx.store.transition(t.id, 'removed', {}, 'removed by user');
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
export async function fetchComments(baseCtx: ProviderContext, providers: Map<string, Provider>, postId: string, limit = 20): Promise<CommentsResult[]> {
  const ctx = withTimeout(baseCtx);
  const out: CommentsResult[] = [];
  for (const t of ctx.store.targetsForPost(postId)) {
    const base = { targetId: t.id, platform: t.platform, account: t.account };
    const provider = providers.get(t.platform);
    if (t.state !== 'published' || !t.remoteId) {
      out.push({ ...base, skipped: t.state === 'removed' ? msg('플랫폼에서 삭제했습니다') : msg('게시된 대상이 아닙니다') });
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
