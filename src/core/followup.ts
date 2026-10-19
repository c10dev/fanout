import { msg } from './i18n.ts';
import { notifyEvent } from './notify.ts';
import type { Provider, ProviderContext } from './provider.ts';
import type { Followup, Target } from './types.ts';

/**
 * The post's first comment, posted from the same account once a target is published (and public).
 * Exactly once per target: `sending` is saved right before the request, and a target that has any
 * followup is never picked again by itself. A failure is the comment's, never the post's.
 */

/**
 * What each platform's comment API accepts, from its docs (2026-10). Instagram also refuses a
 * comment in all capitals. Breaking these fails only the comment, so they are warnings.
 */
const RULES: Record<string, { max: number; hashtags?: number; urls?: number }> = {
  youtube: { max: 10_000 },
  instagram: { max: 300, hashtags: 4, urls: 1 },
  facebook: { max: 8_000 },
};

/** Warnings about the first comment on one platform: not supported there, or past its limits. */
export function firstCommentWarnings(provider: Provider, text: string | undefined): string[] {
  const t = text?.trim();
  if (!t) return [];
  if (!provider.postComment) return [msg('첫 댓글: {platform}에는 API로 댓글을 달 수 없어 건너뜁니다', { platform: provider.displayName })];
  const rule = RULES[provider.id];
  if (!rule) return [];
  const out: string[] = [];
  const length = [...t].length;
  if (length > rule.max) out.push(msg('첫 댓글이 {platform} 한도({max}자)보다 깁니다 (지금 {length}자) — 댓글만 실패합니다', { platform: provider.displayName, max: rule.max, length }));
  const hashtags = t.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (rule.hashtags !== undefined && hashtags > rule.hashtags) out.push(msg('첫 댓글: {platform} 댓글은 해시태그 {max}개까지입니다 (지금 {n}개)', { platform: provider.displayName, max: rule.hashtags, n: hashtags }));
  const urls = t.match(/https?:\/\/\S+/g)?.length ?? 0;
  if (rule.urls !== undefined && urls > rule.urls) out.push(msg('첫 댓글: {platform} 댓글은 링크 {max}개까지입니다 (지금 {n}개)', { platform: provider.displayName, max: rule.urls, n: urls }));
  return out;
}

/** Look only at posts made in the last week: an old post gaining a comment out of nowhere would surprise. */
const FOLLOWUP_DAYS = 7;

/** Post (or try) one target's first comment and save the outcome. */
export async function postFirstComment(ctx: ProviderContext, providers: Map<string, Provider>, target: Target): Promise<Followup> {
  const { store } = ctx;
  const now = () => ctx.now().toISOString();
  const save = (f: Followup) => (store.setFollowup(target.id, f), f);
  const text = store.getPost(target.postId)?.firstComment?.trim();
  const provider = providers.get(target.platform);
  if (!text) return save({ state: 'failed', at: now(), error: msg('첫 댓글 내용이 없습니다') });
  if (!provider?.postComment) return save({ state: 'unsupported', at: now() });
  if (!target.remoteId) return save({ state: 'failed', at: now(), error: msg('플랫폼의 게시물 id가 없어 댓글을 달 수 없습니다') });
  const posted = { ...target, remoteId: target.remoteId };
  const account = store.getAccount(target.platform, target.account);
  if (!account) return save({ state: 'failed', at: now(), error: msg('연결되지 않은 계정: {platform}/{account}', { platform: target.platform, account: target.account }) });
  let sent = false;
  try {
    const res = await provider.postComment({
      ctx,
      account,
      target: posted,
      text,
      sending: () => {
        sent = true;
        store.setFollowup(target.id, { state: 'sending', at: now() });
      },
    });
    return save({ state: 'posted', at: now(), id: res.id, ...(res.url ? { url: res.url } : {}) });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const f = save({ state: 'failed', at: now(), error, ...(sent ? { maybePosted: true } : {}) });
    notifyEvent(ctx, 'alert', msg('{target}: 첫 댓글을 달지 못했습니다 — {error}', { target: `${target.platform}/${target.account}`, error }), { postId: target.postId, targetId: target.id, platform: target.platform });
    return f;
  }
}

/** First comments that are due, one after another. Resolves to how many were tried. */
export async function postDueFirstComments(ctx: ProviderContext, providers: Map<string, Provider>): Promise<number> {
  const now = ctx.now();
  const due = ctx.store.followupsDue(now.toISOString(), new Date(now.getTime() - FOLLOWUP_DAYS * 86_400_000).toISOString());
  for (const t of due) await postFirstComment(ctx, providers, t);
  return due.length;
}

/**
 * Try a target's first comment again, when the user asks. Refused while one may already be on the
 * platform (`sending`, or failed after the request went out) unless `confirmedNotPosted`.
 */
export async function retryFirstComment(ctx: ProviderContext, providers: Map<string, Provider>, targetId: string, confirmedNotPosted = false): Promise<Followup> {
  const target = ctx.store.getTarget(targetId);
  if (!target) throw new Error(msg('대상 없음: {targetId}', { targetId }));
  if (target.state !== 'published') throw new Error(msg('게시된 대상에만 첫 댓글을 달 수 있습니다'));
  const f = target.followup;
  if (f?.state === 'posted') throw new Error(msg('첫 댓글은 이미 달렸습니다'));
  if ((f?.state === 'sending' || f?.maybePosted) && !confirmedNotPosted) {
    throw Object.assign(new Error(msg('첫 댓글이 이미 달렸을 수 있습니다. 플랫폼에서 확인한 뒤 다시 시도하세요')), { needsConfirm: true });
  }
  return postFirstComment(ctx, providers, target);
}
