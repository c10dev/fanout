import { createHash } from 'node:crypto';
import { openAsBlob, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ProviderError, kindForStatus } from '../core/errors.ts';
import { imageMime } from '../core/http.ts';
import { liveRoundTrip } from '../core/livecheck.ts';
import type { DoctorCheck, PollOutcome, Provider, ProviderContext, PublishOutcome } from '../core/provider.ts';
import type { Account } from '../core/store.ts';
import type { Issue, Post } from '../core/types.ts';

// Docs: https://docs.joinmastodon.org/methods/media/ (POST /api/v2/media, async processing),
//       https://docs.joinmastodon.org/methods/statuses/ (Idempotency-Key, scheduled_at),
//       https://docs.joinmastodon.org/methods/instance/#v2 (configuration limits).

const DEFAULT_MAX_CHARS = 500;
/** Mastodon's default video_size_limit; instances may differ and are checked at upload time. */
const DEFAULT_VIDEO_BYTES = 99 * 1024 * 1024;
/** scheduled_at must be at least 5 minutes in the future. */
const SCHEDULE_MIN_MS = 5 * 60_000;
/** Mastodon remembers Idempotency-Key for about an hour; stay well inside it. */
const IDEMPOTENCY_WINDOW_MS = 50 * 60_000;

export interface MastodonCredentials {
  instance: string;
  token: string;
}

export interface MastodonOptions {
  visibility: 'public' | 'unlisted' | 'private';
  text?: string;
  alt?: string;
  language?: string;
  /** Content warning; marks the media sensitive. */
  spoilerText?: string;
}

interface InstanceConfig {
  configuration?: {
    statuses?: { max_characters?: number };
    media_attachments?: { video_size_limit?: number; video_frame_rate_limit?: number; video_matrix_limit?: number };
  };
}

function creds(account: Account): MastodonCredentials {
  return account.credentials as unknown as MastodonCredentials;
}

/**
 * Refuse to change a post through a connection that isn't the one that made it: an account name
 * reconnected to another instance or another user would otherwise act on (or misjudge) the wrong
 * status. Posts made before the publisher was recorded fall back to the status URL's host.
 */
function assertPublisher(account: Account, target: { resume?: Record<string, unknown>; remoteUrl?: string }): void {
  const c = creds(account);
  const r = (target.resume ?? {}) as { instance?: string; accountId?: string };
  let instance = r.instance;
  if (!instance && target.remoteUrl) {
    try {
      instance = new URL(target.remoteUrl).origin;
    } catch {
      instance = undefined;
    }
  }
  const who = account.profile.username ?? account.name;
  if (instance && instance !== c.instance) {
    throw new ProviderError('rejected', 'mastodon.other_instance', `이 글은 ${instance} 에 올렸는데 지금 ${account.name} 계정은 ${c.instance} 에 연결돼 있습니다`);
  }
  const accountId = account.profile.accountId as string | undefined;
  if (r.accountId && accountId && r.accountId !== accountId) {
    throw new ProviderError('rejected', 'mastodon.not_owner', `이 글은 지금 연결된 계정(${who})이 올린 글이 아닙니다`);
  }
}

type Visibility = 'public' | 'unlisted' | 'private' | 'direct';
const VISIBILITY_ORDER: Visibility[] = ['public', 'unlisted', 'private', 'direct'];

// A scheduled post's id is a ScheduledStatus id; the status it becomes gets a new id we never learn.
const SCHEDULED_NOTE = '예약해 둔 글은 게시된 뒤의 글 번호를 알 수 없어 반응·댓글을 가져올 수 없습니다';

function isScheduled(target: { resume?: Record<string, unknown> }): boolean {
  return Boolean((target.resume as { scheduled?: boolean } | undefined)?.scheduled);
}

export function normalizeInstance(raw: string): string {
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new ProviderError('rejected', 'mastodon.insecure', '인스턴스 주소는 https여야 합니다');
  }
  return url.origin;
}

async function api<T>(
  ctx: ProviderContext,
  c: MastodonCredentials,
  path: string,
  init: RequestInit & { allow?: number[] } = {},
): Promise<{ status: number; body: T }> {
  const res = await ctx.fetch(`${c.instance}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${c.token}`, ...(init.headers as Record<string, string>) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok && !(init.allow ?? []).includes(res.status)) {
    const msg = body.error ?? `HTTP ${res.status}`;
    throw new ProviderError(kindForStatus(res.status), `mastodon.http_${res.status}`, `Mastodon: ${msg}`, String(res.status));
  }
  return { status: res.status, body };
}

/** Status text: title, description, hashtags; the description goes first if it doesn't fit. */
/** Mastodon returns status bodies as HTML; good enough plain text for a comment list. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

export function statusText(post: Post, opts: Partial<MastodonOptions>, maxChars = DEFAULT_MAX_CHARS): string {
  if (opts.text !== undefined) return opts.text;
  const tags = post.tags.map((t) => `#${t.replace(/^#/, '').replace(/\s+/g, '')}`).join(' ');
  const full = [post.title, post.description, tags].filter((s) => s.trim()).join('\n\n');
  return [...full].length <= maxChars ? full : [post.title, tags].filter((s) => s.trim()).join('\n\n');
}

async function instanceConfig(ctx: ProviderContext, c: MastodonCredentials): Promise<InstanceConfig> {
  return (await api<InstanceConfig>(ctx, c, '/api/v2/instance')).body;
}

export const mastodon: Provider = {
  id: 'mastodon',
  displayName: 'Mastodon',
  capabilities: { nativeSchedule: true, thumbnail: true, captions: false, syntheticMediaFlag: false },
  spec: {
    maxBytes: DEFAULT_VIDEO_BYTES,
    containers: ['mp4', 'mov'],
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
    maxFps: 120,
  },
  appFields: [],
  connectMethod: 'token',
  connectFields: [
    { key: 'instance', label: '인스턴스 주소 (예: mastodon.social)', secret: false },
    { key: 'token', label: '액세스 토큰', secret: true },
  ],

  setupGuide() {
    return `Mastodon — 인스턴스에서 액세스 토큰 만들기 (개발자 앱 등록·심사 없음)

1. 내 인스턴스 → 환경설정 → 개발 → 새 애플리케이션
2. 이름: fanout, 권한: read:accounts, write:media, write:statuses 만 체크
3. 저장 후 "액세스 토큰"을 복사
4. fanout connect mastodon --name main --instance mastodon.social --token <토큰>
   또는 대시보드 설정 탭의 Mastodon 칸
5. fanout doctor mastodon 으로 인스턴스의 영상 크기·글자 수 한도를 확인
   fanout doctor mastodon --live 는 나만 보이는(direct) 테스트 글을 실제로 올렸다가 지웁니다

공개 범위(visibility)는 매번 직접 고릅니다: public, unlisted(조용히 공개), private(팔로워만).`;
  },

  async connect(ctx, name, flags) {
    let instance = typeof flags.instance === 'string' ? flags.instance.trim() : '';
    let token = typeof flags.token === 'string' ? flags.token.trim() : '';
    if (!instance || !token) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if (!instance) instance = (await rl.question('인스턴스 주소: ')).trim();
        if (!token) token = (await rl.question('액세스 토큰: ')).trim();
      } finally {
        rl.close();
      }
    }
    const c: MastodonCredentials = { instance: normalizeInstance(instance), token };
    const { body: me } = await api<{ id: string; acct: string; username: string; url: string }>(ctx, c, '/api/v1/accounts/verify_credentials');
    const host = new URL(c.instance).host;
    return { platform: 'mastodon', name, credentials: { ...c }, profile: { username: `${me.username}@${host}`, accountId: me.id, url: me.url } };
  },

  // Mastodon app tokens don't expire; a revoked one surfaces as 401.
  refresh: async (_ctx, account) => account,

  validate(post, target) {
    const issues: Issue[] = [];
    const o = target.options as Partial<MastodonOptions>;
    if (!o.visibility || !['public', 'unlisted', 'private'].includes(o.visibility)) {
      issues.push({ severity: 'error', code: 'visibility', message: 'Mastodon 공개 범위(public/unlisted/private)를 직접 지정해야 합니다' });
    }
    const text = statusText(post, o);
    if ([...text].length > DEFAULT_MAX_CHARS) {
      issues.push({ severity: 'warning', code: 'text', message: `Mastodon 글이 ${[...text].length}자입니다. 기본 한도 ${DEFAULT_MAX_CHARS}자를 넘으면 인스턴스에 따라 거부됩니다` });
    }
    if (post.scheduledAt && new Date(post.scheduledAt).getTime() - Date.now() < SCHEDULE_MIN_MS) {
      // Mastodon refuses schedules under 5 minutes away; post right away instead of failing forever.
      issues.push({ severity: 'warning', code: 'schedule', message: 'Mastodon 예약은 5분 뒤부터 가능해, 예약 시각이 가까우면 바로 게시합니다' });
    }
    if (post.captions.length) issues.push({ severity: 'warning', code: 'captions', message: 'Mastodon은 자막 파일을 받지 않아 무시됩니다' });
    return issues;
  },

  async publish({ ctx, post, target, account, mediaPath, saveResume }): Promise<PublishOutcome> {
    const c = creds(account);
    const resume = (target.resume ?? {}) as { mediaId?: string; statusId?: string; statusUrl?: string };
    if (resume.statusId) return { state: 'published', remoteId: resume.statusId, remoteUrl: resume.statusUrl };
    if (resume.mediaId) return { state: 'processing', remoteId: resume.mediaId };

    const limit = (await instanceConfig(ctx, c).catch(() => ({}) as InstanceConfig)).configuration?.media_attachments?.video_size_limit;
    const size = statSync(mediaPath).size;
    if (limit && size > limit) {
      throw new ProviderError('rejected', 'mastodon.too_large', `이 인스턴스의 영상 한도는 ${(limit / 1024 / 1024).toFixed(0)}MB입니다 (파일 ${(size / 1024 / 1024).toFixed(0)}MB)`);
    }
    const o = target.options as unknown as MastodonOptions;
    const form = new FormData();
    form.set('file', await openAsBlob(mediaPath, { type: 'video/mp4' }), basename(mediaPath));
    if (o.alt) form.set('description', o.alt);
    if (post.thumbnailPath) form.set('thumbnail', await openAsBlob(post.thumbnailPath, { type: imageMime(post.thumbnailPath) }), basename(post.thumbnailPath));
    const { body } = await api<{ id: string }>(ctx, c, '/api/v2/media', { method: 'POST', body: form });
    saveResume({ mediaId: body.id });
    return { state: 'processing', remoteId: body.id };
  },

  async poll({ ctx, post, target, account }): Promise<PollOutcome> {
    const c = creds(account);
    const resume = (target.resume ?? {}) as { mediaId?: string; statusId?: string; statusUrl?: string; posting?: boolean; postingAt?: string };
    if (resume.statusId) return { state: 'published', remoteId: resume.statusId, remoteUrl: resume.statusUrl };
    const mediaId = resume.mediaId ?? target.remoteId;

    if (resume.posting) {
      // An earlier status POST may have gone through. GET /media 404s once media is attached, so don't
      // look there: re-send with the same Idempotency-Key, which the server dedupes for about an hour.
      const since = resume.postingAt ? ctx.now().getTime() - Date.parse(resume.postingAt) : Infinity;
      if (since > IDEMPOTENCY_WINDOW_MS) {
        throw new ProviderError(
          'rejected',
          'mastodon.maybe_posted',
          `이전 시도에서 이미 게시됐을 수 있습니다. ${c.instance} 에서 확인한 뒤, 없으면 다시 시도하세요`,
          undefined,
          { keepResume: true },
        );
      }
    } else {
      // 206 Partial Content while the server is still transcoding. 404 once the media is attached to a
      // status — i.e. an earlier attempt already posted it.
      const media = await api<{ id: string; url: string | null }>(ctx, c, `/api/v1/media/${mediaId}`, { allow: [206] }).catch((err: unknown) => {
        if (err instanceof ProviderError && err.code === 'mastodon.http_404' && resume.postingAt) {
          throw new ProviderError('rejected', 'mastodon.media_attached', `영상이 이미 게시물에 붙어 있습니다. ${c.instance} 에서 게시물을 확인하세요`, undefined, { keepResume: true });
        }
        throw err;
      });
      if (media.status === 206 || !media.body.url) return { state: 'processing', remoteId: mediaId };
    }

    const o = target.options as unknown as MastodonOptions;
    const payload: Record<string, unknown> = {
      status: statusText(post, o),
      media_ids: [mediaId],
      visibility: o.visibility,
      ...(o.language ? { language: o.language } : {}),
      ...(o.spoilerText ? { spoiler_text: o.spoilerText, sensitive: true } : {}),
    };
    const warnings: string[] = [];
    if (post.scheduledAt) {
      if (Date.parse(post.scheduledAt) - ctx.now().getTime() >= SCHEDULE_MIN_MS) payload.scheduled_at = new Date(post.scheduledAt).toISOString();
      else warnings.push('예약 시각이 5분 안으로 다가와 바로 게시했습니다');
    }
    const postingAt = resume.posting && resume.postingAt ? resume.postingAt : ctx.now().toISOString();
    ctx.store.updateTarget(target.id, { resume: { ...resume, posting: true, postingAt } });
    // The server dedupes on Idempotency-Key, so a retry after a lost response can't post twice.
    const { body } = await api<{ id: string; url?: string; scheduled_at?: string }>(ctx, c, '/api/v1/statuses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `fanout-${target.id}` },
      body: JSON.stringify(payload),
    }).catch((err: unknown) => {
      // A clear refusal means nothing was posted; anything else may have gone through.
      if (err instanceof ProviderError && err.kind === 'rejected') ctx.store.updateTarget(target.id, { resume: { ...resume, posting: false } });
      throw err;
    });
    // With scheduled_at the server returns a ScheduledStatus: its id is not a status id until it fires.
    ctx.store.updateTarget(target.id, {
      resume: {
        ...resume,
        posting: false,
        statusId: body.id,
        statusUrl: body.url,
        instance: c.instance,
        accountId: account.profile.accountId,
        ...(body.scheduled_at ? { scheduled: true } : {}),
      },
    });
    if (body.scheduled_at) warnings.push(`예약 게시: ${body.scheduled_at}`);
    return { state: 'published', remoteId: body.id, remoteUrl: body.url, warnings };
  },

  async doctor({ ctx, account, live }): Promise<DoctorCheck[]> {
    const c = creds(account);
    const checks: DoctorCheck[] = [];
    try {
      const { body: me } = await api<{ acct: string }>(ctx, c, '/api/v1/accounts/verify_credentials');
      checks.push({ name: '계정', status: 'ok', detail: `@${me.acct} (${c.instance})` });
    } catch (err) {
      checks.push({ name: '계정', status: 'fail', detail: (err as Error).message });
      return checks;
    }
    try {
      const cfg = (await instanceConfig(ctx, c)).configuration;
      const m = cfg?.media_attachments;
      checks.push({
        name: '인스턴스 한도',
        status: 'info',
        detail: `영상 ${m?.video_size_limit ? `${(m.video_size_limit / 1024 / 1024).toFixed(0)}MB` : '?'}, ${m?.video_frame_rate_limit ?? '?'}fps, 글 ${cfg?.statuses?.max_characters ?? '?'}자`,
      });
    } catch (err) {
      checks.push({ name: '인스턴스 한도', status: 'warn', detail: (err as Error).message });
    }
    // "direct" with nobody mentioned: a status only this account can see.
    if (live) checks.push(...(await liveRoundTrip(ctx, mastodon, account, { options: { visibility: 'direct' } })));
    else checks.push({ name: '실제 게시 점검', status: 'info', detail: '확인하려면 --live 로 다시 실행 (나만 보이는 테스트 글을 올리고 지웁니다)' });
    return checks;
  },

  async stats({ ctx, account, target }) {
    if (isScheduled(target)) return { note: SCHEDULED_NOTE };
    const { body } = await api<{ favourites_count?: number; replies_count?: number; reblogs_count?: number }>(ctx, creds(account), `/api/v1/statuses/${target.remoteId}`);
    return { likes: body.favourites_count, comments: body.replies_count, shares: body.reblogs_count, note: 'Mastodon은 조회수를 제공하지 않습니다' };
  },

  async remove({ ctx, account, target }) {
    const c = creds(account);
    assertPublisher(account, target);
    if (isScheduled(target)) {
      // Still waiting: cancel the scheduled status. Once it has fired the live post has a new id we
      // don't know, so say so instead of pretending it's gone.
      try {
        await api(ctx, c, `/api/v1/scheduled_statuses/${target.remoteId}`, { method: 'DELETE' });
        return;
      } catch (err) {
        if (err instanceof ProviderError && err.code === 'mastodon.http_404') {
          throw new ProviderError('rejected', 'mastodon.scheduled_fired', `예약 시각이 지나 이미 게시됐을 수 있습니다. ${c.instance} 에서 직접 지워 주세요`);
        }
        throw err;
      }
    }
    try {
      await api(ctx, c, `/api/v1/statuses/${target.remoteId}`, { method: 'DELETE' });
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code !== 'mastodon.http_404') throw err;
      // 404 also means "not yours" (e.g. the account was reconnected as someone else): only call it
      // gone if the status really doesn't exist any more.
      // Only a 404 here too proves it's gone; a timeout or 5xx proves nothing.
      const still = await api(ctx, c, `/api/v1/statuses/${target.remoteId}`).then(
        () => true,
        (e: unknown) => {
          if (e instanceof ProviderError && e.code === 'mastodon.http_404') return false;
          throw e;
        },
      );
      if (still) throw new ProviderError('rejected', 'mastodon.not_owner', `이 게시물은 지금 연결된 계정(${account.profile.username ?? account.name})의 것이 아니라 지울 수 없습니다`);
    }
  },

  // Editing must list the media to keep, or the video would be dropped from the post.
  async update({ ctx, account, target, post }) {
    assertPublisher(account, target);
    if (isScheduled(target)) {
      throw new ProviderError('rejected', 'mastodon.scheduled', '예약된 글은 API로 내용을 고칠 수 없습니다. 지우고 다시 예약하세요');
    }
    const resume = (target.resume ?? {}) as { mediaId?: string };
    const o = target.options as unknown as MastodonOptions;
    await api(ctx, creds(account), `/api/v1/statuses/${target.remoteId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: statusText(post, o),
        ...(resume.mediaId ? { media_ids: [resume.mediaId] } : {}),
        ...(o.language ? { language: o.language } : {}),
        ...(o.spoilerText ? { spoiler_text: o.spoilerText, sensitive: true } : {}),
      }),
    });
  },

  async comments({ ctx, account, target, limit }) {
    if (isScheduled(target)) throw new ProviderError('rejected', 'mastodon.scheduled', SCHEDULED_NOTE);
    type Status = { id: string; in_reply_to_id?: string | null; content: string; created_at: string; url?: string; favourites_count?: number; replies_count?: number; account: { acct: string; display_name?: string } };
    const { body } = await api<{ descendants?: Status[] }>(ctx, creds(account), `/api/v1/statuses/${target.remoteId}/context`);
    return (body.descendants ?? [])
      .filter((s) => s.in_reply_to_id === target.remoteId)
      .map((s) => ({
        id: s.id,
        author: s.account.display_name ? `${s.account.display_name} (@${s.account.acct})` : `@${s.account.acct}`,
        text: htmlToText(s.content),
        at: s.created_at,
        likes: s.favourites_count,
        replies: s.replies_count,
        url: s.url,
      }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  },

  async reply({ ctx, account, target, comment, text, sending }) {
    assertPublisher(account, target);
    if (isScheduled(target)) throw new ProviderError('rejected', 'mastodon.scheduled', SCHEDULED_NOTE);
    const c = creds(account);
    type Status = { id: string; visibility: Visibility; account: { id: string; acct: string } };
    const { body: parent } = await api<Status>(ctx, c, `/api/v1/statuses/${comment.id}`);
    // Mastodon notifies people it mentions, not people it replies to: mention them as the web UI does.
    const mention = parent.account.id === account.profile.accountId ? '' : `@${parent.account.acct}`;
    const status = !mention || text.includes(mention) ? text : `${mention} ${text}`;
    // Never more public than the comment or the post itself, like the web UI.
    const own = (target.options as Partial<MastodonOptions>).visibility ?? 'public';
    const visibility = VISIBILITY_ORDER[Math.max(VISIBILITY_ORDER.indexOf(parent.visibility), VISIBILITY_ORDER.indexOf(own))] ?? 'unlisted';
    const key = createHash('sha256').update(`${target.id}\n${comment.id}\n${status}`).digest('hex').slice(0, 32);
    sending();
    const { body } = await api<{ id: string; url?: string }>(ctx, c, '/api/v1/statuses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `fanout-reply-${key}` },
      body: JSON.stringify({ status, in_reply_to_id: parent.id, visibility }),
    });
    return { id: body.id, url: body.url };
  },
};
