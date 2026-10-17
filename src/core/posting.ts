import { checkMedia, type MediaInfo, type Violation } from './media.ts';
import type { Provider } from './provider.ts';
import type { Store } from './store.ts';
import type { Post, PostInput, Target, TargetInput } from './types.ts';

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
      warnings: issues.filter((i) => i.severity === 'warning').map((i) => i.message),
      transcode: violations.filter((v) => v.fixable).map((v) => v.message),
    };
  });
}
