// The part of a preview that asks the platforms: each target account's limits (core/limits.ts) and
// its own posting rules (e.g. TikTok creator_info). Run after previewPost's offline checks, with a
// short deadline per account; anything that can't be read is left out, so a preview never fails
// over it.

import { addLimitWarnings } from './limits.ts';
import type { MediaInfo } from './media.ts';
import { withTimeout } from './posting.ts';
import type { Provider, ProviderContext } from './provider.ts';
import type { Post, PostInput, Target, TargetInput } from './types.ts';

export interface LivePreview {
  platform: string;
  account: string;
  warnings: string[];
  errors?: string[];
  verdict?: string;
}

export async function addLiveChecks(
  ctx: ProviderContext,
  providers: Map<string, Provider>,
  previews: LivePreview[],
  plan: { input: PostInput; targets: TargetInput[]; media: MediaInfo },
  timeoutMs = 8_000,
): Promise<void> {
  const post: Post = { ...plan.input, id: 'preview', createdAt: new Date(0).toISOString() };
  const byKey = new Map(plan.targets.map((t) => [`${t.platform}/${t.account}`, t]));
  await Promise.all([
    addLimitWarnings(ctx, providers, previews, plan.media.sizeBytes, timeoutMs),
    ...previews.map(async (p) => {
      const provider = providers.get(p.platform);
      const t = byKey.get(`${p.platform}/${p.account}`);
      const account = ctx.store.getAccount(p.platform, p.account);
      if (!provider?.previewChecks || !t || !account) return;
      const target: Target = { id: 'preview', postId: post.id, platform: t.platform, account: t.account, options: t.options, state: 'queued', warnings: [], attempts: 0, updatedAt: post.createdAt };
      const issues = await provider.previewChecks({ ctx: withTimeout(ctx, timeoutMs), account, post, target, media: plan.media }).catch(() => []);
      for (const i of issues) {
        if (i.severity === 'error') {
          (p.errors ??= []).push(i.message);
          if (p.verdict !== undefined) p.verdict = 'blocked';
        } else p.warnings.push(i.message);
      }
    }),
  ]);
}
