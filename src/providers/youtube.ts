import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { ProviderError, kindForStatus } from '../core/errors.ts';
import { jsonOrThrow, openBrowser, pkcePair, readChunk, sleep, startLoopback } from '../core/http.ts';
import { makeTestClip, probe, type MediaInfo, type MediaSpec } from '../core/media.ts';
import type { DoctorCheck, PollOutcome, Provider, ProviderContext, PublishOutcome } from '../core/provider.ts';
import type { Account } from '../core/store.ts';
import type { Issue, Post, Target } from '../core/types.ts';

// Docs: https://developers.google.com/youtube/v3/docs/videos/insert
//       https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Covers upload, read, captions, playlists and delete (used by `doctor --live` cleanup). */
const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
/** Multiple of 256 KiB, as the resumable protocol requires for non-final chunks. */
export const CHUNK_SIZE = 32 * 256 * 1024;
/** Default per-project allowance in the Video Uploads quota bucket (since 2026-06-01). */
export const DAILY_UPLOADS = 100;

export interface YouTubeApp {
  clientId: string;
  clientSecret: string;
}

export interface YouTubeCredentials {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
  /** Present when Google issued a time-limited refresh token (e.g. consent screen still in "Testing"). */
  refreshTokenExpiresAt?: number;
}

export interface YouTubeOptions {
  privacy: 'public' | 'unlisted' | 'private';
  madeForKids: boolean;
  categoryId?: string;
  playlistId?: string;
  notifySubscribers?: boolean;
  defaultLanguage?: string;
}

interface VideoResource {
  id: string;
  status?: {
    uploadStatus?: 'uploaded' | 'processed' | 'failed' | 'rejected' | 'deleted';
    privacyStatus?: 'public' | 'unlisted' | 'private';
    publishAt?: string;
    failureReason?: string;
    rejectionReason?: string;
  };
  processingDetails?: { processingStatus?: string };
}

interface GoogleError {
  error?: { code?: number; message?: string; errors?: Array<{ reason?: string; message?: string }> } | string;
  error_description?: string;
}

function describeGoogle(body: unknown): { code?: string; message?: string } {
  const b = body as GoogleError | undefined;
  if (!b) return {};
  if (typeof b.error === 'string') return { code: b.error, message: b.error_description ?? b.error };
  const reason = b.error?.errors?.[0]?.reason;
  return { code: reason, message: b.error?.message };
}

/** YouTube quota resets at midnight Pacific time. */
export function pacificDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now);
}

export function isShort(media: Pick<MediaInfo, 'durationSec' | 'video'>): boolean {
  return media.durationSec <= 180 && media.video.height >= media.video.width;
}

function app(ctx: ProviderContext): YouTubeApp {
  const a = ctx.store.getApp<YouTubeApp>('youtube');
  if (!a?.clientId || !a.clientSecret) {
    throw new ProviderError('auth', 'youtube.app_missing', 'YouTube 앱이 설정되지 않았습니다 — fanout setup youtube 참고');
  }
  return a;
}

function options(target: Target): YouTubeOptions {
  return target.options as unknown as YouTubeOptions;
}

async function tokenRequest(ctx: ProviderContext, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (res.status === 400 || res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as GoogleError;
    const code = typeof body.error === 'string' ? body.error : 'token_error';
    const hint =
      code === 'invalid_grant'
        ? ' — 토큰이 만료·철회됐습니다. OAuth 동의 화면이 "Testing" 상태면 refresh token이 7일 만에 만료되니 "In production"으로 바꾼 뒤 fanout connect youtube를 다시 실행하세요.'
        : '';
    throw new ProviderError('auth', 'youtube.token', `${body.error_description ?? code}${hint}`, code);
  }
  return jsonOrThrow(res, 'youtube', describeGoogle);
}

function credsFromToken(tok: Record<string, unknown>, now: number, previous?: YouTubeCredentials): YouTubeCredentials {
  const rtExpires = tok.refresh_token_expires_in as number | undefined;
  return {
    accessToken: tok.access_token as string,
    refreshToken: (tok.refresh_token as string | undefined) ?? previous?.refreshToken ?? '',
    expiresAt: now + ((tok.expires_in as number) ?? 3600) * 1000,
    refreshTokenExpiresAt: rtExpires ? now + rtExpires * 1000 : previous?.refreshTokenExpiresAt,
  };
}

function creds(account: Account): YouTubeCredentials {
  return account.credentials as unknown as YouTubeCredentials;
}

async function api<T>(ctx: ProviderContext, account: Account, path: string, init: RequestInit = {}): Promise<T> {
  const res = await ctx.fetch(path.startsWith('http') ? path : `${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${creds(account).accessToken}`, ...(init.headers as Record<string, string>) },
  });
  return jsonOrThrow<T>(res, 'youtube', describeGoogle);
}

/** Classify a failed upload response; quota and per-channel limits are not retryable today. */
async function uploadError(res: Response): Promise<ProviderError> {
  const text = await res.text();
  let parsed: GoogleError | undefined;
  try {
    parsed = JSON.parse(text) as GoogleError;
  } catch {
    parsed = undefined;
  }
  const { code, message } = describeGoogle(parsed);
  if (code === 'quotaExceeded' || code === 'uploadLimitExceeded' || code === 'rateLimitExceeded') {
    return new ProviderError('rejected', 'youtube.quota', `YouTube 업로드 한도 초과 (${code}). 태평양 시간 자정에 초기화됩니다.`, code);
  }
  return new ProviderError(kindForStatus(res.status), `youtube.http_${res.status}`, message ?? `YouTube HTTP ${res.status}: ${text.slice(0, 300)}`, code);
}

export function buildMetadata(post: Post, opts: YouTubeOptions): Record<string, unknown> {
  const scheduled = Boolean(post.scheduledAt);
  return {
    snippet: {
      title: post.title,
      description: post.description,
      tags: post.tags,
      categoryId: opts.categoryId ?? '22',
      ...(opts.defaultLanguage ? { defaultLanguage: opts.defaultLanguage } : {}),
    },
    status: {
      // A scheduled video must be private until publishAt; YouTube then makes it public.
      privacyStatus: scheduled ? 'private' : opts.privacy,
      ...(scheduled ? { publishAt: new Date(post.scheduledAt!).toISOString() } : {}),
      selfDeclaredMadeForKids: opts.madeForKids,
      containsSyntheticMedia: post.containsSyntheticMedia,
    },
  };
}

function forcedPrivateWarning(requested: YouTubeOptions['privacy'], video: VideoResource, scheduled: boolean): string | undefined {
  if (scheduled || requested === 'private') return undefined;
  if (video.status?.privacyStatus === 'private') {
    return `forced_private: ${requested}로 요청했지만 YouTube가 비공개로 설정했습니다. 미검증 API 프로젝트 제한일 수 있습니다 — YouTube API 감사(audit)를 신청하세요.`;
  }
  return undefined;
}

function videoUrl(id: string, short: boolean): string {
  return short ? `https://www.youtube.com/shorts/${id}` : `https://youtu.be/${id}`;
}

/** Ask the session how many bytes it has; returns the next offset, or the finished video. */
async function querySession(
  ctx: ProviderContext,
  account: Account,
  sessionUri: string,
  size: number,
): Promise<{ offset: number } | { video: VideoResource } | { expired: true }> {
  const res = await ctx.fetch(sessionUri, {
    method: 'PUT',
    headers: { authorization: `Bearer ${creds(account).accessToken}`, 'content-range': `bytes */${size}`, 'content-length': '0' },
  });
  if (res.status === 308) return { offset: nextOffset(res.headers.get('range')) };
  if (res.status === 200 || res.status === 201) return { video: (await res.json()) as VideoResource };
  if (res.status === 404 || res.status === 410) return { expired: true };
  throw await uploadError(res);
}

/** `Range: bytes=0-524287` → 524288. No header means nothing was stored yet. */
export function nextOffset(range: string | null): number {
  const m = range?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

async function startSession(ctx: ProviderContext, account: Account, post: Post, opts: YouTubeOptions, size: number): Promise<string> {
  const params = new URLSearchParams({ uploadType: 'resumable', part: 'snippet,status' });
  if (opts.notifySubscribers === false) params.set('notifySubscribers', 'false');
  const res = await ctx.fetch(`${UPLOAD_API}/videos?${params}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${creds(account).accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-length': String(size),
      'x-upload-content-type': 'video/*',
    },
    body: JSON.stringify(buildMetadata(post, opts)),
  });
  if (!res.ok) throw await uploadError(res);
  const location = res.headers.get('location');
  if (!location) throw new ProviderError('retryable', 'youtube.no_session', 'YouTube가 업로드 세션 URI를 돌려주지 않았습니다');
  return location;
}

async function uploadBytes(
  ctx: ProviderContext,
  account: Account,
  sessionUri: string,
  path: string,
  size: number,
  from: number,
): Promise<VideoResource> {
  let offset = from;
  while (offset < size) {
    const chunk = await readChunk(path, offset, Math.min(CHUNK_SIZE, size - offset));
    const end = offset + chunk.length - 1;
    const res = await ctx.fetch(sessionUri, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${creds(account).accessToken}`,
        'content-length': String(chunk.length),
        'content-range': `bytes ${offset}-${end}/${size}`,
      },
      body: chunk,
    });
    if (res.status === 308) {
      offset = nextOffset(res.headers.get('range'));
      ctx.log.info(`youtube: ${((offset / size) * 100).toFixed(0)}% 업로드`);
      continue;
    }
    if (res.status === 200 || res.status === 201) return (await res.json()) as VideoResource;
    throw await uploadError(res);
  }
  // All bytes acknowledged but no final response: ask the session.
  const state = await querySession(ctx, account, sessionUri, size);
  if ('video' in state) return state.video;
  throw new ProviderError('retryable', 'youtube.incomplete', '업로드가 완료되지 않았습니다. 세션에서 다시 이어 올립니다.');
}

function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === '.png' ? 'image/png' : 'image/jpeg';
}

/**
 * Thumbnail, captions and playlist, each attempted at most once per video: `done` lists what earlier
 * attempts already sent (captions and playlist items would duplicate if re-sent), and a failure here
 * only becomes a warning so it never sends the whole upload step round again.
 */
async function applyExtras(
  ctx: ProviderContext,
  account: Account,
  post: Post,
  opts: YouTubeOptions,
  videoId: string,
  done: readonly string[],
  markDone: (key: string) => void,
): Promise<string[]> {
  const warnings: string[] = [];
  const token = creds(account).accessToken;
  const attempt = async (key: string, label: string, send: () => Promise<Response>, hint = (_status: number) => '') => {
    if (done.includes(key)) return;
    markDone(key);
    try {
      const res = await send();
      if (!res.ok) {
        const { code, message } = describeGoogle(await res.json().catch(() => undefined));
        warnings.push(`${label} 실패 (${code ?? res.status}): ${message ?? ''}${hint(res.status)}`);
      }
    } catch (err) {
      warnings.push(`${label} 실패: ${(err as Error).message} — Studio에서 직접 확인하세요`);
    }
  };

  if (post.thumbnailPath) {
    const path = post.thumbnailPath;
    await attempt(
      'thumbnail',
      '썸네일',
      () =>
        ctx.fetch(`${UPLOAD_API}/thumbnails/set?videoId=${videoId}&uploadType=media`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': mimeFor(path) },
          body: readFileSync(path),
        }),
      (status) => (status === 403 ? ' — 맞춤 썸네일은 전화번호 인증된 채널만 가능합니다' : ''),
    );
  }

  for (const cap of post.captions) {
    await attempt(`caption:${cap.language}`, `자막(${cap.language})`, () => {
      const boundary = `fanout${Date.now().toString(36)}`;
      const meta = JSON.stringify({ snippet: { videoId, language: cap.language, name: cap.name ?? '' } });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`),
        readFileSync(cap.path),
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      return ctx.fetch(`${UPLOAD_API}/captions?uploadType=multipart&part=snippet`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
        body,
      });
    });
  }

  if (opts.playlistId) {
    const playlistId = opts.playlistId;
    await attempt('playlist', '재생목록 추가', () =>
      ctx.fetch(`${API}/playlistItems?part=snippet`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } }),
      }),
    );
  }
  return warnings;
}

function outcomeFor(video: VideoResource, post: Post, opts: YouTubeOptions, short: boolean): PollOutcome {
  const upload = video.status?.uploadStatus;
  if (upload === 'failed') {
    throw new ProviderError('rejected', 'youtube.processing_failed', `YouTube 처리 실패: ${video.status?.failureReason ?? 'unknown'}`, video.status?.failureReason);
  }
  if (upload === 'rejected') {
    throw new ProviderError('rejected', 'youtube.rejected', `YouTube 거부: ${video.status?.rejectionReason ?? 'unknown'}`, video.status?.rejectionReason);
  }
  if (upload === 'deleted') throw new ProviderError('rejected', 'youtube.deleted', '영상이 삭제됐습니다');
  const warning = forcedPrivateWarning(opts.privacy, video, Boolean(post.scheduledAt));
  const warnings = warning ? [warning] : [];
  if (post.scheduledAt && video.status?.publishAt) warnings.push(`예약 게시: ${video.status.publishAt}`);
  const base = { remoteId: video.id, remoteUrl: videoUrl(video.id, short), warnings };
  return upload === 'processed' ? { state: 'published', ...base } : { state: 'processing', ...base };
}

export const youtube: Provider = {
  id: 'youtube',
  displayName: 'YouTube',
  capabilities: { nativeSchedule: true, thumbnail: true, captions: true, syntheticMediaFlag: true },
  spec: {
    maxBytes: 256 * 1024 ** 3,
    maxDurationSec: 12 * 3600,
  } satisfies MediaSpec,

  appFields: [
    { key: 'clientId', label: 'OAuth Client ID', secret: false },
    { key: 'clientSecret', label: 'OAuth Client Secret', secret: true },
  ],

  setupGuide() {
    return `YouTube — 내 Google Cloud 프로젝트 만들기 (BYO)

YouTube API 정책상 오픈소스에 API 자격증명을 넣을 수 없어, 사용자마다 자기 프로젝트를 만듭니다.

1. https://console.cloud.google.com/ 에서 새 프로젝트 생성
2. "API 및 서비스 → 라이브러리"에서 YouTube Data API v3 사용 설정
3. "OAuth 동의 화면": User type External, 앱 이름·이메일 입력,
   범위에 .../auth/youtube.force-ssl 추가, 테스트 사용자에 본인 Google 계정 추가
4. ⚠ 게시 상태를 "In production"으로 바꾸세요. "Testing"이면 refresh token이 7일 만에 만료되어
   매주 다시 연결해야 합니다. (본인만 쓰는 앱은 미검증 경고 화면이 떠도 "계속"으로 진행 가능)
5. "사용자 인증 정보 → OAuth 클라이언트 ID": 애플리케이션 유형 "데스크톱 앱"
6. 받은 값을 등록:
     fanout app set youtube --clientId <ID> --clientSecret <SECRET>
   또는 내려받은 JSON 파일로:
     fanout app set youtube --file client_secret_XXXX.json
7. fanout connect youtube --name main
8. fanout doctor youtube --live 로 공개 업로드가 실제로 가능한지 확인 (테스트 영상 1개를 올렸다 지웁니다)

한도: 프로젝트당 하루 업로드 ${DAILY_UPLOADS}회(태평양 시간 자정 초기화).`;
  },

  connectMethod: 'oauth',

  async connect(ctx, name) {
    const loop = await startLoopback(0);
    const start = youtube.oauthBegin!(ctx, loop.redirectUri);
    ctx.log.info(`브라우저에서 업로드할 채널의 Google 계정으로 로그인하세요:\n${start.url}`);
    openBrowser(start.url);
    let params: URLSearchParams;
    try {
      params = await loop.waitForCallback;
    } finally {
      loop.close();
    }
    if (params.get('state') !== start.state) throw new ProviderError('auth', 'youtube.state', 'OAuth state 불일치');
    return youtube.oauthFinish!(ctx, name, params, loop.redirectUri, start.verifier);
  },

  // Google "Desktop app" clients accept any loopback redirect, so the CLI's random port and the
  // dashboard's own address both work without registering anything.
  oauthBegin(ctx, redirectUri) {
    const { clientId } = app(ctx);
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomUUID();
    const url = `${AUTH_URL}?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      state,
    })}`;
    return { url, state, verifier };
  },

  async oauthFinish(ctx, name, params, redirectUri, verifier) {
    const { clientId, clientSecret } = app(ctx);
    const code = params.get('code');
    if (!code) throw new ProviderError('auth', 'youtube.denied', `인증 거부: ${params.get('error') ?? 'unknown'}`);
    const tok = await tokenRequest(ctx, {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    const credentials = credsFromToken(tok, ctx.now().getTime());
    const account: Account = { platform: 'youtube', name, credentials: { ...credentials }, profile: {} };
    const ch = await api<{ items?: Array<{ id: string; snippet: { title: string } }> }>(ctx, account, '/channels?part=snippet&mine=true');
    const channel = ch.items?.[0];
    if (!channel) throw new ProviderError('rejected', 'youtube.no_channel', '이 Google 계정에 YouTube 채널이 없습니다');
    account.profile = { channelId: channel.id, channelTitle: channel.snippet.title };
    if (credentials.refreshTokenExpiresAt) {
      ctx.log.warn('이 refresh token은 만료 기한이 있습니다. OAuth 동의 화면이 "Testing"이면 7일 뒤 다시 연결해야 합니다.');
    }
    return account;
  },

  async refresh(ctx, account) {
    const c = creds(account);
    if (c.expiresAt - ctx.now().getTime() > 120_000) return account;
    const { clientId, clientSecret } = app(ctx);
    const tok = await tokenRequest(ctx, {
      refresh_token: c.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });
    const next: Account = { ...account, credentials: { ...credsFromToken(tok, ctx.now().getTime(), c) } };
    ctx.store.saveAccount(next);
    return next;
  },

  validate(post, target, media) {
    const issues: Issue[] = [];
    const o = target.options as Partial<YouTubeOptions>;
    if (!o.privacy || !['public', 'unlisted', 'private'].includes(o.privacy)) {
      issues.push({ severity: 'error', code: 'privacy', message: 'YouTube 공개 범위(public/unlisted/private)를 직접 지정해야 합니다' });
    }
    if (typeof o.madeForKids !== 'boolean') {
      issues.push({ severity: 'error', code: 'made_for_kids', message: 'YouTube "아동용 여부"(madeForKids yes/no)를 지정해야 합니다' });
    }
    if (post.scheduledAt && o.privacy && o.privacy !== 'public') {
      issues.push({ severity: 'error', code: 'schedule_privacy', message: 'YouTube 예약 게시는 public으로 공개되는 경우만 지원합니다' });
    }
    if (!post.title.trim()) issues.push({ severity: 'error', code: 'title', message: 'YouTube 제목이 비어 있습니다' });
    if ([...post.title].length > 100) issues.push({ severity: 'error', code: 'title', message: 'YouTube 제목은 100자 이하' });
    if (/[<>]/.test(post.title) || /[<>]/.test(post.description)) {
      issues.push({ severity: 'error', code: 'angle_brackets', message: 'YouTube 제목·설명에 < > 문자를 쓸 수 없습니다' });
    }
    if (Buffer.byteLength(post.description) > 5000) issues.push({ severity: 'error', code: 'description', message: 'YouTube 설명은 5000바이트 이하' });
    if (post.tags.join(',').length > 500) issues.push({ severity: 'error', code: 'tags', message: 'YouTube 태그 합계 500자 이하' });
    if (post.thumbnailPath && statSync(post.thumbnailPath).size > 2 * 1024 * 1024) {
      issues.push({ severity: 'error', code: 'thumbnail', message: 'YouTube 썸네일은 2MB 이하' });
    }
    if (isShort(media)) {
      issues.push({ severity: 'warning', code: 'shorts', message: '3분 이하 세로/정사각형 영상이라 YouTube가 Shorts로 분류합니다' });
    }
    return issues;
  },

  async publish({ ctx, post, target, account, mediaPath, media, saveResume }): Promise<PublishOutcome> {
    const opts = options(target);
    const size = statSync(mediaPath).size;
    const short = isShort(media);
    const resume = (target.resume ?? {}) as { sessionUri?: string; size?: number; videoId?: string; extras?: string[] };

    let video: VideoResource | undefined;
    if (resume.videoId) {
      video = { id: resume.videoId };
    } else {
      let sessionUri = resume.sessionUri && resume.size === size ? resume.sessionUri : undefined;
      let offset = 0;
      if (sessionUri) {
        const state = await querySession(ctx, account, sessionUri, size);
        if ('video' in state) video = state.video;
        else if ('expired' in state) sessionUri = undefined;
        else {
          offset = state.offset;
          ctx.log.info(`youtube: ${offset} 바이트부터 이어 올립니다`);
        }
      }
      if (!video) {
        if (!sessionUri) {
          const day = pacificDay(ctx.now());
          const used = ctx.store.getUsage('youtube', 'project', day);
          if (used >= DAILY_UPLOADS) {
            throw new ProviderError('rejected', 'youtube.quota', `오늘 업로드 ${used}/${DAILY_UPLOADS}회를 이미 썼습니다 (로컬 집계)`);
          }
          sessionUri = await startSession(ctx, account, post, opts, size);
          saveResume({ sessionUri, size });
          ctx.store.bumpUsage('youtube', 'project', day);
        }
        video = await uploadBytes(ctx, account, sessionUri, mediaPath, size, offset);
      }
      saveResume({ videoId: video.id });
    }

    const done = [...(resume.extras ?? [])];
    const warnings = await applyExtras(ctx, account, post, opts, video.id, done, (key) => {
      done.push(key);
      saveResume({ videoId: video.id, extras: [...done] });
    });
    const outcome: PublishOutcome = video.status
      ? outcomeFor(video, post, opts, short)
      : { state: 'processing', remoteId: video.id, remoteUrl: videoUrl(video.id, short) };
    return { ...outcome, warnings: [...warnings, ...(outcome.warnings ?? [])] };
  },

  async poll({ ctx, post, target, account }): Promise<PollOutcome> {
    const res = await api<{ items?: VideoResource[] }>(ctx, account, `/videos?part=status,processingDetails&id=${target.remoteId}`);
    const video = res.items?.[0];
    if (!video) throw new ProviderError('rejected', 'youtube.not_found', `영상 ${target.remoteId}을 찾을 수 없습니다 (삭제됨?)`);
    const short = target.remoteUrl?.includes('/shorts/') ?? false;
    return outcomeFor(video, post, options(target), short);
  },

  async doctor({ ctx, account, live }): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    try {
      app(ctx);
      checks.push({ name: 'BYO 앱', status: 'ok', detail: 'OAuth client 등록됨' });
    } catch (err) {
      checks.push({ name: 'BYO 앱', status: 'fail', detail: (err as Error).message });
      return checks;
    }

    let acct = account;
    try {
      acct = await youtube.refresh(ctx, { ...account, credentials: { ...account.credentials, expiresAt: 0 } });
      checks.push({ name: '토큰 갱신', status: 'ok', detail: 'refresh token 유효' });
    } catch (err) {
      checks.push({ name: '토큰 갱신', status: 'fail', detail: (err as Error).message });
      return checks;
    }

    const rtExp = creds(acct).refreshTokenExpiresAt;
    checks.push(
      rtExp
        ? {
            name: 'refresh token 수명',
            status: 'warn',
            detail: `만료 예정 ${new Date(rtExp).toISOString()} — 동의 화면이 "Testing"이면 "In production"으로 바꾸고 다시 연결하세요`,
          }
        : { name: 'refresh token 수명', status: 'ok', detail: '만료 기한 없음 (In production으로 보임)' },
    );

    const ch = await api<{ items?: Array<{ id: string; snippet: { title: string }; status?: { longUploadsStatus?: string } }> }>(
      ctx,
      acct,
      '/channels?part=snippet,status&mine=true',
    );
    const channel = ch.items?.[0];
    checks.push({ name: '채널', status: channel ? 'ok' : 'fail', detail: channel ? `${channel.snippet.title} (${channel.id})` : '채널 없음' });
    if (channel?.status?.longUploadsStatus && channel.status.longUploadsStatus !== 'allowed') {
      checks.push({ name: '15분 초과 업로드', status: 'warn', detail: `longUploadsStatus=${channel.status.longUploadsStatus} — 전화번호 인증 필요` });
    }

    const used = ctx.store.getUsage('youtube', 'project', pacificDay(ctx.now()));
    checks.push({ name: '오늘 업로드 (로컬 집계)', status: used >= DAILY_UPLOADS ? 'fail' : 'info', detail: `${used}/${DAILY_UPLOADS}` });

    if (!live) {
      checks.push({
        name: '미검증 프로젝트 공개 업로드',
        status: 'info',
        detail: '확인하려면 --live 로 다시 실행 (일부 공개 테스트 영상을 올리고 지웁니다)',
      });
      return checks;
    }

    // Open question from the research: does an unverified project's upload still get locked to private?
    const clip = join(tmpdir(), `fanout-doctor-${Date.now()}.mp4`);
    await makeTestClip(clip);
    const media = await probe(clip);
    const post: Post = {
      id: 'doctor',
      createdAt: ctx.now().toISOString(),
      mediaPath: clip,
      title: 'fanout doctor test (자동 삭제)',
      description: 'fanout doctor --live 가 업로드 동작을 확인하려고 올린 테스트 영상입니다.',
      tags: [],
      captions: [],
      containsSyntheticMedia: false,
    };
    const opts: YouTubeOptions = { privacy: 'unlisted', madeForKids: false, notifySubscribers: false };
    const day = pacificDay(ctx.now());
    const session = await startSession(ctx, acct, post, opts, media.sizeBytes);
    ctx.store.bumpUsage('youtube', 'project', day);
    let video = await uploadBytes(ctx, acct, session, clip, media.sizeBytes, 0);
    checks.push({ name: '테스트 업로드', status: 'ok', detail: `videoId=${video.id}, 요청 unlisted → 응답 ${video.status?.privacyStatus}` });

    for (let i = 0; i < 30 && video.status?.uploadStatus !== 'processed'; i++) {
      await sleep(10_000);
      const r = await api<{ items?: VideoResource[] }>(ctx, acct, `/videos?part=status&id=${video.id}`);
      if (r.items?.[0]) video = r.items[0];
      if (video.status?.uploadStatus === 'failed' || video.status?.uploadStatus === 'rejected') break;
    }
    const privacy = video.status?.privacyStatus;
    checks.push(
      privacy === 'private'
        ? {
            name: '미검증 프로젝트 공개 업로드',
            status: 'fail',
            detail: `처리 후 privacyStatus=private (uploadStatus=${video.status?.uploadStatus}). 비공개 고정 규칙이 아직 적용됩니다 — YouTube API audit 신청 필요`,
          }
        : {
            name: '미검증 프로젝트 공개 업로드',
            status: video.status?.uploadStatus === 'processed' ? 'ok' : 'warn',
            detail: `privacyStatus=${privacy}, uploadStatus=${video.status?.uploadStatus}. 비공개로 고정되지 않았습니다${
              video.status?.uploadStatus === 'processed' ? '' : ' (처리 미완료 — 나중에 Studio에서 한 번 더 확인)'
            }`,
          },
    );

    const del = await ctx.fetch(`${API}/videos?id=${video.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${creds(acct).accessToken}` },
    });
    checks.push({
      name: '테스트 영상 삭제',
      status: del.ok ? 'ok' : 'warn',
      detail: del.ok ? '삭제함' : `삭제 실패 HTTP ${del.status} — Studio에서 직접 지우세요: https://youtu.be/${video.id}`,
    });
    return checks;
  },
};
