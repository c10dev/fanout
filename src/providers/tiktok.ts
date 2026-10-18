import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ProviderError, kindForStatus, type ErrorKind } from '../core/errors.ts';
import { jsonOr, openBrowser, pkcePair, readChunk, redirectParams, rotationContext, sleep, startLoopback, waitForRedirect } from '../core/http.ts';
import { makeTestClip } from '../core/media.ts';
import type { DoctorCheck, PollOutcome, Provider, ProviderContext, PublishOutcome } from '../core/provider.ts';
import type { Account } from '../core/store.ts';
import type { Issue, Post } from '../core/types.ts';
import { msg } from '../core/i18n.ts';

// Docs: https://developers.tiktok.com/doc/content-posting-api-get-started
//       https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
//       https://developers.tiktok.com/doc/content-sharing-guidelines

const API = 'https://open.tiktokapis.com/v2';
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const MB = 1024 * 1024;
const SINGLE_CHUNK_MAX = 64 * MB;
const CHUNK = 32 * MB;
const DEFAULT_SCOPES = 'user.info.basic,video.upload,video.publish';
const DEFAULT_REDIRECT = 'http://127.0.0.1:8723/callback';
const CAPTION_MAX = 2200;

export interface TikTokApp {
  clientKey: string;
  clientSecret: string;
  redirectUri?: string;
  scopes?: string;
}

export interface TikTokCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshExpiresAt: number;
  openId: string;
  scope: string;
}

export type PrivacyLevel = 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';

/**
 * `inbox`: the video lands in the creator's TikTok inbox and they finish posting in the app.
 * `direct`: posted immediately. Unaudited apps may only post SELF_ONLY to private accounts.
 *
 * The direct-mode fields mirror TikTok's mandatory posting UX: privacy has no default, and
 * comment/duet/stitch start disallowed until the creator opts in.
 */
export interface TikTokOptions {
  mode: 'inbox' | 'direct';
  caption?: string;
  privacyLevel?: PrivacyLevel;
  allowComment?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
  /** "Your brand": promoting the creator's own business. */
  brandOrganic?: boolean;
  /** "Branded content": paid partnership. Cannot be SELF_ONLY. */
  brandedContent?: boolean;
  /** Creator agreed to TikTok's Music Usage Confirmation. Required for direct posts. */
  musicConsent?: boolean;
  coverTimestampMs?: number;
}

interface TikTokEnvelope<T> {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string };
}

export interface CreatorInfo {
  creator_nickname?: string;
  creator_username?: string;
  privacy_level_options?: PrivacyLevel[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

const ERROR_KINDS: Record<string, ErrorKind> = {
  access_token_invalid: 'auth',
  scope_not_authorized: 'auth',
  scope_permission_missed: 'auth',
  rate_limit_exceeded: 'retryable',
  internal_error: 'retryable',
};

const ERROR_HINTS: Record<string, string> = {
  unaudited_client_can_only_post_to_private_accounts:
    msg('심사(audit)를 받지 않은 앱은 비공개 계정에 SELF_ONLY로만 게시할 수 있습니다. mode=inbox를 쓰거나 계정을 비공개로 바꾸세요.'),
  reached_active_user_cap: msg('미심사 앱은 24시간에 5명까지만 게시할 수 있습니다.'),
  spam_risk_too_many_posts: msg('이 계정의 하루 게시 한도(약 15건, 모든 앱 합산)에 걸렸습니다.'),
  spam_risk_user_banned_from_posting: msg('TikTok이 이 계정의 게시를 막았습니다.'),
  privacy_level_option_mismatch: msg('privacyLevel이 이 크리에이터가 허용하는 값이 아닙니다 (fanout doctor tiktok 참고).'),
  duration_exceeded: msg('이 크리에이터가 올릴 수 있는 최대 길이를 넘었습니다.'),
};

export function tiktokError(status: number, body: TikTokEnvelope<unknown> | undefined, now = new Date()): ProviderError {
  const code = body?.error?.code ?? `http_${status}`;
  const kind = ERROR_KINDS[code] ?? (status >= 400 ? kindForStatus(status) : 'rejected');
  const hint = ERROR_HINTS[code];
  // The account's daily cap (all apps together): try again in a few hours rather than fail.
  const retryAt = code === 'spam_risk_too_many_posts' ? new Date(now.getTime() + 3 * 3600_000) : undefined;
  return new ProviderError(kind, `tiktok.${code}`, `${body?.error?.message || code}${hint ? ` — ${hint}` : ''}`, code, { retryAt });
}

/**
 * JSON.parse that keeps integers too long for a double as their digits. TikTok sends post ids as
 * int64 numbers (`publicaly_available_post_id: [7412345678901234567]`); a plain parse rounds them to
 * a different, wrong id. Text inside strings is left alone.
 */
export function parseExactJson(text: string): unknown {
  const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text)?.[0] ?? ch;
      out += /^-?\d{16,}$/.test(m) && !Number.isSafeInteger(Number(m)) ? `"${m}"` : m;
      i += m.length - 1;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

/** Every TikTok response carries `error.code`; "ok" means success even on HTTP 200. */
async function call<T>(ctx: ProviderContext, account: Account, path: string, body: unknown): Promise<T> {
  const res = await ctx.fetch(`${API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${creds(account).accessToken}`, 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: TikTokEnvelope<T> | undefined;
  try {
    parsed = text ? (parseExactJson(text) as TikTokEnvelope<T>) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok || (parsed?.error?.code && parsed.error.code !== 'ok')) throw tiktokError(res.status, parsed, ctx.now());
  return parsed?.data as T;
}

function creds(account: Account): TikTokCredentials {
  return account.credentials as unknown as TikTokCredentials;
}

/** TikTok returns the granted scopes comma-separated. */
function hasScope(account: Account, scope: string): boolean {
  return (creds(account).scope ?? '').split(/[,\s]+/).includes(scope);
}

function app(ctx: ProviderContext): TikTokApp {
  const a = ctx.store.getApp<TikTokApp>('tiktok');
  if (!a?.clientKey || !a.clientSecret) {
    throw new ProviderError('auth', 'tiktok.app_missing', msg('TikTok 앱이 설정되지 않았습니다 — fanout setup tiktok 참고'));
  }
  return a;
}

/** Chunk plan per the media transfer guide: ≤64MB goes whole; otherwise 32MB chunks, remainder folded into the last. */
export function chunkPlan(size: number): { chunkSize: number; count: number; ranges: Array<[number, number]> } {
  if (size <= SINGLE_CHUNK_MAX) return { chunkSize: size, count: 1, ranges: [[0, size - 1]] };
  const count = Math.floor(size / CHUNK);
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const start = i * CHUNK;
    const end = i === count - 1 ? size - 1 : start + CHUNK - 1;
    ranges.push([start, end]);
  }
  return { chunkSize: CHUNK, count, ranges };
}

export function captionFor(post: Post, opts: TikTokOptions): string {
  if (opts.caption !== undefined) return opts.caption;
  const tags = post.tags.map((t) => `#${t.replace(/^#/, '').replace(/\s+/g, '')}`).join(' ');
  return [post.title, post.description, tags].filter((s) => s.trim()).join('\n\n');
}

async function tokenRequest(ctx: ProviderContext, params: Record<string, string>, previous?: TikTokCredentials): Promise<TikTokCredentials> {
  const res = await ctx.fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = (await jsonOr(res, {})) as Record<string, unknown>;
  if (!res.ok || body.error) {
    // Only a refused grant means reconnecting; a TikTok outage or rate limit is worth retrying.
    throw new ProviderError(
      res.status === 429 || res.status >= 500 ? 'retryable' : 'auth',
      'tiktok.token',
      msg('TikTok 토큰 오류: {body}', { body: (body.error_description as string) ?? (body.error as string) ?? res.status }),
      body.error as string | undefined,
    );
  }
  const now = ctx.now().getTime();
  return {
    accessToken: body.access_token as string,
    refreshToken: (body.refresh_token as string) ?? previous?.refreshToken ?? '',
    expiresAt: now + ((body.expires_in as number) ?? 86400) * 1000,
    refreshExpiresAt: now + ((body.refresh_expires_in as number) ?? 365 * 86400) * 1000,
    openId: (body.open_id as string) ?? previous?.openId ?? '',
    scope: (body.scope as string) ?? previous?.scope ?? '',
  };
}

async function creatorInfo(ctx: ProviderContext, account: Account): Promise<CreatorInfo> {
  return call<CreatorInfo>(ctx, account, '/post/publish/creator_info/query/', {});
}

/** The direct-post problems creator_info shows before anything is uploaded. */
export function creatorIssues(info: CreatorInfo, opts: TikTokOptions, durationSec: number): Issue[] {
  const issues: Issue[] = [];
  if (opts.mode !== 'direct') return issues;
  if (opts.privacyLevel && info.privacy_level_options && !info.privacy_level_options.includes(opts.privacyLevel)) {
    issues.push({ severity: 'error', code: 'privacy', message: msg('이 계정이 허용하는 공개 범위: {allowed} (요청: {privacyLevel})', { allowed: info.privacy_level_options.join(', '), privacyLevel: opts.privacyLevel }) });
  }
  const max = info.max_video_post_duration_sec;
  if (max !== undefined && durationSec > max) {
    issues.push({ severity: 'error', code: 'duration', message: msg('이 크리에이터의 최대 길이는 {max}초입니다 (영상 {length}초)', { max, length: durationSec.toFixed(0) }) });
  }
  const off = [info.comment_disabled && opts.allowComment && msg('댓글'), info.duet_disabled && opts.allowDuet && msg('듀엣'), info.stitch_disabled && opts.allowStitch && msg('이어찍기')].filter(Boolean);
  if (off.length) issues.push({ severity: 'warning', code: 'interactions', message: msg('계정 설정에서 꺼져 있어 적용되지 않습니다: {off}', { off: off.join(', ') }) });
  return issues;
}

async function init(
  ctx: ProviderContext,
  account: Account,
  post: Post,
  opts: TikTokOptions,
  plan: ReturnType<typeof chunkPlan>,
  size: number,
): Promise<{ publish_id: string; upload_url: string }> {
  const source_info = { source: 'FILE_UPLOAD', video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.count };
  if (opts.mode === 'inbox') {
    return call(ctx, account, '/post/publish/inbox/video/init/', { source_info });
  }
  return call(ctx, account, '/post/publish/video/init/', {
    post_info: {
      title: captionFor(post, opts),
      privacy_level: opts.privacyLevel,
      disable_comment: !opts.allowComment,
      disable_duet: !opts.allowDuet,
      disable_stitch: !opts.allowStitch,
      brand_content_toggle: Boolean(opts.brandedContent),
      brand_organic_toggle: Boolean(opts.brandOrganic),
      is_aigc: post.containsSyntheticMedia,
      ...(opts.coverTimestampMs !== undefined ? { video_cover_timestamp_ms: opts.coverTimestampMs } : {}),
    },
    source_info,
  });
}

async function upload(
  ctx: ProviderContext,
  uploadUrl: string,
  path: string,
  size: number,
  plan: ReturnType<typeof chunkPlan>,
  beforeLast: () => void = () => {},
): Promise<void> {
  for (const [i, [start, end]] of plan.ranges.entries()) {
    if (i === plan.ranges.length - 1) beforeLast();
    const chunk = await readChunk(path, start, end - start + 1);
    const res = await ctx.fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-length': String(chunk.length), 'content-range': `bytes ${start}-${end}/${size}` },
      body: chunk,
    });
    if (res.status !== 201 && res.status !== 206 && !res.ok) {
      throw new ProviderError(kindForStatus(res.status), `tiktok.upload_${res.status}`, msg('TikTok 청크 업로드 실패 HTTP {status}: {body}', { status: res.status, body: (await res.text()).slice(0, 200) }));
    }
    if (plan.count > 1) ctx.log.info(msg('tiktok: {end}% 업로드', { end: (((end + 1) / size) * 100).toFixed(0) }));
  }
}

interface StatusData {
  status?: 'PROCESSING_UPLOAD' | 'PROCESSING_DOWNLOAD' | 'SEND_TO_USER_INBOX' | 'PUBLISH_COMPLETE' | 'FAILED';
  fail_reason?: string;
  /** Spelling is TikTok's. */
  publicaly_available_post_id?: Array<number | string>;
}

export function statusOutcome(publishId: string, data: StatusData, username?: string): PollOutcome {
  switch (data.status) {
    case 'SEND_TO_USER_INBOX':
      return {
        state: 'handed_off',
        remoteId: publishId,
        warnings: [msg('TikTok 앱 알림(수신함)에서 캡션·공개 범위를 정하고 게시를 마무리하세요')],
      };
    case 'PUBLISH_COMPLETE': {
      const postId = data.publicaly_available_post_id?.[0];
      return {
        state: 'published',
        remoteId: postId ? String(postId) : publishId,
        remoteUrl: postId && username ? `https://www.tiktok.com/@${username}/video/${postId}` : undefined,
        warnings: postId ? [] : [msg('게시 완료됐지만 공개 게시물 ID가 없습니다 (SELF_ONLY이거나 검토 중)')],
      };
    }
    case 'FAILED':
      throw new ProviderError('rejected', `tiktok.${data.fail_reason ?? 'failed'}`, msg('TikTok 처리 실패: {reason}', { reason: data.fail_reason ?? 'unknown' }), data.fail_reason);
    default:
      return { state: 'processing', remoteId: publishId };
  }
}

async function fetchStatus(ctx: ProviderContext, account: Account, publishId: string): Promise<StatusData> {
  return call<StatusData>(ctx, account, '/post/publish/status/fetch/', { publish_id: publishId });
}

async function readCallback(ctx: ProviderContext, loopback: boolean, redirectUri: string): Promise<URLSearchParams> {
  if (loopback) {
    const port = Number(new URL(redirectUri).port);
    const loop = await startLoopback(port, new URL(redirectUri).pathname, new URL(redirectUri).hostname);
    try {
      return await waitForRedirect(loop.waitForCallback, (line) => ctx.log.info(line));
    } finally {
      loop.close();
    }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pasted = await rl.question(msg('리디렉트된 전체 URL을 붙여넣으세요: '));
    const params = redirectParams(pasted);
    if (!params) throw new ProviderError('auth', 'tiktok.paste', msg('code가 있는 리디렉트 URL이 아닙니다. 주소창의 전체 URL을 붙여넣으세요'));
    return params;
  } finally {
    rl.close();
  }
}

export const tiktok: Provider = {
  id: 'tiktok',
  displayName: 'TikTok',
  capabilities: { nativeSchedule: false, thumbnail: false, captions: false, syntheticMediaFlag: true },
  spec: {
    maxBytes: 4 * 1024 * MB,
    minDurationSec: 1,
    maxDurationSec: 600,
    containers: ['mp4', 'mov'],
    // TikTok lists H.265/VP8/VP9 too, but those uploads fail often enough that H.264 is the safe target.
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
    minFps: 23,
    maxFps: 60,
    minShortEdge: 360,
    maxLongEdge: 4096,
  },

  appFields: [
    { key: 'clientKey', label: 'Client key', secret: false },
    { key: 'clientSecret', label: 'Client secret', secret: true },
    { key: 'redirectUri', label: msg('Redirect URI (기본 {DEFAULT_REDIRECT})', { DEFAULT_REDIRECT }), secret: false, optional: true },
    { key: 'scopes', label: msg('Scopes (기본 {DEFAULT_SCOPES})', { DEFAULT_SCOPES }), secret: false, optional: true },
  ],

  setupGuide() {
    return msg(`TikTok — 내 TikTok 개발자 앱 만들기 (BYO)

TikTok 가이드라인은 client secret을 오픈소스에 넣는 것을 금지하므로 사용자마다 자기 앱을 만듭니다.

1. https://developers.tiktok.com/ 에서 앱 생성
2. Products에 Login Kit과 Content Posting API 추가
   - Content Posting API에서 "Upload"(수신함)는 기본, "Direct Post"는 켜야 direct 모드 사용 가능
3. Login Kit 플랫폼에 Desktop을 추가하고 Redirect URI {DEFAULT_REDIRECT} 등록
   (Desktop 플랫폼에서 loopback URI가 거부되면 내가 가진 HTTPS 주소를 등록하고
    redirectUri로 지정하세요. 그 경우 리디렉트된 URL을 터미널에 붙여넣는 방식으로 진행합니다)
4. Scopes: user.info.basic, video.upload, video.publish
   (반응 통계를 보려면 Display API를 추가하고 video.list도 — 그때는
    fanout app set tiktok --scopes user.info.basic,video.upload,video.publish,video.list)
5. fanout app set tiktok --clientKey <KEY> --clientSecret <SECRET> [--redirectUri <URI>]
6. fanout connect tiktok --name main
7. fanout doctor tiktok --live 로 미심사 상태에서 수신함 업로드가 되는지 확인

⚠ 심사(audit) 전 제약: Direct Post는 비공개 계정에 SELF_ONLY로만, 24시간에 5명까지.
   TikTok은 "자기/팀 계정용 유틸리티" 앱을 심사 대상에서 제외하므로 기본 모드는 inbox입니다.
   inbox 모드는 영상을 TikTok 앱 수신함으로 보내고, 캡션·공개 범위는 앱에서 직접 정합니다.`, { DEFAULT_REDIRECT });
  },

  connectMethod: 'oauth',

  async connect(ctx, name) {
    const redirectUri = app(ctx).redirectUri ?? DEFAULT_REDIRECT;
    const host = new URL(redirectUri).hostname;
    const start = tiktok.oauthBegin!(ctx, redirectUri);
    ctx.log.info(msg('브라우저에서 TikTok에 로그인하고 권한을 승인하세요:\n{url}', { url: start.url }));
    openBrowser(start.url);
    const params = await readCallback(ctx, host === '127.0.0.1' || host === 'localhost', redirectUri);
    if (params.get('state') !== start.state) throw new ProviderError('auth', 'tiktok.state', msg('OAuth state 불일치'));
    return tiktok.oauthFinish!(ctx, name, params, redirectUri, start.verifier);
  },

  // TikTok matches redirect_uri exactly against the URIs registered in the developer portal.
  oauthBegin(ctx, redirectUri) {
    const a = app(ctx);
    // TikTok's desktop PKCE uses a hex-encoded SHA-256 challenge.
    const { verifier, challenge } = pkcePair('hex');
    const state = crypto.randomUUID();
    const url = `${AUTH_URL}?${new URLSearchParams({
      client_key: a.clientKey,
      scope: a.scopes ?? DEFAULT_SCOPES,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })}`;
    return { url, state, verifier };
  },

  async oauthFinish(ctx, name, params, redirectUri, verifier) {
    const a = app(ctx);
    const code = params.get('code');
    if (!code) throw new ProviderError('auth', 'tiktok.denied', msg('인증 거부: {params}', { params: params.get('error_description') ?? params.get('error') ?? 'unknown' }));
    const credentials = await tokenRequest(ctx, {
      client_key: a.clientKey,
      client_secret: a.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const account: Account = { platform: 'tiktok', name, credentials: { ...credentials }, profile: {} };
    const me = await ctx
      .fetch(`${API}/user/info/?fields=open_id,display_name`, { headers: { authorization: `Bearer ${credentials.accessToken}` } })
      .then((r) => r.json() as Promise<TikTokEnvelope<{ user?: { display_name?: string } }>>)
      .catch(() => undefined);
    account.profile = { displayName: me?.data?.user?.display_name, openId: credentials.openId, scope: credentials.scope };
    return account;
  },

  async refresh(ctx, account) {
    const c = creds(account);
    const fresh = (x: TikTokCredentials) => x.expiresAt - ctx.now().getTime() > 120_000;
    if (fresh(c)) return account;
    // Another process may have refreshed already, possibly rotating the refresh token: use its pair.
    // (Only when it holds a different refresh token: doctor refreshes a stale copy on purpose to test it.)
    const stored = ctx.store.getAccount('tiktok', account.name);
    if (stored && creds(stored).refreshToken !== c.refreshToken && fresh(creds(stored))) return stored;
    const sc = stored ? creds(stored) : c;
    const a = app(ctx);
    try {
      const next: Account = {
        ...(stored ?? account),
        credentials: {
          ...(await tokenRequest(rotationContext(ctx), { client_key: a.clientKey, client_secret: a.clientSecret, grant_type: 'refresh_token', refresh_token: sc.refreshToken }, sc)),
        },
      };
      ctx.store.saveAccount(next);
      return next;
    } catch (err) {
      // Lost a race with another process that used the same refresh token and saved the new pair.
      const again = err instanceof ProviderError && err.kind === 'auth' ? ctx.store.getAccount('tiktok', account.name) : undefined;
      if (again && creds(again).refreshToken !== sc.refreshToken) return again;
      throw err;
    }
  },

  validate(post, target, media) {
    const issues: Issue[] = [];
    const o = target.options as Partial<TikTokOptions>;
    if (o.coverTimestampMs !== undefined && (!(o.coverTimestampMs >= 0) || o.coverTimestampMs > media.durationSec * 1000)) {
      issues.push({ severity: 'error', code: 'cover', message: msg('커버 장면은 0초~영상 길이({length}초) 사이여야 합니다', { length: media.durationSec.toFixed(1) }) });
    }
    if (o.mode !== 'inbox' && o.mode !== 'direct') {
      issues.push({ severity: 'error', code: 'mode', message: msg('TikTok mode는 inbox 또는 direct') });
      return issues;
    }
    if (o.mode === 'direct') {
      if (!o.privacyLevel) {
        issues.push({ severity: 'error', code: 'privacy', message: msg('TikTok direct 게시는 공개 범위(privacyLevel)를 직접 골라야 합니다 (기본값 없음)') });
      }
      if (o.musicConsent !== true) {
        issues.push({ severity: 'error', code: 'music_consent', message: msg("TikTok Music Usage Confirmation 동의(musicConsent)가 필요합니다") });
      }
      if (o.brandedContent && o.privacyLevel === 'SELF_ONLY') {
        issues.push({ severity: 'error', code: 'branded_private', message: msg('TikTok 브랜디드 콘텐츠는 SELF_ONLY로 게시할 수 없습니다') });
      }
      const caption = captionFor(post, o as TikTokOptions);
      // TikTok counts UTF-16 code units: an emoji is 2 (or more), as in JavaScript's length.
      if (caption.length > CAPTION_MAX) {
        issues.push({ severity: 'error', code: 'caption', message: msg('TikTok 캡션은 {CAPTION_MAX}자 이하 (현재 {length})', { CAPTION_MAX, length: caption.length }) });
      }
    } else {
      issues.push({ severity: 'warning', code: 'inbox', message: msg('TikTok inbox 모드: 업로드 후 TikTok 앱에서 직접 게시를 마무리해야 합니다') });
    }
    if (post.scheduledAt) {
      issues.push({ severity: 'warning', code: 'schedule', message: msg('TikTok은 API 예약 게시가 없어 fanout이 예약 시각에 업로드합니다 (fanout worker 필요)') });
    }
    return issues;
  },

  async publish({ ctx, post, target, account, mediaPath, media, saveResume }): Promise<PublishOutcome> {
    const opts = target.options as unknown as TikTokOptions;
    const resume = (target.resume ?? {}) as { publishId?: string; uploaded?: boolean; finalSent?: boolean; username?: string };
    // TikTok upload URLs expire within an hour and have no offset query, so an interrupted upload restarts —
    // unless the last chunk was already sent: then TikTok may have the whole file and be posting it,
    // and a fresh init would post twice. Let the status poll decide (FAILED → retry starts over).
    if (resume.publishId && (resume.uploaded || resume.finalSent)) return { state: 'processing', remoteId: resume.publishId };

    let username: string | undefined;
    if (opts.mode === 'direct') {
      const info = await creatorInfo(ctx, account);
      username = info.creator_username;
      if (opts.privacyLevel && info.privacy_level_options && !info.privacy_level_options.includes(opts.privacyLevel)) {
        throw new ProviderError(
          'rejected',
          'tiktok.privacy_level_option_mismatch',
          msg('이 계정이 허용하는 공개 범위: {allowed} (요청: {privacyLevel})', { allowed: info.privacy_level_options.join(', '), privacyLevel: opts.privacyLevel }),
        );
      }
      const max = info.max_video_post_duration_sec;
      if (max !== undefined) {
        if (media.durationSec > max) {
          throw new ProviderError('rejected', 'tiktok.duration_exceeded', msg('이 크리에이터의 최대 길이는 {max}초입니다 (영상 {length}초)', { max, length: media.durationSec.toFixed(0) }));
        }
      }
      if (info.comment_disabled && opts.allowComment) ctx.log.warn(msg('tiktok: 크리에이터 설정상 댓글이 꺼져 있어 allowComment가 무시됩니다'));
    }

    const size = statSync(mediaPath).size;
    const plan = chunkPlan(size);
    const { publish_id, upload_url } = await init(ctx, account, post, opts, plan, size);
    saveResume({ publishId: publish_id, uploaded: false, username });
    await upload(ctx, upload_url, mediaPath, size, plan, () => saveResume({ publishId: publish_id, uploaded: false, finalSent: true, username }));
    saveResume({ publishId: publish_id, uploaded: true, username });
    return { state: 'processing', remoteId: publish_id };
  },

  async poll({ ctx, target, account }): Promise<PollOutcome> {
    const resume = (target.resume ?? {}) as { username?: string };
    return statusOutcome(target.remoteId, await fetchStatus(ctx, account, target.remoteId), resume.username);
  },

  async accountRules({ ctx, account }) {
    const info = await creatorInfo(ctx, await tiktok.refresh(ctx, account));
    return {
      username: info.creator_username,
      nickname: info.creator_nickname,
      privacyOptions: info.privacy_level_options,
      disabled: [info.comment_disabled && 'allowComment', info.duet_disabled && 'allowDuet', info.stitch_disabled && 'allowStitch'].filter((x): x is string => Boolean(x)),
      maxDurationSec: info.max_video_post_duration_sec,
    };
  },

  async previewChecks({ ctx, account, target, media }) {
    const opts = target.options as unknown as TikTokOptions;
    if (opts.mode !== 'direct') return [];
    return creatorIssues(await creatorInfo(ctx, await tiktok.refresh(ctx, account)), opts, media.durationSec);
  },

  async doctor({ ctx, account, live }): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    try {
      app(ctx);
      checks.push({ name: msg('BYO 앱'), status: 'ok', detail: msg('client key 등록됨') });
    } catch (err) {
      checks.push({ name: msg('BYO 앱'), status: 'fail', detail: (err as Error).message });
      return checks;
    }
    let acct = account;
    try {
      acct = await tiktok.refresh(ctx, { ...account, credentials: { ...account.credentials, expiresAt: 0 } });
      checks.push({ name: msg('토큰 갱신'), status: 'ok', detail: `scope: ${creds(acct).scope}` });
    } catch (err) {
      checks.push({ name: msg('토큰 갱신'), status: 'fail', detail: (err as Error).message });
      return checks;
    }

    try {
      const info = await creatorInfo(ctx, acct);
      checks.push({
        name: 'creator_info',
        status: 'ok',
        detail: msg('@{username} ({nickname}), 허용 공개 범위: {privacy}, 최대 {max}초', { username: info.creator_username ?? '?', nickname: info.creator_nickname ?? '?', privacy: (info.privacy_level_options ?? []).join(', '), max: info.max_video_post_duration_sec ?? '?' }),
      });
      if (info.privacy_level_options && !info.privacy_level_options.includes('PUBLIC_TO_EVERYONE')) {
        checks.push({ name: msg('Direct Post 공개 게시'), status: 'warn', detail: msg('PUBLIC_TO_EVERYONE을 쓸 수 없습니다 — 미심사 앱이거나 비공개 계정입니다') });
      }
    } catch (err) {
      checks.push({ name: 'creator_info', status: 'warn', detail: msg('조회 실패 (video.publish scope 없음?): {err}', { err: (err as Error).message }) });
    }
    checks.push(
      hasScope(acct, 'video.list')
        ? { name: msg('반응 통계'), status: 'ok', detail: msg('video.list 권한 있음') }
        : { name: msg('반응 통계'), status: 'info', detail: msg('video.list 권한이 없어 조회·좋아요 통계를 못 가져옵니다 (원하면 앱 scopes에 더하고 다시 연결)') },
    );

    if (!live) {
      checks.push({ name: msg('미심사 앱 수신함 업로드'), status: 'info', detail: msg('확인하려면 --live 로 다시 실행 (테스트 영상을 TikTok 수신함으로 보냅니다)') });
      return checks;
    }

    // Open question from the research: does inbox upload work for an unaudited app, without the 5-user/private limits?
    const clip = join(tmpdir(), `fanout-doctor-${Date.now()}.mp4`);
    await makeTestClip(clip);
    const size = statSync(clip).size;
    const plan = chunkPlan(size);
    const post: Post = { id: 'doctor', createdAt: ctx.now().toISOString(), mediaPath: clip, title: '', description: '', tags: [], captions: [], containsSyntheticMedia: false };
    try {
      const { publish_id, upload_url } = await init(ctx, acct, post, { mode: 'inbox' }, plan, size);
      await upload(ctx, upload_url, clip, size, plan);
      let data: StatusData = {};
      for (let i = 0; i < 24 && (!data.status || data.status.startsWith('PROCESSING')); i++) {
        await sleep(5_000);
        data = await fetchStatus(ctx, acct, publish_id);
      }
      checks.push(
        data.status === 'SEND_TO_USER_INBOX' || data.status === 'PUBLISH_COMPLETE'
          ? { name: msg('미심사 앱 수신함 업로드'), status: 'ok', detail: msg('status={status}. 미심사 상태에서도 수신함 업로드가 동작합니다. TikTok 앱 알림의 테스트 영상은 게시하지 말고 지우세요.', { status: data.status }) }
          : { name: msg('미심사 앱 수신함 업로드'), status: 'fail', detail: `status=${data.status ?? 'unknown'} fail_reason=${data.fail_reason ?? '-'}` },
      );
    } catch (err) {
      const e = err as ProviderError;
      checks.push({ name: msg('미심사 앱 수신함 업로드'), status: 'fail', detail: `${e.platformCode ?? e.code}: ${e.message}` });
    }
    return checks;
  },

  // video.list scope (not in the default set: the app has to have it). Only the account's own videos.
  async stats({ ctx, account, target }) {
    if (!hasScope(account, 'video.list')) return { note: msg('TikTok 통계는 video.list 권한이 필요합니다 — 앱 scopes에 더하고 다시 연결하세요') };
    // Without a public post id (SELF_ONLY, or still under review) there is nothing to look up.
    if (!/^\d+$/.test(target.remoteId)) return { note: msg('공개 게시물 ID가 없어 통계를 가져올 수 없습니다') };
    const data = await call<{ videos?: Array<{ id?: string; view_count?: number; like_count?: number; comment_count?: number; share_count?: number }> }>(
      ctx,
      account,
      '/video/query/?fields=id,view_count,like_count,comment_count,share_count',
      { filters: { video_ids: [target.remoteId] } },
    );
    const v = data?.videos?.find((x) => String(x.id) === target.remoteId);
    if (!v) return { note: msg('게시물을 찾을 수 없습니다') };
    return { views: v.view_count, likes: v.like_count, comments: v.comment_count, shares: v.share_count };
  },
};
