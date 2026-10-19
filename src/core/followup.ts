import { msg } from './i18n.ts';
import { notifyEvent } from './notify.ts';
import { remoteIdUnknown, remoteIdUnknownNote } from './remote.ts';
import { ProviderError } from './errors.ts';
import type { Provider, ProviderContext } from './provider.ts';
import type { Account } from './store.ts';
import type { Followup, Target } from './types.ts';

/**
 * The post's first comment, posted from the same account once a target is published (and public).
 * Exactly once per target: `sending` is saved right before the request, and a target that has any
 * followup is never picked again by itself. A failure is the comment's, never the post's.
 */

/** Warnings about the first comment on one platform: not supported there, past its limits, or what it costs. */
export function firstCommentWarnings(provider: Provider, text: string | undefined, options: Record<string, unknown> = {}, account?: Account): string[] {
  const t = text?.trim();
  if (!t) return [];
  if (!provider.postComment) return [msg('첫 댓글: {platform}에는 API로 댓글을 달 수 없어 건너뜁니다', { platform: provider.displayName })];
  const rule = provider.commentRules;
  if (!rule) return [];
  const out: string[] = [];
  const refusal = rule.refuses?.(options);
  if (refusal) return [refusal];
  const length = rule.length ? rule.length(t) : [...t].length;
  const max = rule.maxFor?.(account) ?? rule.max;
  if (length > max) out.push(msg('첫 댓글이 {platform} 한도({max}자)보다 깁니다 (지금 {length}자) — 댓글만 실패합니다', { platform: provider.displayName, max, length }));
  const hashtags = t.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
  if (rule.hashtags !== undefined && hashtags > rule.hashtags) out.push(msg('첫 댓글: {platform} 댓글은 해시태그 {max}개까지입니다 (지금 {n}개)', { platform: provider.displayName, max: rule.hashtags, n: hashtags }));
  const urls = t.match(/https?:\/\/\S+/g)?.length ?? 0;
  if (rule.urls !== undefined && urls > rule.urls) out.push(msg('첫 댓글: {platform} 댓글은 링크 {max}개까지입니다 (지금 {n}개)', { platform: provider.displayName, max: rule.urls, n: urls }));
  if (rule.cost) out.push(rule.cost);
  return out;
}

/** Look only at posts made in the last week: an old post gaining a comment out of nowhere would surprise. */
const FOLLOWUP_DAYS = 7;

/**
 * Post (or try) one target's first comment and save the outcome, if its followup is still
 * `expected` (claimed atomically first, so two processes never both send it). Undefined when
 * someone else got there first.
 */
export async function postFirstComment(ctx: ProviderContext, providers: Map<string, Provider>, target: Target, expected: Followup | undefined = target.followup): Promise<Followup | undefined> {
  const { store } = ctx;
  const now = () => ctx.now().toISOString();
  if (!store.claimFollowup(target.id, expected, { state: 'sending', at: now() })) return undefined;
  const save = (f: Followup) => (store.setFollowup(target.id, f), f);
  const text = store.getPost(target.postId)?.firstComment?.trim();
  const provider = providers.get(target.platform);
  if (!text) return save({ state: 'failed', at: now(), error: msg('첫 댓글 내용이 없습니다') });
  if (!provider?.postComment) return save({ state: 'unsupported', at: now() });
  if (!target.remoteId) return save({ state: 'failed', at: now(), error: msg('플랫폼의 게시물 id가 없어 댓글을 달 수 없습니다') });
  if (remoteIdUnknown(target)) return save({ state: 'failed', at: now(), error: remoteIdUnknownNote() });
  const posted = { ...target, remoteId: target.remoteId };
  let account = store.getAccount(target.platform, target.account);
  if (!account) return save({ state: 'failed', at: now(), error: msg('연결되지 않은 계정: {platform}/{account}', { platform: target.platform, account: target.account }) });
  let sent = false;
  try {
    // A token that expired since the upload is renewed first, as for any other call.
    account = await provider.refresh(ctx, account);
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
    // A clear refusal (permission, comments off, bad text) created nothing; a timeout, a 5xx or a
    // dropped connection after the request may have.
    const unclear = sent && !(err instanceof ProviderError && err.kind !== 'retryable');
    const f = save({ state: 'failed', at: now(), error, ...(unclear ? { maybePosted: true } : {}) });
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
  if (!f) throw new Error(msg('첫 댓글은 아직 차례를 기다리는 중입니다'));
  if (f.state === 'posted') throw new Error(msg('첫 댓글은 이미 달렸습니다'));
  if (f.state === 'canceled') throw new Error(msg('게시물을 지우는 중이거나 지워서 첫 댓글을 달지 않습니다'));
  if ((f.state === 'sending' || f.maybePosted) && !confirmedNotPosted) {
    throw Object.assign(new Error(msg('첫 댓글이 이미 달렸을 수 있습니다. 플랫폼에서 확인한 뒤 다시 시도하세요')), { needsConfirm: true });
  }
  // Only from the state just read: a second click (or another process) finds it claimed.
  const out = await postFirstComment(ctx, providers, target, f);
  if (!out) throw new Error(msg('첫 댓글을 이미 다른 곳에서 보내고 있습니다'));
  return out;
}
