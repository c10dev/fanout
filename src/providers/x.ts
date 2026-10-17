import { statSync } from 'node:fs';
import { ProviderError, kindForStatus } from '../core/errors.ts';
import { openBrowser, pkcePair, readChunk, startLoopback } from '../core/http.ts';
import type { DoctorCheck, PollOutcome, Provider, ProviderContext, PublishOutcome } from '../core/provider.ts';
import type { Account } from '../core/store.ts';
import type { Issue, Post } from '../core/types.ts';

// Docs: https://docs.x.com/x-api/media/quickstart/media-upload-chunked (initialize → append →
//       finalize → STATUS → POST /2/tweets), https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code

const API = 'https://api.x.com';
const AUTH_URL = 'https://x.com/i/oauth2/authorize';
const SCOPES = 'tweet.read tweet.write users.read media.write offline.access';
const DEFAULT_REDIRECT = 'http://127.0.0.1:8724/callback';
/** The guide recommends ≤5MB segments (server max 8MB). */
export const SEGMENT = 4 * 1024 * 1024;
const TEXT_MAX = 280;

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
}

export interface XOptions {
  text?: string;
}

interface MediaData {
  id: string;
  processing_info?: { state: 'pending' | 'in_progress' | 'succeeded' | 'failed'; check_after_secs?: number; error?: { message?: string; name?: string } };
}

function app(ctx: ProviderContext): XApp {
  const a = ctx.store.getApp<XApp>('x');
  if (!a?.clientId) throw new ProviderError('auth', 'x.app_missing', 'X 앱이 설정되지 않았습니다 — fanout setup x 참고');
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

export function tweetText(post: Post, opts: XOptions): string {
  if (opts.text !== undefined) return opts.text;
  const tags = post.tags.map((t) => `#${t.replace(/^#/, '').replace(/\s+/g, '')}`).join(' ');
  const full = [post.title, post.description, tags].filter((s) => s.trim()).join('\n\n');
  return weightedLength(full) <= TEXT_MAX ? full : [post.title, tags].filter((s) => s.trim()).join('\n\n');
}

async function tokenRequest(ctx: ProviderContext, params: Record<string, string>, previous?: XCredentials): Promise<Omit<XCredentials, 'userId' | 'username'>> {
  const a = app(ctx);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  // Confidential clients authenticate with Basic; public clients send client_id in the body.
  if (a.clientSecret) headers.authorization = `Basic ${Buffer.from(`${a.clientId}:${a.clientSecret}`).toString('base64')}`;
  else body.set('client_id', a.clientId);
  const res = await ctx.fetch(`${API}/2/oauth2/token`, { method: 'POST', headers, body });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !data.access_token) {
    throw new ProviderError(res.status === 429 || res.status >= 500 ? 'retryable' : 'auth', 'x.token', `X 토큰 오류: ${(data.error_description as string) ?? (data.error as string) ?? res.status}`, data.error as string | undefined);
  }
  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string) ?? previous?.refreshToken ?? '',
    expiresAt: ctx.now().getTime() + ((data.expires_in as number) ?? 7200) * 1000,
  };
}

async function api<T>(ctx: ProviderContext, account: Account, path: string, init: RequestInit = {}): Promise<T> {
  const res = await ctx.fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${creds(account).accessToken}`, ...(init.headers as Record<string, string>) } });
  const body = (await res.json().catch(() => ({}))) as T & { detail?: string; title?: string; errors?: Array<{ message?: string; detail?: string }> };
  if (!res.ok) {
    const detail = body.detail ?? body.errors?.[0]?.message ?? body.errors?.[0]?.detail ?? body.title ?? `HTTP ${res.status}`;
    const kind = res.status === 402 ? 'rejected' : kindForStatus(res.status);
    const hint = res.status === 402 ? ' — X API 크레딧(종량제)이 부족합니다' : '';
    throw new ProviderError(kind, `x.http_${res.status}`, `X: ${detail}${hint}`, String(res.status));
  }
  return body;
}

export const x: Provider = {
  id: 'x',
  displayName: 'X (Twitter)',
  capabilities: { nativeSchedule: false, thumbnail: false, captions: false, syntheticMediaFlag: false },
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
    { key: 'clientSecret', label: 'Client Secret (confidential 앱일 때만)', secret: true, optional: true },
    { key: 'redirectUri', label: `CLI용 Redirect URI (기본 ${DEFAULT_REDIRECT})`, secret: false, optional: true },
  ],
  connectMethod: 'oauth',

  setupGuide() {
    return `X — 내 X 개발자 앱 만들기 (BYO, 유료)

X API는 종량제입니다(게시 1건 약 $0.015, URL이 들어가면 약 $0.20 — 2026년 기준). 크레딧을 먼저 충전하세요.

1. https://console.x.com/ 에서 앱 생성
2. User authentication settings: OAuth 2.0 켜기, 앱 유형 "Native App"(public) 또는 "Web App"(confidential)
   권한: Read and write
3. Callback URI에 둘 다 등록:
     대시보드: http://127.0.0.1:8780/oauth/x/callback
     CLI:      ${DEFAULT_REDIRECT}
4. fanout app set x --clientId <ID> [--clientSecret <SECRET>]
5. fanout connect x --name main   (또는 대시보드 설정 탭)
6. fanout doctor x

요청 범위: ${SCOPES}`;
  },

  async connect(ctx, name) {
    const redirectUri = app(ctx).redirectUri ?? DEFAULT_REDIRECT;
    const u = new URL(redirectUri);
    const loop = await startLoopback(Number(u.port), u.pathname, u.hostname);
    try {
      const start = x.oauthBegin!(ctx, redirectUri);
      ctx.log.info(`브라우저에서 X에 로그인하고 권한을 승인하세요:\n${start.url}`);
      openBrowser(start.url);
      const params = await loop.waitForCallback;
      if (params.get('state') !== start.state) throw new ProviderError('auth', 'x.state', 'OAuth state 불일치');
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
    if (!code) throw new ProviderError('auth', 'x.denied', `인증 거부: ${params.get('error_description') ?? params.get('error') ?? 'unknown'}`);
    const tok = await tokenRequest(ctx, { code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: verifier });
    const account: Account = { platform: 'x', name, credentials: { ...tok, userId: '', username: '' }, profile: {} };
    const me = await api<{ data: { id: string; username: string; name: string } }>(ctx, account, '/2/users/me');
    account.credentials = { ...tok, userId: me.data.id, username: me.data.username };
    account.profile = { username: me.data.username, displayName: me.data.name };
    return account;
  },

  async refresh(ctx, account) {
    const c = creds(account);
    if (c.expiresAt - ctx.now().getTime() > 120_000) return account;
    if (!c.refreshToken) throw new ProviderError('auth', 'x.no_refresh', 'X 토큰이 만료됐습니다 — 다시 연결하세요');
    // Another process may have refreshed already (X refresh tokens are single-use): take its pair.
    const stored = ctx.store.getAccount('x', account.name);
    const sc = stored ? creds(stored) : c;
    if (stored && sc.refreshToken !== c.refreshToken && sc.expiresAt - ctx.now().getTime() > 120_000) return stored;
    try {
      const tok = await tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: sc.refreshToken }, sc);
      const next: Account = { ...(stored ?? account), credentials: { ...sc, ...tok } };
      ctx.store.saveAccount(next);
      return next;
    } catch (err) {
      // Lost a race: someone else used the token first and saved the new pair.
      const again = err instanceof ProviderError && err.kind === 'auth' ? ctx.store.getAccount('x', account.name) : undefined;
      if (again && creds(again).refreshToken !== sc.refreshToken) return again;
      throw err;
    }
  },

  validate(post, target) {
    const issues: Issue[] = [];
    const text = tweetText(post, target.options as XOptions);
    const len = weightedLength(text);
    if (len > TEXT_MAX) {
      issues.push({ severity: 'warning', code: 'text', message: `X 글이 ${len}(가중치) / ${TEXT_MAX}입니다. Premium이 아니면 거부됩니다 — options.text로 줄이세요` });
    }
    if (hasUrl(text)) issues.push({ severity: 'warning', code: 'url_cost', message: 'X는 URL이 들어간 게시물 요금이 훨씬 비쌉니다(약 $0.20)' });
    if (post.scheduledAt) issues.push({ severity: 'warning', code: 'schedule', message: 'X는 API 예약 게시가 없어 fanout이 예약 시각에 올립니다 (fanout worker 필요)' });
    if (post.thumbnailPath || post.captions.length) issues.push({ severity: 'warning', code: 'extras', message: 'X에는 썸네일·자막을 보내지 않습니다' });
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
      ctx.log.info('x: 이전 업로드 세션이 만료돼 처음부터 올립니다');
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
    else if (segment > 0) ctx.log.info(`x: ${segment}번째 조각부터 이어 올립니다`);

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
      ctx.log.info(`x: 이어 올리던 세션을 받지 않아 처음부터 올립니다 (${err.message})`);
      await initialize();
      await sendAll();
    }
    saveResume({ mediaId, segment, finalized: true, expiresAt });
    return { state: 'processing', remoteId: mediaId! };
  },

  async poll({ ctx, post, target, account }): Promise<PollOutcome> {
    const resume = (target.resume ?? {}) as { mediaId?: string; tweetId?: string; posting?: boolean };
    const username = creds(account).username;
    if (resume.tweetId) return { state: 'published', remoteId: resume.tweetId, remoteUrl: `https://x.com/${username}/status/${resume.tweetId}` };
    const mediaId = resume.mediaId ?? target.remoteId;

    const status = await api<{ data: MediaData }>(ctx, account, `/2/media/upload?${new URLSearchParams({ command: 'STATUS', media_id: mediaId })}`);
    const state = status.data.processing_info?.state;
    if (state === 'failed') {
      const e = status.data.processing_info?.error;
      throw new ProviderError('rejected', 'x.processing_failed', `X 영상 처리 실패: ${e?.message ?? e?.name ?? 'unknown'}`, e?.name);
    }
    if (state === 'pending' || state === 'in_progress') return { state: 'processing', remoteId: mediaId };

    // X has no idempotency key for posts. If a previous attempt may already have posted, stop
    // and let the user check instead of risking a duplicate.
    if (resume.posting) {
      throw new ProviderError('rejected', 'x.maybe_posted', `이전 시도에서 이미 게시됐을 수 있습니다. https://x.com/${username} 에서 확인한 뒤, 없으면 다시 시도하세요`, undefined, { keepResume: true });
    }
    ctx.store.updateTarget(target.id, { resume: { ...resume, posting: true } });
    const tweet = await api<{ data: { id: string } }>(ctx, account, '/2/tweets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: tweetText(post, target.options as XOptions), media: { media_ids: [mediaId] } }),
    }).catch((err: unknown) => {
      // A clear rejection means nothing was posted, so a later retry is safe.
      if (err instanceof ProviderError && err.kind !== 'retryable') ctx.store.updateTarget(target.id, { resume: { ...resume, posting: false } });
      throw err;
    });
    ctx.store.updateTarget(target.id, { resume: { ...resume, posting: false, tweetId: tweet.data.id } });
    return { state: 'published', remoteId: tweet.data.id, remoteUrl: `https://x.com/${username}/status/${tweet.data.id}` };
  },

  async doctor({ ctx, account }): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    try {
      app(ctx);
      checks.push({ name: 'BYO 앱', status: 'ok', detail: 'client id 등록됨' });
    } catch (err) {
      checks.push({ name: 'BYO 앱', status: 'fail', detail: (err as Error).message });
      return checks;
    }
    let acct = account;
    try {
      acct = await x.refresh(ctx, { ...account, credentials: { ...account.credentials, expiresAt: 0 } });
      checks.push({ name: '토큰 갱신', status: 'ok', detail: 'refresh token 유효' });
    } catch (err) {
      checks.push({ name: '토큰 갱신', status: 'fail', detail: (err as Error).message });
      return checks;
    }
    try {
      const me = await api<{ data: { username: string } }>(ctx, acct, '/2/users/me');
      checks.push({ name: '계정', status: 'ok', detail: `@${me.data.username}` });
    } catch (err) {
      checks.push({ name: '계정', status: 'fail', detail: (err as Error).message });
    }
    checks.push({ name: '요금', status: 'info', detail: 'X API는 종량제입니다. 게시마다 크레딧이 차감됩니다(console.x.com에서 잔액 확인)' });
    return checks;
  },

  statsCost: 'X API는 읽기도 요금이 듭니다',
  async stats({ ctx, account, target }) {
    const res = await api<{ data?: { public_metrics?: { impression_count?: number; like_count?: number; reply_count?: number; retweet_count?: number; quote_count?: number } } }>(
      ctx,
      account,
      `/2/tweets/${target.remoteId}?tweet.fields=public_metrics`,
    );
    const m = res.data?.public_metrics;
    if (!m) return { note: '게시물을 찾을 수 없습니다' };
    return { views: m.impression_count, likes: m.like_count, comments: m.reply_count, shares: (m.retweet_count ?? 0) + (m.quote_count ?? 0) };
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
