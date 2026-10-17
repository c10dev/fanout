import type { ProviderContext } from './provider.ts';
import type { Post, Target, TargetState } from './types.ts';
import { msg } from './i18n.ts';

/**
 * Webhook notifications on state changes, so unattended runs (watch folder, worker) don't fail
 * silently. Slack and Discord incoming webhooks get their own payload shape; anything else gets
 * plain JSON.
 */
export interface NotifyConfig {
  url: string;
  events?: TargetState[];
  format?: 'slack' | 'discord' | 'json';
}

export const DEFAULT_EVENTS: readonly TargetState[] = ['published', 'handed_off', 'failed', 'needs_reauth'];
const TIMEOUT_MS = 5_000;
const pending = new Set<Promise<unknown>>();

export function detectFormat(url: string): NotifyConfig['format'] {
  const host = new URL(url).host;
  if (host === 'hooks.slack.com') return 'slack';
  if (/(^|\.)discord(app)?\.com$/.test(host) && url.includes('/api/webhooks/')) return 'discord';
  return 'json';
}

const ICON: Partial<Record<TargetState, string>> = { published: '✅', handed_off: '📲', failed: '❌', needs_reauth: '🔑', removed: '🗑️' };
const LABEL: Partial<Record<TargetState, string>> = {
  published: msg('게시됨'),
  handed_off: msg('앱에서 마무리 필요'),
  failed: msg('실패'),
  needs_reauth: msg('재연결 필요'),
  removed: msg('삭제됨'),
};

export function messageFor(post: Post | undefined, t: Target): string {
  const head = `${ICON[t.state] ?? '•'} ${t.platform}/${t.account} ${LABEL[t.state] ?? t.state}: "${post?.title ?? t.postId}"`;
  const tail = t.state === 'failed' || t.state === 'needs_reauth' ? `${t.errorCode ?? ''} ${t.errorMessage ?? ''}`.trim() : (t.remoteUrl ?? '');
  return tail ? `${head}\n${tail}` : head;
}

export function payloadFor(format: NotifyConfig['format'], text: string, post: Post | undefined, t: Target): unknown {
  if (format === 'slack') return { text };
  if (format === 'discord') return { content: text.slice(0, 2000) };
  return {
    event: 'target.state',
    state: t.state,
    platform: t.platform,
    account: t.account,
    postId: t.postId,
    targetId: t.id,
    title: post?.title,
    url: t.remoteUrl,
    error: t.errorCode ? { code: t.errorCode, message: t.errorMessage } : undefined,
    text,
  };
}

/** An https URL that `new URL()` accepts; anything else would break every notification later. */
export function validWebhookUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The webhook to use: FANOUT_WEBHOOK_URL overrides what `fanout notify set` saved. Invalid ones are ignored. */
export function notifyConfig(ctx: ProviderContext): NotifyConfig | undefined {
  const env = process.env.FANOUT_WEBHOOK_URL;
  if (env) return validWebhookUrl(env) ? { url: env } : undefined;
  const saved = ctx.store.getApp<NotifyConfig>('notify');
  return saved?.url && validWebhookUrl(saved.url) ? saved : undefined;
}

export async function send(ctx: ProviderContext, config: NotifyConfig, body: unknown): Promise<void> {
  const res = await ctx.fetch(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}

/** Send notifications for this context's state changes. Delivery is best effort and never blocks. */
export function attachNotifier(ctx: ProviderContext): void {
  ctx.store.onTransition((t) => {
    const config = notifyConfig(ctx);
    if (!config || !(config.events ?? DEFAULT_EVENTS).includes(t.state)) return;
    const post = ctx.store.getPost(t.postId);
    const format = config.format ?? detectFormat(config.url);
    const job = send(ctx, config, payloadFor(format, messageFor(post, t), post, t)).catch((err: unknown) =>
      ctx.log.warn(msg('알림 전송 실패: {err}', { err: err instanceof Error ? err.message : String(err) })),
    );
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
}

/** Let in-flight notifications finish before a short-lived command exits. */
export async function flushNotifications(timeoutMs = TIMEOUT_MS): Promise<void> {
  if (!pending.size) return;
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
}
