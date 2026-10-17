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
