import { checkMedia, type MediaInfo, type Violation } from './media.ts';
import type { Provider, ProviderContext } from './provider.ts';
import type { Store } from './store.ts';
import type { Post, PostInput, PostStats, Target, TargetInput } from './types.ts';

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
      if (!wanted.has(key) || t.state === 'failed') continue;
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
  /** Why nothing was fetched for this target. */
  skipped?: string;
}

/**
 * Fetch stats for a post's published targets and store them. Platforms that bill for reads (X) are
 * skipped unless `includePaid`; failures become notes instead of failing the whole refresh.
 */
export async function refreshStats(
  ctx: ProviderContext,
  providers: Map<string, Provider>,
  postId: string,
  opts: { includePaid?: boolean; platform?: string } = {},
): Promise<StatsResult[]> {
  const out: StatsResult[] = [];
  for (const t of ctx.store.targetsForPost(postId)) {
    if (opts.platform && t.platform !== opts.platform) continue;
    const base = { targetId: t.id, platform: t.platform, account: t.account };
    const provider = providers.get(t.platform);
    if (t.state !== 'published' || !t.remoteId) {
      out.push({ ...base, skipped: t.state === 'handed_off' ? '앱에서 마무리한 게시물은 id를 몰라 가져올 수 없습니다' : '게시되지 않았습니다' });
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
    try {
      account = await provider.refresh(ctx, account);
      stats = { ...(await provider.stats({ ctx, account, target: { ...t, remoteId: t.remoteId } })), fetchedAt: ctx.now().toISOString() };
    } catch (err) {
      stats = { ...(t.stats ?? {}), fetchedAt: ctx.now().toISOString(), note: `가져오지 못함: ${err instanceof Error ? err.message : String(err)}` };
    }
    ctx.store.saveStats(t.id, stats);
    out.push({ ...base, stats });
  }
  return out;
}
