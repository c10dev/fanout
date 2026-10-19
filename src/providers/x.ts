import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { ProviderError, kindForStatus } from '../core/errors.ts';
import { imageMime, jsonOr, openBrowser, pkcePair, readChunk, rotationContext, startLoopback, waitForRedirect } from '../core/http.ts';
import type { DoctorCheck, PollOutcome, Provider, ProviderContext, PublishOutcome } from '../core/provider.ts';
import type { Account } from '../core/store.ts';
import type { Issue, Post } from '../core/types.ts';
import { msg } from '../core/i18n.ts';

// Docs: https://docs.x.com/x-api/media/quickstart/media-upload-chunked (initialize → append →
//       finalize → STATUS → POST /2/tweets), https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
//       Alt text: POST /2/media/metadata. Subtitles: an SRT/VTT uploaded as media_category
//       'subtitles', then POST /2/media/subtitles (https://docs.x.com/x-api/media/create-media-subtitles).

const API = 'https://api.x.com';
const AUTH_URL = 'https://x.com/i/oauth2/authorize';
const SCOPES = 'tweet.read tweet.write users.read media.write offline.access';
const DEFAULT_REDIRECT = 'http://127.0.0.1:8724/callback';
/** The guide recommends ≤5MB segments (server max 8MB). */
export const SEGMENT = 4 * 1024 * 1024;
const TEXT_MAX = 280;
const ALT_TEXT_MAX = 1000;
const SUBTITLE_TYPES: Record<string, string> = { '.srt': 'text/srt', '.vtt': 'text/vtt' };

export interface XApp {
  clientId: string;
  /** Only for confidential clients; public (native) clients have none. */
  clientSecret?: string;
  redirectUri?: string;
}

export interface XCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  username: string;
  /** X Premium tier of the account ("None", "Basic", "Premium", "PremiumPlus"); decides long posts. */
  subscriptionType?: string;
}

export interface XOptions {
  text?: string;
  /** Disclose a paid partnership on the post. */
  paidPartnership?: boolean;
  /** Who can reply; everyone when unset. */
  replySettings?: 'following' | 'mentionedUsers' | 'subscribers' | 'verified';
  /** A description of the video for screen readers (up to 1000 characters). */
  alt?: string;
  /** People tagged in the video, by username (up to 10; looked up once, a billed read). */
  tagUsers?: string[];
  /** Post into this Community (its numeric id) instead of to the timeline alone. */
  communityId?: string;
}

const TAG_MAX = 10;
const X_USERNAME = /^[A-Za-z0-9_]{1,15}$/;

function tagNames(o: XOptions): string[] {
  const raw = o.tagUsers as unknown;
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : [];
  return list.map((u) => u.trim().replace(/^@/, '')).filter(Boolean);
}

/** What poll() keeps between status checks on its way to the post. */
interface XResume {
  mediaId?: string;
  tweetId?: string;
  posting?: boolean;
  /** Alt text and subtitle tracks already attempted (each is sent at most once). */
  extras?: string[];
  /** Their failures, shown once the post is up. */
  extraWarnings?: string[];
  /** The post's thumbnail, uploaded as an image to be the video's preview. */
  previewMediaId?: string;
  /** Tagged people's user ids, once looked up. */
  taggedIds?: string[];
}

const REPLY_SETTINGS = ['following', 'mentionedUsers', 'subscribers', 'verified'];

interface MediaData {
  id: string;
  processing_info?: { state: 'pending' | 'in_progress' | 'succeeded' | 'failed'; check_after_secs?: number; error?: { message?: string; name?: string } };
}

function app(ctx: ProviderContext): XApp {
  const a = ctx.store.getApp<XApp>('x');
  if (!a?.clientId) throw new ProviderError('auth', 'x.app_missing', msg('X 앱이 설정되지 않았습니다 — fanout setup x 참고'));
  return a;
}

function creds(account: Account): XCredentials {
  return account.credentials as unknown as XCredentials;
}

/** Links as X counts them: with a scheme, or a bare domain on a common TLD (x.ai, fanout.dev/docs). */
const URL_RE =
  /(?:https?:\/\/\S+)|(?:\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|co|kr|me|tv|ly|gg|xyz|info|biz|edu|gov|jp|uk|de|fr|so|to|sh|page|link|site|blog|news|shop|store|art)\b(?:\/[^\s]*)?)/gi;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function hasUrl(text: string): boolean {
  return new RegExp(URL_RE.source, 'i').test(text);
}

/**
 * X's weighted length (twitter-text v3): each URL counts 23; an emoji (even a multi-code-point
 * sequence like 👨‍👩‍👧 or ❤️) counts 2; otherwise Latin and common punctuation count 1 and
 * everything else — Hangul, CJK — counts 2.
 */
export function weightedLength(text: string): number {
  let n = 0;
  const rest = text.replace(URL_RE, () => {
    n += 23;
    return '';
  });
  for (const { segment } of graphemeSegmenter.segment(rest)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) {
      n += 2;
      continue;
    }
    for (const ch of segment) {
      const cp = ch.codePointAt(0)!;
      const light = (cp >= 0 && cp <= 4351) || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
      n += light ? 1 : 2;
    }
  }
  return n;
}

/** The POST /2/tweets body: text, the video, and the disclosures and reply setting asked for. */
export function xPostBody(post: Post, opts: XOptions, mediaId: string, previewMediaId?: string, taggedIds?: string[]): Record<string, unknown> {
  return {
    text: tweetText(post, opts),
    media: { media_ids: [mediaId], ...(previewMediaId ? { preview_media_id: previewMediaId } : {}), ...(taggedIds?.length ? { tagged_user_ids: taggedIds } : {}) },
    ...(post.containsSyntheticMedia ? { made_with_ai: true } : {}),
    ...(opts.paidPartnership ? { paid_partnership: true } : {}),
    ...(opts.replySettings ? { reply_settings: opts.replySettings } : {}),
    ...(opts.communityId ? { community_id: String(opts.communityId) } : {}),
  };
}

export function tweetText(post: Post, opts: XOptions): string {
  if (opts.text !== undefined) return opts.text;
  const tags = post.tags.map((t) => `#${t.replace(/^#/, '').replace(/\s+/g, '')}`).join(' ');
  const full = [post.title, post.description, tags].filter((s) => s.trim()).join('\n\n');
  return weightedLength(full) <= TEXT_MAX ? full : [post.title, tags].filter((s) => s.trim()).join('\n\n');
}

/** X takes a two-letter upper-case code (pattern ^[A-Z]{2}$): ko → KO, en-US → EN. */
export function subtitleLanguage(language: string): string | undefined {
  const code = language.split(/[-_]/)[0]!.toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : undefined;
}

async function tokenRequest(ctx: ProviderContext, params: Record<string, string>, previous?: XCredentials): Promise<Omit<XCredentials, 'userId' | 'username'>> {
  const a = app(ctx);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  // Confidential clients authenticate with Basic; public clients send client_id in the body.
  if (a.clientSecret) headers.authorization = `Basic ${Buffer.from(`${a.clientId}:${a.clientSecret}`).toString('base64')}`;
  else body.set('client_id', a.clientId);
  const res = await ctx.fetch(`${API}/2/oauth2/token`, { method: 'POST', headers, body });
  const data = (await jsonOr(res, {})) as Record<string, unknown>;
  if (!res.ok || !data.access_token) {
    throw new ProviderError(res.status === 429 || res.status >= 500 ? 'retryable' : 'auth', 'x.token', msg('X 토큰 오류: {error}', { error: (data.error_description as string) ?? (data.error as string) ?? res.status }), data.error as string | undefined);
  }
  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string) ?? previous?.refreshToken ?? '',
    expiresAt: ctx.now().getTime() + ((data.expires_in as number) ?? 7200) * 1000,
  };
}

async function api<T>(ctx: ProviderContext, account: Account, path: string, init: RequestInit = {}): Promise<T> {
  const res = await ctx.fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${creds(account).accessToken}`, ...(init.headers as Record<string, string>) } });
  const body = (await jsonOr(res, {})) as T & { detail?: string; title?: string; errors?: Array<{ message?: string; detail?: string }> };
  if (!res.ok) {
    const detail = body.detail ?? body.errors?.[0]?.message ?? body.errors?.[0]?.detail ?? body.title ?? `HTTP ${res.status}`;
    const kind = res.status === 402 ? 'rejected' : kindForStatus(res.status);
    // One whole message per case, so it reads back as one in English.
    const message = res.status === 402 ? msg('X: {detail} — X API 크레딧(종량제)이 부족합니다', { detail }) : `X: ${detail}`;
    throw new ProviderError(kind, `x.http_${res.status}`, message, String(res.status));
  }
  return body;
}

/**
 * Alt text and subtitle tracks, once the video has processed and before the post goes out. Each is
 * tried at most once (a retry would duplicate a track), and a failure only becomes a warning: the
 * post still goes out without it. Signing-in trouble stops here like anywhere else.
 */
async function applyExtras(
  ctx: ProviderContext,
  account: Account,
  post: Post,
  opts: XOptions,
  mediaId: string,
  start: XResume,
  save: (resume: XResume) => void,
): Promise<XResume> {
  let resume = start;
  /**
   * `send` calls `commit()` just before the request that attaches something for good. Until then a
   * passing failure is safe to retry later; after it, a failure might have attached anyway, so it
   * only becomes a warning. A crash in between leaves an "unsure" warning rather than nothing.
   */
  const attempt = async (key: string, label: string, send: (commit: () => void) => Promise<unknown>) => {
    if (resume.extras?.includes(key)) return;
    const unsure = msg('{label}: 보냈는지 확인하지 못했습니다 — 게시물에서 확인하세요', { label });
    const finish = (extras: string[], warning?: string) => {
      resume = { ...resume, extras, extraWarnings: [...(resume.extraWarnings ?? []).filter((w) => w !== unsure), ...(warning ? [warning] : [])] };
      save(resume);
    };
    const others = (resume.extras ?? []).filter((k) => k !== key);
    let committed = false;
    const commit = () => {
      committed = true;
      resume = { ...resume, extras: [...others, key], extraWarnings: [...(resume.extraWarnings ?? []), unsure] };
      save(resume);
    };
    try {
      await send(commit);
      finish([...others, key]);
    } catch (err) {
      const kind = err instanceof ProviderError ? err.kind : undefined;
      // Refused before anything was attached (sign-in), or a passing failure before the point of no
      // return: leave it to the next status check.
      if (kind === 'auth' || (kind === 'retryable' && !committed)) {
        finish(others);
        throw err;
      }
      finish([...others, key], msg('{label} 실패: {err}', { label, err: (err as Error).message }));
    }
  };
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  if (opts.alt?.trim()) {
    const text = opts.alt.trim();
    // Setting metadata replaces it, so this one is always safe to send again: no commit.
    await attempt('alt_text', msg('X 대체 텍스트'), () => api(ctx, account, '/2/media/metadata', json({ id: mediaId, metadata: { alt_text: { text } } })));
  }
  if (post.thumbnailPath && existsSync(post.thumbnailPath)) {
    const path = post.thumbnailPath;
    // An image nobody uses costs nothing, so this one needs no commit either.
    await attempt('preview', msg('X 썸네일'), async () => {
      const file = readFileSync(path);
      const init = await api<{ data: { id: string } }>(ctx, account, '/2/media/upload/initialize', json({ media_type: imageMime(path), total_bytes: file.length, media_category: 'tweet_image' }));
      const form = new FormData();
      form.set('segment_index', '0');
      form.set('media', new Blob([new Uint8Array(file)]), 'preview');
      await api(ctx, account, `/2/media/upload/${init.data.id}/append`, { method: 'POST', body: form });
      await api(ctx, account, `/2/media/upload/${init.data.id}/finalize`, { method: 'POST' });
      resume = { ...resume, previewMediaId: init.data.id };
    });
  }
  const seen = new Set<string>();
  for (const cap of post.captions) {
    const type = SUBTITLE_TYPES[extname(cap.path).toLowerCase()];
    const language = subtitleLanguage(cap.language);
    // validate() already said why: not SRT/VTT, not a two-letter code, or a second track in a language.
    if (!type || !language || seen.has(language)) continue;
    seen.add(language);
    await attempt(`subtitles:${language}`, msg('X 자막({language})', { language: cap.language }), async (commit) => {
      const file = readFileSync(cap.path);
      if (file.length > SEGMENT) throw new Error(msg('자막 파일이 너무 큽니다 ({size} 바이트)', { size: file.length }));
      const init = await api<{ data: { id: string } }>(ctx, account, '/2/media/upload/initialize', json({ media_type: type, total_bytes: file.length, media_category: 'subtitles' }));
      const subId = init.data.id;
      const form = new FormData();
      form.set('segment_index', '0');
      form.set('media', new Blob([new Uint8Array(file)]), 'subtitles');
      await api(ctx, account, `/2/media/upload/${subId}/append`, { method: 'POST', body: form });
      await api(ctx, account, `/2/media/upload/${subId}/finalize`, { method: 'POST' });
      const displayName = cap.name ?? new Intl.DisplayNames(['en'], { type: 'language' }).of(language.toLowerCase()) ?? language;
      // Attaching twice would add a second track.
      commit();
      await api(ctx, account, '/2/media/subtitles', json({ id: mediaId, media_category: 'TweetVideo', subtitles: { id: subId, language_code: language, display_name: displayName } }));
    });
  }
  return resume;
}

export const x: Provider = {
  id: 'x',
  displayName: 'X (Twitter)',
  capabilities: { nativeSchedule: false, thumbnail: true, captions: true, syntheticMediaFlag: true },
  spec: {
    // Default per-user caps; Premium accounts get more (125 min / 16GB) and X re-checks on post.
    maxBytes: 8 * 1024 ** 3,
    maxDurationSec: 20 * 60,
    containers: ['mp4', 'mov'],
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
    maxFps: 60,
  },
  appFields: [
    { key: 'clientId', label: 'OAuth 2.0 Client ID', secret: false },
    { key: 'clientSecret', label: msg('Client Secret (confidential 앱일 때만)'), secret: true, optional: true },
    { key: 'redirectUri', label: msg('CLI용 Redirect URI (기본 {DEFAULT_REDIRECT})', { DEFAULT_REDIRECT }), secret: false, optional: true },
  ],
  connectMethod: 'oauth',

  setupGuide() {
    return msg(`X — 내 X 개발자 앱 만들기 (BYO, 유료)

X API는 종량제입니다(게시 1건 약 $0.015, URL이 들어가면 약 $0.20 — 2026년 기준). 크레딧을 먼저 충전하세요.

1. https://console.x.com/ 에서 앱 생성
2. User authentication settings: OAuth 2.0 켜기, 앱 유형 "Native App"(public) 또는 "Web App"(confidential)
   권한: Read and write
3. Callback URI에 둘 다 등록:
     대시보드: http://127.0.0.1:8780/oauth/x/callback
     CLI:      {DEFAULT_REDIRECT}
4. fanout app set x --clientId <ID> [--clientSecret <SECRET>]
5. fanout connect x --name main   (또는 대시보드 설정 탭)
6. fanout doctor x

요청 범위: {SCOPES}`, { DEFAULT_REDIRECT, SCOPES });
  },

  async connect(ctx, name) {
    const redirectUri = app(ctx).redirectUri ?? DEFAULT_REDIRECT;
    const u = new URL(redirectUri);
    const loop = await startLoopback(Number(u.port), u.pathname, u.hostname);
    try {
      const start = x.oauthBegin!(ctx, redirectUri);
      ctx.log.info(msg('브라우저에서 X에 로그인하고 권한을 승인하세요:\n{url}', { url: start.url }));
      openBrowser(start.url);
      const params = await waitForRedirect(loop.waitForCallback, (line) => ctx.log.info(line));
      if (params.get('state') !== start.state) throw new ProviderError('auth', 'x.state', msg('OAuth state 불일치'));
      return await x.oauthFinish!(ctx, name, params, redirectUri, start.verifier);
    } finally {
      loop.close();
    }
  },

  oauthBegin(ctx, redirectUri) {
    const { clientId } = app(ctx);
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomUUID();
    const url = `${AUTH_URL}?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })}`;
    return { url, state, verifier };
  },

  async oauthFinish(ctx, name, params, redirectUri, verifier) {
    const code = params.get('code');
    if (!code) throw new ProviderError('auth', 'x.denied', msg('인증 거부: {params}', { params: params.get('error_description') ?? params.get('error') ?? 'unknown' }));
    const tok = await tokenRequest(ctx, { code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: verifier });
    const account: Account = { platform: 'x', name, credentials: { ...tok, userId: '', username: '' }, profile: {} };
    const me = await api<{ data: { id: string; username: string; name: string; subscription_type?: string } }>(ctx, account, '/2/users/me?user.fields=subscription_type');
    account.credentials = { ...tok, userId: me.data.id, username: me.data.username, subscriptionType: me.data.subscription_type };
    account.profile = { username: me.data.username, displayName: me.data.name };
    return account;
  },

  async refresh(ctx, account) {
    const c = creds(account);
    if (c.expiresAt - ctx.now().getTime() > 120_000) return account;
    if (!c.refreshToken) throw new ProviderError('auth', 'x.no_refresh', msg('X 토큰이 만료됐습니다 — 다시 연결하세요'));
    // Another process may have refreshed already (X refresh tokens are single-use): take its pair.
    const stored = ctx.store.getAccount('x', account.name);
    const sc = stored ? creds(stored) : c;
    if (stored && sc.refreshToken !== c.refreshToken && sc.expiresAt - ctx.now().getTime() > 120_000) return stored;
    try {
      const tok = await tokenRequest(rotationContext(ctx), { grant_type: 'refresh_token', refresh_token: sc.refreshToken }, sc);
      const next: Account = { ...(stored ?? account), credentials: { ...sc, ...tok } };
      // Only over the grant just spent: the account may have been disconnected meanwhile, and a
      // plain save would bring it back with live tokens (and its scheduled posts with it).
      ctx.store.saveAccountIf(next, (s) => creds(s).refreshToken === sc.refreshToken);
      return next;
    } catch (err) {
      // Lost a race: someone else used the token first and saved the new pair.
      const again = err instanceof ProviderError && err.kind === 'auth' ? ctx.store.getAccount('x', account.name) : undefined;
      if (again && creds(again).refreshToken !== sc.refreshToken) return again;
      throw err;
    }
  },

  validate(post, target, _media, account) {
    const issues: Issue[] = [];
    const text = tweetText(post, target.options as XOptions);
    const len = weightedLength(text);
    if (len > TEXT_MAX) {
      // Long posts need a Premium tier. Known to be without one: stop here, before the upload is paid for.
      const tier = account ? creds(account).subscriptionType : undefined;
      if (tier === 'None') {
        issues.push({ severity: 'error', code: 'text', message: msg('X 글이 {len}(가중치) / {TEXT_MAX}입니다. 이 계정은 X Premium이 아니라 거부됩니다 — options.text로 줄이세요 (Premium으로 바꿨다면 fanout doctor x로 다시 확인)', { len, TEXT_MAX }) });
      } else if (tier === undefined) {
        issues.push({ severity: 'warning', code: 'text', message: msg('X 글이 {len}(가중치) / {TEXT_MAX}입니다. Premium이 아니면 거부됩니다 — options.text로 줄이세요', { len, TEXT_MAX }) });
      }
    }
    const community = (target.options as XOptions).communityId;
    // A number past 2^53 has already lost digits (an agent sending JSON numbers): it would name another Community.
    if (typeof community === 'number') issues.push({ severity: 'error', code: 'community', message: msg('X 커뮤니티 ID는 문자열("123…")로 보내세요 — 긴 숫자는 끝자리가 바뀝니다') });
    else if (community !== undefined && !/^\d{1,19}$/.test(String(community))) issues.push({ severity: 'error', code: 'community', message: msg('X 커뮤니티는 숫자 ID로 적으세요 (커뮤니티 주소의 마지막 숫자)') });
    const tags = tagNames(target.options as XOptions);
    if (tags.length > TAG_MAX) issues.push({ severity: 'error', code: 'tag_users', message: msg('X 사람 태그는 {max}명까지', { max: TAG_MAX }) });
    const badTags = tags.filter((u) => !X_USERNAME.test(u));
    if (badTags.length) issues.push({ severity: 'error', code: 'tag_users', message: msg('X 사용자 이름이 아닙니다: {names}', { names: badTags.join(', ') }) });
    if (tags.length) issues.push({ severity: 'warning', code: 'tag_users', message: msg('X 사람 태그는 사용자 조회(요금 발생) 한 번이 더 듭니다') });
    const reply = (target.options as XOptions).replySettings;
    if (reply !== undefined && !REPLY_SETTINGS.includes(reply)) {
      issues.push({ severity: 'error', code: 'reply_settings', message: msg('replySettings는 {values} 중 하나', { values: REPLY_SETTINGS.join(', ') }) });
    }
    if (hasUrl(text)) issues.push({ severity: 'warning', code: 'url_cost', message: msg('X는 URL이 들어간 게시물 요금이 훨씬 비쌉니다(약 $0.20)') });
    if (post.scheduledAt) issues.push({ severity: 'warning', code: 'schedule', message: msg('X는 API 예약 게시가 없어 fanout이 예약 시각에 올립니다 (fanout worker 필요)') });
    const alt = (target.options as XOptions).alt;
    if (alt !== undefined && (typeof alt !== 'string' || [...alt].length > ALT_TEXT_MAX)) {
      issues.push({ severity: 'error', code: 'alt_text', message: msg('alt는 {max}자 이하 문자열', { max: ALT_TEXT_MAX }) });
    }
    if (post.thumbnailPath) issues.push({ severity: 'warning', code: 'extras', message: msg('X 썸네일(preview_media_id)은 아직 실제로 확인 전입니다 — X가 받지 않으면 썸네일 없이 올립니다') });
    const tracks = new Set<string>();
    for (const cap of post.captions) {
      const code = subtitleLanguage(cap.language);
      if (!SUBTITLE_TYPES[extname(cap.path).toLowerCase()]) issues.push({ severity: 'warning', code: 'subtitles', message: msg('X 자막은 SRT·VTT만 받습니다 — {language} 자막은 빠집니다', { language: cap.language }) });
      else if (!code) issues.push({ severity: 'warning', code: 'subtitles', message: msg('X 자막 언어는 두 글자 코드만 됩니다 — {language} 자막은 빠집니다', { language: cap.language }) });
      else if (tracks.has(code)) issues.push({ severity: 'warning', code: 'subtitles', message: msg('X는 언어마다 자막 하나만 받습니다 ({code}) — {language} 자막은 빠집니다', { code, language: cap.language }) });
      else tracks.add(code);
    }
    return issues;
  },

  async publish({ ctx, target, account, mediaPath, saveResume }): Promise<PublishOutcome> {
    const resume = (target.resume ?? {}) as { mediaId?: string; segment?: number; finalized?: boolean; tweetId?: string; posting?: boolean; expiresAt?: number };
    if (resume.tweetId) return { state: 'published', remoteId: resume.tweetId, remoteUrl: `https://x.com/${creds(account).username}/status/${resume.tweetId}` };
    if (resume.finalized && resume.mediaId) return { state: 'processing', remoteId: resume.mediaId };

    const size = statSync(mediaPath).size;
    let mediaId = resume.mediaId;
    let segment = resume.segment ?? 0;
    let expiresAt = resume.expiresAt;
    // Upload sessions expire (expires_after_secs, 24h): don't keep appending to a dead one.
    if (mediaId && expiresAt !== undefined && ctx.now().getTime() > expiresAt - 10 * 60_000) {
      ctx.log.info(msg('x: 이전 업로드 세션이 만료돼 처음부터 올립니다'));
      mediaId = undefined;
    }
    const initialize = async () => {
      const init = await api<{ data: { id: string; expires_after_secs?: number } }>(ctx, account, '/2/media/upload/initialize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ media_type: 'video/mp4', total_bytes: size, media_category: 'tweet_video' }),
      });
      mediaId = init.data.id;
      segment = 0;
      expiresAt = ctx.now().getTime() + (init.data.expires_after_secs ?? 86_400) * 1000;
      saveResume({ mediaId, segment, expiresAt });
    };
    const resumed = Boolean(mediaId);
    if (!mediaId) await initialize();
    else if (segment > 0) ctx.log.info(msg('x: {segment}번째 조각부터 이어 올립니다', { segment }));

    // Access tokens last 2 hours; a long upload can outlive one. Refresh once on 401 and carry on.
    let acct = account;
    const call = async <T>(path: string, init: RequestInit): Promise<T> => {
      try {
        return await api<T>(ctx, acct, path, init);
      } catch (err) {
        if (!(err instanceof ProviderError) || err.code !== 'x.http_401') throw err;
        acct = await x.refresh(ctx, { ...acct, credentials: { ...acct.credentials, expiresAt: 0 } });
        return api<T>(ctx, acct, path, init);
      }
    };

    const sendAll = async () => {
      // Segments are idempotent by index, so resuming from the last saved index is safe.
      for (let offset = segment * SEGMENT; offset < size; offset += SEGMENT, segment++) {
        const chunk = await readChunk(mediaPath, offset, Math.min(SEGMENT, size - offset));
        const form = new FormData();
        form.set('segment_index', String(segment));
        form.set('media', new Blob([new Uint8Array(chunk)]), 'chunk');
        await call(`/2/media/upload/${mediaId}/append`, { method: 'POST', body: form });
        saveResume({ mediaId, segment: segment + 1, expiresAt });
      }
      await call<{ data: MediaData }>(`/2/media/upload/${mediaId}/finalize`, { method: 'POST' });
    };
    try {
      await sendAll();
    } catch (err) {
      // A resumed session X no longer accepts (expired, unknown id) gets one fresh start.
      if (!resumed || !(err instanceof ProviderError) || err.kind !== 'rejected') throw err;
      ctx.log.info(msg('x: 이어 올리던 세션을 받지 않아 처음부터 올립니다 ({message})', { message: err.message }));
      await initialize();
      await sendAll();
    }
    saveResume({ mediaId, segment, finalized: true, expiresAt });
    return { state: 'processing', remoteId: mediaId! };
  },

  async poll({ ctx, post, target, account }): Promise<PollOutcome> {
    let resume = (target.resume ?? {}) as XResume;
    const username = creds(account).username;
    if (resume.tweetId) return { state: 'published', remoteId: resume.tweetId, remoteUrl: `https://x.com/${username}/status/${resume.tweetId}`, warnings: resume.extraWarnings?.length ? resume.extraWarnings : undefined };
    const mediaId = resume.mediaId ?? target.remoteId;

    const status = await api<{ data: MediaData }>(ctx, account, `/2/media/upload?${new URLSearchParams({ command: 'STATUS', media_id: mediaId })}`);
    const state = status.data.processing_info?.state;
    if (state === 'failed') {
      const e = status.data.processing_info?.error;
      throw new ProviderError('rejected', 'x.processing_failed', msg('X 영상 처리 실패: {reason}', { reason: e?.message ?? e?.name ?? 'unknown' }), e?.name);
    }
    if (state === 'pending' || state === 'in_progress') return { state: 'processing', remoteId: mediaId };
    if (!resume.posting) resume = await applyExtras(ctx, account, post, target.options as XOptions, mediaId, resume, (next) => ctx.store.updateTarget(target.id, { resume: { ...next } }));
    // Tagged people: usernames to ids, once (a billed read). Who can't be found is left out and said.
    const names = tagNames(target.options as XOptions);
    if (names.length && !resume.posting && resume.taggedIds === undefined) {
      let ids: string[] = [];
      const notes: string[] = [];
      try {
        const found = await api<{ data?: Array<{ id: string; username: string }> }>(ctx, account, `/2/users/by?${new URLSearchParams({ usernames: names.join(',') })}`);
        const byName = new Map((found.data ?? []).map((u) => [u.username.toLowerCase(), u.id]));
        ids = names.map((n) => byName.get(n.toLowerCase())).filter((id): id is string => Boolean(id));
        const missing = names.filter((n) => !byName.has(n.toLowerCase()));
        if (missing.length) notes.push(msg('X에서 찾지 못해 태그하지 않았습니다: {names}', { names: missing.join(', ') }));
      } catch (err) {
        // Nothing is posted yet: sign-in trouble or a passing failure waits for the next status check.
        if (err instanceof ProviderError && (err.kind === 'auth' || err.kind === 'retryable')) throw err;
        notes.push(msg('X 사람 태그를 하지 못했습니다: {err}', { err: (err as Error).message }));
      }
      resume = { ...resume, taggedIds: ids, extraWarnings: [...(resume.extraWarnings ?? []), ...notes] };
      ctx.store.updateTarget(target.id, { resume: { ...resume } });
    }

    // X has no idempotency key for posts. If a previous attempt may already have posted, stop
    // and let the user check instead of risking a duplicate.
    if (resume.posting) {
      throw new ProviderError('rejected', 'x.maybe_posted', msg('이전 시도에서 이미 게시됐을 수 있습니다. https://x.com/{username} 에서 확인한 뒤, 없으면 다시 시도하세요', { username }), undefined, { keepResume: true });
    }
    ctx.store.updateTarget(target.id, { resume: { ...resume, posting: true } });
    const send = (preview?: string) =>
      api<{ data: { id: string } }>(ctx, account, '/2/tweets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(xPostBody(post, target.options as XOptions, mediaId, preview, resume.taggedIds)),
      });
    const tweet = await send(resume.previewMediaId)
      .catch(async (err: unknown) => {
        // A refused preview image mustn't cost the post: a clear rejection posted nothing, so once more without it.
        if (!resume.previewMediaId || !(err instanceof ProviderError) || err.kind !== 'rejected' || err.code !== 'x.http_400') throw err;
        resume = { ...resume, extraWarnings: [...(resume.extraWarnings ?? []), msg('X가 썸네일을 받지 않아 빼고 올렸습니다: {err}', { err: err.message })] };
        return send();
      })
      .catch((err: unknown) => {
        // A clear rejection means nothing was posted, so a later retry is safe.
        if (err instanceof ProviderError && err.kind !== 'retryable') ctx.store.updateTarget(target.id, { resume: { ...resume, posting: false } });
        throw err;
      });
    ctx.store.updateTarget(target.id, { resume: { ...resume, posting: false, tweetId: tweet.data.id } });
    return { state: 'published', remoteId: tweet.data.id, remoteUrl: `https://x.com/${username}/status/${tweet.data.id}`, warnings: resume.extraWarnings?.length ? resume.extraWarnings : undefined };
  },

  async doctor({ ctx, account }): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    try {
      app(ctx);
      checks.push({ name: msg('BYO 앱'), status: 'ok', detail: msg('client id 등록됨') });
    } catch (err) {
      checks.push({ name: msg('BYO 앱'), status: 'fail', detail: (err as Error).message });
      return checks;
    }
    let acct = account;
    try {
      acct = await x.refresh(ctx, { ...account, credentials: { ...account.credentials, expiresAt: 0 } });
      checks.push({ name: msg('토큰 갱신'), status: 'ok', detail: msg('refresh token 유효') });
    } catch (err) {
      checks.push({ name: msg('토큰 갱신'), status: 'fail', detail: (err as Error).message });
      return checks;
    }
    try {
      const me = await api<{ data: { username: string; subscription_type?: string } }>(ctx, acct, '/2/users/me?user.fields=subscription_type');
      checks.push({ name: msg('계정'), status: 'ok', detail: `@${me.data.username}` });
      const tier = me.data.subscription_type;
      if (tier !== undefined) {
        checks.push({ name: 'X Premium', status: 'info', detail: tier === 'None' ? msg('없음 (글은 280 가중치까지)') : tier });
        // Kept for validate(): a long post on a non-Premium account is stopped before the upload.
        const stored = ctx.store.getAccount('x', acct.name);
        if (stored) ctx.store.saveAccount({ ...stored, credentials: { ...stored.credentials, subscriptionType: tier } });
      }
    } catch (err) {
      checks.push({ name: msg('계정'), status: 'fail', detail: (err as Error).message });
    }
    checks.push({ name: msg('요금'), status: 'info', detail: msg('X API는 종량제입니다. 게시마다 크레딧이 차감됩니다(console.x.com에서 잔액 확인)') });
    return checks;
  },

  statsCost: msg('X API는 읽기도 요금이 듭니다'),
  async stats({ ctx, account, target }) {
    const res = await api<{ data?: { public_metrics?: { impression_count?: number; like_count?: number; reply_count?: number; retweet_count?: number; quote_count?: number } } }>(
      ctx,
      account,
      `/2/tweets/${target.remoteId}?tweet.fields=public_metrics`,
    );
    const m = res.data?.public_metrics;
    if (!m) return { note: msg('게시물을 찾을 수 없습니다') };
    return { views: m.impression_count, likes: m.like_count, comments: m.reply_count, shares: (m.retweet_count ?? 0) + (m.quote_count ?? 0) };
  },

  firstCommentIsPost: true,

  // The first comment is a reply to the video post: one more paid write.
  commentRules: {
    max: TEXT_MAX,
    length: weightedLength,
    // Long posts (replies too) need a Premium tier; with one, X's own limit applies.
    maxFor: (account) => {
      const tier = account ? creds(account).subscriptionType : undefined;
      return tier && tier !== 'None' ? 25_000 : undefined;
    },
    cost: msg('X: 첫 댓글은 답글 게시물로 올라가 게시물 하나만큼 요금이 더 듭니다'),
  },

  async postComment({ ctx, account, target, text, sending }) {
    const username = creds(account).username;
    sending();
    const res = await api<{ data: { id: string } }>(ctx, account, '/2/tweets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: target.remoteId } }),
    });
    return { id: res.data.id, url: `https://x.com/${username}/status/${res.data.id}` };
  },

  async remove({ ctx, account, target }) {
    try {
      await api(ctx, account, `/2/tweets/${target.remoteId}`, { method: 'DELETE' });
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'x.http_404') return;
      throw err;
    }
  },
};
