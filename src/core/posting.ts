import { randomUUID } from 'node:crypto';
import { ProviderError } from './errors.ts';
import { isStaleOwner } from './lease.ts';
import { checkMedia, type MediaInfo, type Violation } from './media.ts';
import { isTerminal } from './state.ts';
import type { Provider, ProviderContext } from './provider.ts';
import type { Store } from './store.ts';
import { statsTrend } from './stats.ts';
import type { Comment, Post, PostInput, PostStats, StatsTrend, Target, TargetInput } from './types.ts';

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
  const { post, targets: created } = store.createPost(input, targets);
  if (!input.scheduledAt) return { post, targets: created };
  const updated = created.map((t) =>
    providers.get(t.platform)?.capabilities.nativeSchedule ? t : store.updateTarget(t.id, { notBefore: input.scheduledAt }),
  );
  return { post, targets: updated };
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
      return scheduledAt ? `private → ${scheduledAt}에 public` : String(o.privacy ?? '(미지정)');
    case 'mastodon':
      return `${String(o.visibility ?? '(공개 범위 미지정)')}${scheduledAt ? `, ${scheduledAt}에 게시` : ''}`;
    case 'peertube':
      return scheduledAt ? `private → ${scheduledAt}에 ${String(o.privacy ?? '(미지정)')}` : String(o.privacy ?? '(공개 범위 미지정)');
    case 'tiktok':
      return o.mode === 'direct' ? `direct, ${String(o.privacyLevel ?? '(공개 범위 미지정)')}` : 'inbox (TikTok 앱에서 마무리)';
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
    if (!provider) return { ...base, verdict: 'blocked' as const, errors: [`알 수 없는 플랫폼: ${t.platform}`], warnings: [], transcode: [] };
    const target: Target = { id: 'preview', postId: post.id, platform: t.platform, account: t.account, options: t.options, state: 'queued', warnings: [], attempts: 0, updatedAt: post.createdAt };
    const issues = provider.validate(post, target, media);
    const violations = checkMedia(media, provider.specFor?.(post, target) ?? provider.spec);
    const errors = [...issues.filter((i) => i.severity === 'error').map((i) => i.message), ...violations.filter((v) => !v.fixable).map((v) => v.message)];
    if (!account) errors.push(`연결되지 않은 계정: ${t.platform}/${t.account}`);
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

/**
 * Queue a failed or needs_reauth target again on the user's request. Clears the error and backoff,
 * and the `posting` marker a provider leaves when a post's outcome was unknown: the user retrying
 * means they checked it did not go out.
 */
export function retryTarget(store: Store, id: string, via: string): Target {
  const t = store.getTarget(id);
  if (!t) throw new Error(`대상 없음: ${id}`);
  if (t.state !== 'failed' && t.state !== 'needs_reauth') throw new Error(`${t.state} 상태는 다시 시도할 수 없습니다`);
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
  return `이 영상은 ${when}(UTC)에 이미 올렸습니다 — ${prior.state}${prior.url ? ` ${prior.url}` : ''}`;
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
      const why = t.state === 'handed_off' ? '앱에서 마무리한 게시물은 id를 몰라 가져올 수 없습니다' : t.state === 'removed' ? '플랫폼에서 삭제했습니다' : '게시되지 않았습니다';
      out.push({ ...base, skipped: why });
      continue;
    }
    if (!provider?.stats) {
      out.push({ ...base, skipped: `${provider?.displayName ?? t.platform}는 반응 통계를 가져올 수 없습니다` });
      continue;
    }
    if (provider.statsCost && !opts.includePaid) {
      out.push({ ...base, skipped: provider.statsCost });
      continue;
    }
    let account = ctx.store.getAccount(t.platform, t.account);
    if (!account) {
      out.push({ ...base, skipped: '연결된 계정이 없습니다' });
      continue;
    }
    let stats: PostStats;
    let failed = false;
    try {
      account = await provider.refresh(ctx, account);
      stats = { ...(await provider.stats({ ctx, account, target: { ...t, remoteId: t.remoteId } })), fetchedAt: ctx.now().toISOString() };
    } catch (err) {
      failed = true;
      stats = { ...(t.stats ?? {}), fetchedAt: ctx.now().toISOString(), note: `가져오지 못함: ${err instanceof Error ? err.message : String(err)}` };
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
  if (!t) throw new Error(`대상 없음: ${targetId}`);
  if (t.state !== 'published' || !t.remoteId) throw new Error(`게시된 대상만 삭제할 수 있습니다 (지금: ${t.state})`);
  const provider = providers.get(t.platform);
  if (!provider?.remove) throw new Error(`${provider?.displayName ?? t.platform}는 API로 삭제할 수 없습니다. 앱에서 직접 지우세요`);
  let account = ctx.store.getAccount(t.platform, t.account);
  if (!account) throw new Error(`연결된 계정이 없습니다: ${t.platform}/${t.account}`);
  account = await provider.refresh(ctx, account);
  await provider.remove({ ctx, account, target: { ...t, remoteId: t.remoteId } });
  return ctx.store.transition(t.id, 'removed', {}, 'removed by user');
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
  if (!current) throw new Error(`게시물 없음: ${postId}`);
  if (patch.title !== undefined && !patch.title.trim()) throw new Error('제목이 비어 있습니다');
  const post = ctx.store.updatePost(postId, patch);
  const out: EditResult[] = [];
  for (const t of ctx.store.targetsForPost(postId)) {
    const base = { targetId: t.id, platform: t.platform, account: t.account };
    const provider = providers.get(t.platform);
    if (t.state !== 'published' || !t.remoteId) {
      // A queued target that already started uploading (resume data) keeps the text it started with.
      const fresh = (t.state === 'queued' || t.state === 'transcoding') && !t.resume;
      const detail = isTerminal(t.state)
        ? `${t.state} 상태라 고치지 않았습니다`
        : fresh
          ? '아직 올리기 전이라 바뀐 내용으로 올라갑니다'
          : '올리는 중이라 반영되지 않았습니다. 게시된 뒤 다시 수정하세요';
      out.push({ ...base, status: 'skipped', detail });
      continue;
    }
    if (!provider?.update) {
      out.push({ ...base, status: 'skipped', detail: `${provider?.displayName ?? t.platform}는 API로 게시물을 고칠 수 없습니다` });
      continue;
    }
    // Posted with its own caption/text: the title/description edit wouldn't change what it shows.
    const own = t.options.caption ?? t.options.text;
    if (typeof own === 'string' && own.trim()) {
      out.push({ ...base, status: 'skipped', detail: '이 대상은 플랫폼별 글(caption/text)을 따로 지정해 올려서 바꾸지 않았습니다' });
      continue;
    }
    try {
      let account = ctx.store.getAccount(t.platform, t.account);
      if (!account) throw new Error('연결된 계정이 없습니다');
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
  return { ...ctx, fetch: ((input, init) => ctx.fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) })) as typeof fetch };
}

export interface CommentsResult {
  targetId: string;
  platform: string;
  account: string;
  comments?: Comment[];
  /** The platform lets fanout reply to these comments. */
  canReply?: boolean;
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
      out.push({ ...base, skipped: t.state === 'removed' ? '플랫폼에서 삭제했습니다' : '게시된 대상이 아닙니다' });
      continue;
    }
    if (!provider?.comments) {
      out.push({ ...base, skipped: `${provider?.displayName ?? t.platform} 댓글은 아직 가져올 수 없습니다` });
      continue;
    }
    try {
      let account = ctx.store.getAccount(t.platform, t.account);
      if (!account) throw new Error('연결된 계정이 없습니다');
      account = await provider.refresh(ctx, account);
      out.push({ ...base, comments: await provider.comments({ ctx, account, target: { ...t, remoteId: t.remoteId }, limit }), canReply: Boolean(provider.reply) });
    } catch (err) {
      out.push({ ...base, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
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
  if (!t) throw new Error(`대상 없음: ${targetId}`);
  if (t.state !== 'published' || !t.remoteId) throw new Error('게시된 대상의 댓글에만 답글을 달 수 있습니다');
  const provider = providers.get(t.platform);
  if (!provider?.reply || !provider.comments) throw new Error(`${provider?.displayName ?? t.platform}에는 아직 답글을 달 수 없습니다`);
  const body = text.trim();
  if (!body) throw new Error('답글 내용을 입력하세요');
  if (body.length > REPLY_MAX_CHARS) throw new Error(`답글은 ${REPLY_MAX_CHARS}자 이하로 써 주세요`);
  let account = ctx.store.getAccount(t.platform, t.account);
  if (!account) throw new Error(`연결된 계정이 없습니다: ${t.platform}/${t.account}`);
  account = await provider.refresh(ctx, account);
  const target = { ...t, remoteId: t.remoteId };
  const comment = (await provider.comments({ ctx, account, target, limit: REPLY_LOOKBACK })).find((c) => c.id === commentId);
  if (!comment) throw new Error('이 게시물의 최근 댓글 중에 그 댓글이 없습니다. 댓글을 다시 불러온 뒤 시도하세요');
  let sent = false;
  try {
    const out = await provider.reply({ ctx, account, target, comment, text: body, sending: () => (sent = true) });
    ctx.log.info(`${t.platform}/${t.account}: 댓글 ${commentId}에 답글 ${out.id}`);
    return out;
  } catch (err) {
    // A refusal is final and nothing was posted; anything else (timeout, 5xx) may have gone through.
    if (!sent || (err instanceof ProviderError && (err.kind === 'rejected' || err.kind === 'auth'))) throw err;
    throw new Error(`답글 응답을 받지 못했습니다(${err instanceof Error ? err.message : String(err)}). 이미 달렸을 수 있으니 댓글을 다시 불러와 확인한 뒤 필요하면 다시 쓰세요`);
  }
}

/** Resume keys that mean something was created on the platform, or the final request was sent. */
const REMOTE_PROGRESS_KEYS = ['posting', 'sessionUri', 'videoId', 'finalSent', 'publishId', 'finished', 'mediaId', 'statusId', 'tweetId', 'containerId', 'rkey', 'postUri'];

/** Why this not-yet-published target might still be (or become) live on the platform, if it might. */
export function mayBeLive(t: Target): string | undefined {
  if (t.errorCode && /maybe_posted|media_attached|processing_timeout/.test(t.errorCode)) return `"${t.errorCode}"로 멈췄습니다`;
  if (t.remoteId) return '플랫폼에 이미 만들어진 항목이 있습니다';
  const keys = Object.keys(t.resume ?? {}).filter((k) => REMOTE_PROGRESS_KEYS.includes(k));
  if (keys.length) return `업로드가 중간까지 진행됐습니다 (${keys.join(', ')})`;
  return undefined;
}

export class MaybeLiveError extends Error {
  readonly code = 'maybe_live';
  constructor(t: Target, reason: string) {
    super(
      `${t.platform}/${t.account}: ${reason}. 이미 게시됐거나 나중에 게시될 수 있습니다. ` +
        '플랫폼에서 올라가지 않은 것을 확인한 뒤에만 취소하세요. 취소하면 다시 시도하거나 삭제할 수 없습니다',
    );
  }
}

/**
 * Give up on a target that hasn't gone out: queued (incl. scheduled for later), failed or
 * needs_reauth. Refuses while a process is working on it, since an upload may be mid-flight.
 */
export function cancelTarget(store: Store, id: string, opts: { confirmedNotPosted?: boolean } = {}): Target {
  const t = store.getTarget(id);
  if (!t) throw new Error(`대상 없음: ${id}`);
  if (!['queued', 'failed', 'needs_reauth'].includes(t.state)) {
    throw new Error(t.state === 'published' ? '이미 게시됐습니다. 지우려면 삭제를 쓰세요' : `${t.state} 상태는 취소할 수 없습니다`);
  }
  // Canceled targets can't be retried or removed and stop counting as posted, so a target that may
  // already be on the platform is only canceled once the user has looked and vouched it isn't.
  const live = mayBeLive(t);
  if (live && !opts.confirmedNotPosted) throw new MaybeLiveError(t, live);
  // Take the target's lease so no worker can start uploading it between this check and the change.
  const owner = `cancel:${randomUUID()}`;
  if (!store.claim(id, owner, 30_000, isStaleOwner)) throw new Error('지금 처리 중이라 취소할 수 없습니다. 잠시 뒤 다시 시도하세요');
  try {
    return store.transition(id, 'canceled', { notBefore: undefined }, 'canceled by user');
  } finally {
    store.release(id, owner);
  }
}
