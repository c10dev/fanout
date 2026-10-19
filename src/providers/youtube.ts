import { readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { ProviderError, kindForStatus } from '../core/errors.ts';
import { imageMime, jsonOr, jsonOrThrow, openBrowser, pkcePair, readChunk, sleep, startLoopback, waitForRedirect } from '../core/http.ts';
import { makeTestClip, probe, type MediaInfo, type MediaSpec } from '../core/media.ts';
import type { DoctorCheck, PollOutcome, Provider, ProviderContext, PublishOutcome } from '../core/provider.ts';
import type { Account } from '../core/store.ts';
import type { Issue, Post, PostStats, Target } from '../core/types.ts';
import { msg } from '../core/i18n.ts';

// Docs: https://developers.google.com/youtube/v3/docs/videos/insert
//       https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** Covers upload, read, captions, playlists and delete (used by `doctor --live` cleanup). */
const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const MANAGE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
// reports.query also asks for youtube.readonly (Analytics API revision history, 2018-06-18).
const SCOPE = `${MANAGE_SCOPE} https://www.googleapis.com/auth/youtube.readonly ${ANALYTICS_SCOPE}`;
const ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2';
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
  /** Granted scopes, space-separated, as the token response says (unknown on older tokens). */
  scope?: string;
}

export interface YouTubeOptions {
  privacy: 'public' | 'unlisted' | 'private';
  madeForKids: boolean;
  categoryId?: string;
  playlistId?: string;
  notifySubscribers?: boolean;
  /** Language of the title and description (needed for localizations). */
  defaultLanguage?: string;
  license?: 'youtube' | 'creativeCommon';
  /** Others may embed the video on their sites (YouTube's default: yes). */
  embeddable?: boolean;
  /** Show the extended statistics on the watch page (YouTube's default: yes; view and like counts stay public either way). */
  publicStatsViewable?: boolean;
  /** Title and description in other languages, by language code. */
  localizations?: Record<string, { title: string; description?: string }>;
  /** When the video was recorded, YYYY-MM-DD (recordingDetails.recordingDate). */
  recordingDate?: string;
  /** Tell viewers the video has paid product placement (paidProductPlacementDetails), set after the upload. */
  paidProductPlacement?: boolean;
}

const RECORDING_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Problems with chapter timestamps in a description, which YouTube turns into chapters only when the
 * first is 0:00, there are at least three, they go up, and each lasts at least 10 seconds. Nothing
 * when the description has no timestamps at all.
 */
export function chapterProblems(description: string): string[] {
  const times = description
    .split('\n')
    // A timestamp at the start or the end of a line (": 0:00 Intro", "Intro - 0:00"), seconds 00-59.
    .map((line) => /^\s*[(\[]?((?:\d{1,2}:)?\d{1,2}:[0-5]\d)(?![\d:])/.exec(line)?.[1] ?? /(?:^|\s)[(\[]?((?:\d{1,2}:)?\d{1,2}:[0-5]\d)[)\]]?\s*$/.exec(line)?.[1])
    .filter((t): t is string => Boolean(t))
    .map((t) => t.split(':').reduce((sum, part) => sum * 60 + Number(part), 0));
  // Times of day in a schedule ("19:30 doors") aren't chapters; a list meant as chapters starts at or
  // near 0:00 (0:05 is the usual slip), so one with no 0:00 that starts a minute in is left alone.
  if (!times.length || (!times.includes(0) && times[0]! >= 60)) return [];
  const problems: string[] = [];
  if (times[0] !== 0) problems.push(msg('첫 타임스탬프가 0:00이어야 합니다'));
  if (times.length < 3) problems.push(msg('타임스탬프가 3개 이상이어야 합니다 (지금 {n}개)', { n: times.length }));
  if (times.some((t, i) => i > 0 && t <= times[i - 1]!)) problems.push(msg('타임스탬프가 차례로 커져야 합니다'));
  else if (times.some((t, i) => i > 0 && t - times[i - 1]! < 10)) problems.push(msg('챕터는 10초 이상이어야 합니다'));
  return problems;
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

/** The next midnight in Pacific time (07:00 or 08:00 UTC, depending on daylight saving). */
export function nextPacificMidnight(now: Date): Date {
  const [y, m, d] = pacificDay(now).split('-').map(Number) as [number, number, number];
  const hour = (t: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' }).format(t));
  for (const utcHour of [7, 8]) {
    const t = new Date(Date.UTC(y, m - 1, d + 1, utcHour));
    if (hour(t) === 0) return t;
  }
  return new Date(Date.UTC(y, m - 1, d + 1, 8));
}

export function isShort(media: Pick<MediaInfo, 'durationSec' | 'video'>): boolean {
  return media.durationSec <= 180 && media.video.height >= media.video.width;
}

function app(ctx: ProviderContext): YouTubeApp {
  const a = ctx.store.getApp<YouTubeApp>('youtube');
  if (!a?.clientId || !a.clientSecret) {
    throw new ProviderError('auth', 'youtube.app_missing', msg('YouTube 앱이 설정되지 않았습니다 — fanout setup youtube 참고'));
  }
  return a;
}

function options(target: Target): YouTubeOptions {
  return target.options as unknown as YouTubeOptions;
}

async function tokenRequest(ctx: ProviderContext, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await ytFetch(ctx, TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (res.status === 400 || res.status === 401) {
    const body = (await jsonOr(res, {})) as GoogleError;
    const code = typeof body.error === 'string' ? body.error : 'token_error';
    const error = body.error_description ?? code;
    throw new ProviderError(
      'auth',
      'youtube.token',
      code === 'invalid_grant'
        ? msg('{error} — 토큰이 만료·철회됐습니다. OAuth 동의 화면이 "Testing" 상태면 refresh token이 7일 만에 만료되니 "In production"으로 바꾼 뒤 fanout connect youtube를 다시 실행하세요.', { error })
        : error,
      code,
    );
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
    scope: (tok.scope as string | undefined) ?? previous?.scope,
  };
}

/** false only when the token is known to lack the Analytics scope (connected before fanout asked for it). */
function mayReadAnalytics(account: Account): boolean {
  const scope = creds(account).scope;
  return scope === undefined || scope.split(' ').includes(ANALYTICS_SCOPE);
}

/** Drop undefined fields, so a merge never overwrites a value with "unknown". */
function definedOnly<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

type AnalyticsValues = Pick<PostStats, 'watchTimeSec' | 'avgWatchSec' | 'avgViewPct' | 'subscribersGained'>;

/** Why an Analytics call failed, in words the user can act on; undefined for a passing failure. */
function analyticsProblem(err: unknown, account: Account): string | undefined {
  if (!(err instanceof ProviderError)) return undefined;
  const code = err.platformCode;
  // Google answers a disabled API with a 403 whose reason or text says so.
  if (code === 'accessNotConfigured' || code === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(err.message)) {
    return msg('Google Cloud 프로젝트에서 YouTube Analytics API를 사용 설정하세요 (API 및 서비스 → 라이브러리)');
  }
  if (code === 'insufficientPermissions') {
    // Reconnecting only helps when the token really lacks the scope.
    return creds(account).scope?.split(' ').includes(ANALYTICS_SCOPE)
      ? msg('권한이 있는데도 YouTube Analytics가 거부했습니다: {err}', { err: err.message })
      : msg('시청 시간 같은 분석 통계는 yt-analytics.readonly 권한이 필요합니다 — fanout connect youtube로 다시 연결하세요');
  }
  if (code === 'forbidden') return msg('이 채널의 분석 데이터를 읽을 수 없습니다: {err}', { err: err.message });
  return undefined;
}

/**
 * Watch time, average view duration and % viewed, and subscribers gained on the video's page, from
 * the YouTube Analytics API (its own quota, not the Data API's units). Never fails the stats call:
 * what can't be read becomes a note, and the last numbers stay.
 */
async function analytics(ctx: ProviderContext, account: Account, target: Target & { remoteId: string }): Promise<{ values: AnalyticsValues; note?: string }> {
  const s = target.stats;
  const last = definedOnly({ watchTimeSec: s?.watchTimeSec, avgWatchSec: s?.avgWatchSec, avgViewPct: s?.avgViewPct, subscribersGained: s?.subscribersGained });
  if (!mayReadAnalytics(account)) return { values: last, note: msg('시청 시간 같은 분석 통계는 yt-analytics.readonly 권한이 필요합니다 — fanout connect youtube로 다시 연결하세요') };
  const query = new URLSearchParams({
    ids: 'channel==MINE',
    startDate: '2005-02-14',
    endDate: pacificDay(ctx.now()),
    metrics: 'estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained',
    filters: `video==${target.remoteId}`,
  });
  try {
    const res = await api<{ columnHeaders?: Array<{ name: string }>; rows?: number[][] }>(ctx, account, `${ANALYTICS_API}/reports?${query}`);
    const row = res.rows?.[0];
    if (!row) return { values: last, note: msg('아직 분석 통계가 없습니다 (보통 하루 이틀 늦게 나옵니다)') };
    const at = (name: string) => {
      const i = (res.columnHeaders ?? []).findIndex((h) => h.name === name);
      return i < 0 || typeof row[i] !== 'number' ? undefined : row[i];
    };
    const minutes = at('estimatedMinutesWatched');
    const pct = at('averageViewPercentage');
    return {
      values: definedOnly({
        watchTimeSec: minutes === undefined ? undefined : minutes * 60,
        avgWatchSec: at('averageViewDuration'),
        avgViewPct: pct === undefined ? undefined : Math.round(pct * 10) / 10,
        subscribersGained: at('subscribersGained'),
      }),
    };
  } catch (err) {
    return { values: last, note: analyticsProblem(err, account) ?? msg('분석 통계를 읽지 못해 지난 값을 둡니다: {err}', { err: (err as Error).message }) };
  }
}

function creds(account: Account): YouTubeCredentials {
  return account.credentials as unknown as YouTubeCredentials;
}

/** The project's daily API quota, shared by every call except uploads (which have their own 100). */
export const DAILY_UNITS = 10_000;

/**
 * Quota units a request costs (developers.google.com/youtube/v3/determine_quota_cost): reads 1,
 * writes 50, a caption upload 400, a video insert 1 (its count is kept separately). Token calls and
 * the chunks of a resumable upload cost nothing.
 */
export function unitCost(method: string, url: string): number {
  const u = new URL(url);
  if (u.hostname !== 'www.googleapis.com' || u.searchParams.has('upload_id')) return 0;
  const path = u.pathname.replace(/^\/(upload\/)?youtube\/v3/, '');
  const m = method.toUpperCase();
  if (path.startsWith('/captions')) return m === 'GET' ? 50 : 400;
  if (path.startsWith('/thumbnails')) return 50;
  if (m === 'GET') return 1;
  if (path === '/videos' && m === 'POST') return 1;
  return 50;
}

/** Units a post will spend: the insert, its captions, thumbnail, playlist entry and paid-placement update, and a few status checks. */
export function postUnits(post: Pick<Post, 'captions' | 'thumbnailPath'>, o: Pick<YouTubeOptions, 'playlistId' | 'paidProductPlacement'>): number {
  return 1 + post.captions.length * 400 + (post.thumbnailPath ? 50 : 0) + (o.playlistId ? 50 : 0) + (o.paidProductPlacement === true ? 50 : 0) + 10;
}

/** fetch for YouTube calls, counting the quota units each one spends (charged even when it fails). */
async function ytFetch(ctx: ProviderContext, input: string, init: RequestInit = {}): Promise<Response> {
  const cost = unitCost(init.method ?? 'GET', input);
  if (cost) ctx.store.bumpUsage('youtube', 'units', pacificDay(ctx.now()), cost);
  return ctx.fetch(input, init);
}

async function api<T>(ctx: ProviderContext, account: Account, path: string, init: RequestInit = {}): Promise<T> {
  const res = await ytFetch(ctx, path.startsWith('http') ? path : `${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${creds(account).accessToken}`, ...(init.headers as Record<string, string>) },
  });
  return jsonOrThrow<T>(res, 'youtube', describeGoogle).catch((err: unknown) => {
    // The daily quota covers every call (status checks included): say when it comes back.
    if (err instanceof ProviderError && err.platformCode === 'quotaExceeded') {
      throw new ProviderError(err.kind, err.code, err.message, err.platformCode, { retryAt: quotaReset(ctx.now()) });
    }
    throw err;
  });
}

/** Five minutes after YouTube's daily quota resets (midnight Pacific). */
function quotaReset(now: Date): Date {
  return new Date(nextPacificMidnight(now).getTime() + 5 * 60_000);
}

/** Classify a failed upload response; quota and per-channel limits are not retryable today. */
async function uploadError(res: Response, now = new Date()): Promise<ProviderError> {
  const text = await res.text();
  let parsed: GoogleError | undefined;
  try {
    parsed = JSON.parse(text) as GoogleError;
  } catch {
    parsed = undefined;
  }
  const { code, message } = describeGoogle(parsed);
  if (code === 'quotaExceeded' || code === 'uploadLimitExceeded') {
    // Daily caps reset at midnight Pacific time: try again just after.
    const retryAt = quotaReset(now);
    return new ProviderError('rejected', 'youtube.quota', msg('YouTube 업로드 한도 초과 ({code}). 태평양 시간 자정에 초기화됩니다.', { code }), code, { retryAt });
  }
  if (code === 'rateLimitExceeded') return new ProviderError('retryable', 'youtube.rate_limit', message ?? code, code);
  return new ProviderError(kindForStatus(res.status), `youtube.http_${res.status}`, message ?? `YouTube HTTP ${res.status}: ${text.slice(0, 300)}`, code);
}

/** A schedule still ahead; a past one (e.g. picked up late) means publishing now, like Mastodon and PeerTube. */
function scheduleAhead(post: Post): boolean {
  return Boolean(post.scheduledAt) && Date.parse(post.scheduledAt!) > Date.now();
}

export function buildMetadata(post: Post, opts: YouTubeOptions): Record<string, unknown> {
  const scheduled = scheduleAhead(post);
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
      ...(opts.license ? { license: opts.license } : {}),
      ...(opts.embeddable === false ? { embeddable: false } : {}),
      ...(opts.publicStatsViewable === false ? { publicStatsViewable: false } : {}),
    },
    ...(hasLocalizations(opts) ? { localizations: opts.localizations } : {}),
    ...(opts.recordingDate && RECORDING_DATE.test(opts.recordingDate) ? { recordingDetails: { recordingDate: `${opts.recordingDate}T00:00:00Z` } } : {}),
  };
}

const hasLocalizations = (opts: YouTubeOptions) => Boolean(opts.localizations && Object.keys(opts.localizations).length);

/** The resource parts videos.insert must be told about: the ones buildMetadata filled in. */
export function insertParts(opts: YouTubeOptions): string {
  return ['snippet', 'status', ...(hasLocalizations(opts) ? ['localizations'] : []), ...(opts.recordingDate && RECORDING_DATE.test(opts.recordingDate) ? ['recordingDetails'] : [])].join(',');
}

function forcedPrivateWarning(requested: YouTubeOptions['privacy'], video: VideoResource, scheduled: boolean): string | undefined {
  if (scheduled || requested === 'private') return undefined;
  if (video.status?.privacyStatus === 'private') {
    return msg('forced_private: {requested}로 요청했지만 YouTube가 비공개로 설정했습니다. 미검증 API 프로젝트 제한일 수 있습니다 — YouTube API 감사(audit)를 신청하세요.', { requested });
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
  const res = await ytFetch(ctx, sessionUri, {
    method: 'PUT',
    headers: { authorization: `Bearer ${creds(account).accessToken}`, 'content-range': `bytes */${size}`, 'content-length': '0' },
  });
  if (res.status === 308) return { offset: nextOffset(res.headers.get('range')) };
  if (res.status === 200 || res.status === 201) return { video: (await res.json()) as VideoResource };
  if (res.status === 404 || res.status === 410) return { expired: true };
  throw await uploadError(res, ctx.now());
}

/** `Range: bytes=0-524287` → 524288. No header means nothing was stored yet. */
export function nextOffset(range: string | null): number {
  const m = range?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

async function startSession(ctx: ProviderContext, account: Account, post: Post, opts: YouTubeOptions, size: number): Promise<string> {
  const params = new URLSearchParams({ uploadType: 'resumable', part: insertParts(opts) });
  if (opts.notifySubscribers === false) params.set('notifySubscribers', 'false');
  const res = await ytFetch(ctx, `${UPLOAD_API}/videos?${params}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${creds(account).accessToken}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-length': String(size),
      'x-upload-content-type': 'video/*',
    },
    body: JSON.stringify(buildMetadata(post, opts)),
  });
  if (!res.ok) throw await uploadError(res, ctx.now());
  const location = res.headers.get('location');
  if (!location) throw new ProviderError('retryable', 'youtube.no_session', msg('YouTube가 업로드 세션 URI를 돌려주지 않았습니다'));
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
    const res = await ytFetch(ctx, sessionUri, {
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
      ctx.log.info(msg('youtube: {offset}% 업로드', { offset: ((offset / size) * 100).toFixed(0) }));
      continue;
    }
    if (res.status === 200 || res.status === 201) return (await res.json()) as VideoResource;
    throw await uploadError(res, ctx.now());
  }
  // All bytes acknowledged but no final response: ask the session.
  const state = await querySession(ctx, account, sessionUri, size);
  if ('video' in state) return state.video;
  throw new ProviderError('retryable', 'youtube.incomplete', msg('업로드가 완료되지 않았습니다. 세션에서 다시 이어 올립니다.'));
}

/**
 * Paid-placement disclosure, thumbnail, captions and playlist, each attempted at most once per video: `done` lists what earlier
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
  unmarkDone: (key: string) => void = () => {},
): Promise<string[]> {
  const warnings: string[] = [];
  const token = creds(account).accessToken;
  // `hint` adds a known cause for a status (one message, so it reads back whole in English).
  const attempt = async (key: string, label: string, send: () => Promise<Response>, hint = (_status: number): string | undefined => undefined) => {
    if (done.includes(key)) return;
    markDone(key);
    try {
      const res = await send();
      if (!res.ok) {
        const { code, message } = describeGoogle(await jsonOr(res, undefined));
        const vars = { label, code: code ?? res.status, message: message ?? '', hint: hint(res.status) };
        warnings.push(vars.hint ? msg('{label} 실패 ({code}): {message} — {hint}', vars) : msg('{label} 실패 ({code}): {message}', vars));
      }
    } catch (err) {
      // A lost work lock refused the request before it went out: not done, and this step stops.
      if (err instanceof ProviderError && err.code === 'lease_lost') {
        unmarkDone(key);
        throw err;
      }
      warnings.push(msg('{label} 실패: {err} — Studio에서 직접 확인하세요', { label, err: (err as Error).message }));
    }
  };

  // videos.insert doesn't take paidProductPlacementDetails; an update right after does (live check
  // 2026-10-19, issue #116). The read-back lags a few seconds, so it isn't read back here.
  if (opts.paidProductPlacement === true) {
    await attempt(
      'paidPlacement',
      msg('유료 PPL 표시'),
      () =>
        ytFetch(ctx, `${API}/videos?part=paidProductPlacementDetails`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ id: videoId, paidProductPlacementDetails: { hasPaidProductPlacement: true } }),
        }),
      () => msg('YouTube Studio에서 직접 표시하세요'),
    );
  }

  if (post.thumbnailPath) {
    const path = post.thumbnailPath;
    await attempt(
      'thumbnail',
      msg('썸네일'),
      () =>
        ytFetch(ctx, `${UPLOAD_API}/thumbnails/set?videoId=${videoId}&uploadType=media`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': imageMime(path) },
          body: readFileSync(path),
        }),
      (status) => (status === 403 ? msg('맞춤 썸네일은 전화번호 인증된 채널만 가능합니다') : undefined),
    );
  }

  for (const cap of post.captions) {
    await attempt(`caption:${cap.language}`, msg('자막({language})', { language: cap.language }), () => {
      const boundary = `fanout${Date.now().toString(36)}`;
      const meta = JSON.stringify({ snippet: { videoId, language: cap.language, name: cap.name ?? '' } });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`),
        readFileSync(cap.path),
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      return ytFetch(ctx, `${UPLOAD_API}/captions?uploadType=multipart&part=snippet`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
        body,
      });
    });
  }

  if (opts.playlistId) {
    const playlistId = opts.playlistId;
    await attempt('playlist', msg('재생목록 추가'), () =>
      ytFetch(ctx, `${API}/playlistItems?part=snippet`, {
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
    throw new ProviderError('rejected', 'youtube.processing_failed', msg('YouTube 처리 실패: {reason}', { reason: video.status?.failureReason ?? 'unknown' }), video.status?.failureReason);
  }
  if (upload === 'rejected') {
    throw new ProviderError('rejected', 'youtube.rejected', msg('YouTube 거부: {reason}', { reason: video.status?.rejectionReason ?? 'unknown' }), video.status?.rejectionReason);
  }
  if (upload === 'deleted') throw new ProviderError('rejected', 'youtube.deleted', msg('영상이 삭제됐습니다'));
  const warning = forcedPrivateWarning(opts.privacy, video, Boolean(video.status?.publishAt));
  const warnings = warning ? [warning] : [];
  if (post.scheduledAt && video.status?.publishAt) warnings.push(msg('예약 게시: {publishAt}', { publishAt: video.status.publishAt }));
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
    return msg(`YouTube — 내 Google Cloud 프로젝트 만들기 (BYO)

YouTube API 정책상 오픈소스에 API 자격증명을 넣을 수 없어, 사용자마다 자기 프로젝트를 만듭니다.

1. https://console.cloud.google.com/ 에서 새 프로젝트 생성
2. "API 및 서비스 → 라이브러리"에서 YouTube Data API v3와 YouTube Analytics API 사용 설정
3. "OAuth 동의 화면": User type External, 앱 이름·이메일 입력,
   범위에 .../auth/youtube.force-ssl, .../auth/youtube.readonly, .../auth/yt-analytics.readonly 추가, 테스트 사용자에 본인 Google 계정 추가
4. ⚠ 게시 상태를 "In production"으로 바꾸세요. "Testing"이면 refresh token이 7일 만에 만료되어
   매주 다시 연결해야 합니다. (본인만 쓰는 앱은 미검증 경고 화면이 떠도 "계속"으로 진행 가능)
5. "사용자 인증 정보 → OAuth 클라이언트 ID": 애플리케이션 유형 "데스크톱 앱"
6. 받은 값을 등록:
     fanout app set youtube --clientId <ID> --clientSecret <SECRET>
   또는 내려받은 JSON 파일로:
     fanout app set youtube --file client_secret_XXXX.json
7. fanout connect youtube --name main
8. fanout doctor youtube --live 로 공개 업로드가 실제로 가능한지 확인 (테스트 영상 1개를 올렸다 지웁니다)

한도: 프로젝트당 하루 업로드 {DAILY_UPLOADS}회(태평양 시간 자정 초기화).`, { DAILY_UPLOADS });
  },

  connectMethod: 'oauth',

  async connect(ctx, name) {
    const loop = await startLoopback(0);
    const start = youtube.oauthBegin!(ctx, loop.redirectUri);
    ctx.log.info(msg('브라우저에서 업로드할 채널의 Google 계정으로 로그인하세요:\n{url}', { url: start.url }));
    openBrowser(start.url);
    let params: URLSearchParams;
    try {
      params = await waitForRedirect(loop.waitForCallback, (line) => ctx.log.info(line));
    } finally {
      loop.close();
    }
    if (params.get('state') !== start.state) throw new ProviderError('auth', 'youtube.state', msg('OAuth state 불일치'));
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
    if (!code) throw new ProviderError('auth', 'youtube.denied', msg('인증 거부: {params}', { params: params.get('error') ?? 'unknown' }));
    const tok = await tokenRequest(ctx, {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    const credentials = credsFromToken(tok, ctx.now().getTime());
    // Google lets the user untick scopes; without the manage scope nothing can be uploaded.
    if (credentials.scope && !credentials.scope.split(' ').includes(MANAGE_SCOPE)) {
      throw new ProviderError('auth', 'youtube.partial_grant', msg('YouTube 관리 권한(youtube.force-ssl)을 승인하지 않았습니다 — 다시 연결하면서 모든 항목을 체크하세요'));
    }
    const account: Account = { platform: 'youtube', name, credentials: { ...credentials }, profile: {} };
    const ch = await api<{ items?: Array<{ id: string; snippet: { title: string } }> }>(ctx, account, '/channels?part=snippet&mine=true');
    const channel = ch.items?.[0];
    if (!channel) throw new ProviderError('rejected', 'youtube.no_channel', msg('이 Google 계정에 YouTube 채널이 없습니다'));
    account.profile = { channelId: channel.id, channelTitle: channel.snippet.title };
    if (credentials.refreshTokenExpiresAt) {
      ctx.log.warn(msg('이 refresh token은 만료 기한이 있습니다. OAuth 동의 화면이 "Testing"이면 7일 뒤 다시 연결해야 합니다.'));
    }
    return account;
  },

  async refresh(ctx, account) {
    const c = creds(account);
    // Ten minutes of headroom so an upload rarely starts on an almost-expired token.
    if (c.expiresAt - ctx.now().getTime() > 600_000) return account;
    const { clientId, clientSecret } = app(ctx);
    const tok = await tokenRequest(ctx, {
      refresh_token: c.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });
    // Spread the old credentials first: they also carry fanout's upkeep marks (core/accounts.ts).
    const next: Account = { ...account, credentials: { ...account.credentials, ...credsFromToken(tok, ctx.now().getTime(), c) } };
    // Only over the same grant: the account may have been disconnected or reconnected meanwhile.
    ctx.store.saveAccountIf(next, (stored) => creds(stored).refreshToken === c.refreshToken);
    return next;
  },

  // Developer Policies III.D.2: a disconnect through the client revokes the token right away.
  async disconnect(ctx, account) {
    const channelId = account.profile.channelId;
    const twin = channelId === undefined ? undefined : ctx.store.listAccounts().find((a) => a.platform === 'youtube' && a.name !== account.name && a.profile.channelId === channelId);
    // Revoking ends Google's grant to the app for that user, which the other account shares.
    if (twin) {
      ctx.log.warn(msg('youtube/{name}과(와) 같은 채널이라 토큰은 철회하지 않았습니다 (youtube/{twin}이 계속 씁니다)', { name: account.name, twin: twin.name }));
      return false;
    }
    const c = creds(account);
    const token = c.refreshToken || c.accessToken;
    if (!token) return false;
    const res = await ytFetch(ctx, REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      // A dashboard request waits on this: don't hang it on a stuck endpoint.
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return true;
    const body = (await jsonOr(res, {})) as GoogleError;
    // Already expired or revoked: nothing left to revoke.
    if (res.status === 400 && body.error === 'invalid_token') return true;
    throw new ProviderError(kindForStatus(res.status), 'youtube.revoke', describeGoogle(body).message ?? `HTTP ${res.status}`, describeGoogle(body).code);
  },

  async limits({ ctx }) {
    const now = ctx.now();
    const used = ctx.store.getUsage('youtube', 'project', pacificDay(now));
    const units = ctx.store.getUsage('youtube', 'units', pacificDay(now));
    return [
      {
        what: msg('하루 업로드 (프로젝트 전체)'),
        unit: 'posts',
        used,
        total: DAILY_UPLOADS,
        remaining: Math.max(0, DAILY_UPLOADS - used),
        resetsAt: nextPacificMidnight(now).toISOString(),
        note: msg('fanout이 올린 것만 센 로컬 집계'),
      },
      {
        what: msg('하루 API 단위 (프로젝트 전체)'),
        unit: 'posts',
        used: units,
        total: DAILY_UNITS,
        remaining: Math.max(0, DAILY_UNITS - units),
        resetsAt: nextPacificMidnight(now).toISOString(),
        note: msg('자막 400, 썸네일·재생목록·수정 50, 조회 1. fanout이 쓴 것만 센 로컬 집계'),
      },
    ];
  },

  // A post's own quota bill, checked against what is left today (captions are the costly part).
  async previewChecks({ ctx, post, target }) {
    const o = target.options as unknown as YouTubeOptions;
    const cost = postUnits(post, o);
    const left = DAILY_UNITS - ctx.store.getUsage('youtube', 'units', pacificDay(ctx.now()));
    if (cost <= left) return [];
    return [{ severity: 'warning', code: 'quota_units', message: msg('이 게시물은 API 단위를 약 {cost} 쓰는데 오늘 남은 단위는 {left}입니다. 자막·썸네일이 실패하거나 내일로 밀릴 수 있습니다', { cost, left: Math.max(0, left) }) }];
  },

  async listPlaylists({ ctx, account }) {
    const acct = await youtube.refresh(ctx, account);
    const res = await api<{ items?: Array<{ id: string; snippet?: { title?: string } }> }>(ctx, acct, '/playlists?part=snippet&mine=true&maxResults=50');
    return (res.items ?? []).map((p) => ({ id: p.id, title: p.snippet?.title ?? p.id }));
  },

  // III.E.4.b–c: statistics may be kept while authorization is re-checked every 30 days, and the
  // channel title re-read within 30 days. One channels.list call (1 quota unit) does both.
  async verify(ctx, account) {
    const acct = await youtube.refresh(ctx, account);
    const ch = await api<{ items?: Array<{ id: string; snippet: { title: string } }> }>(ctx, acct, '/channels?part=snippet&mine=true');
    const channel = ch.items?.[0];
    if (!channel) throw new ProviderError('rejected', 'youtube.no_channel', msg('이 Google 계정에 YouTube 채널이 없습니다'));
    return { ...acct, profile: { channelId: channel.id, channelTitle: channel.snippet.title } };
  },

  // III.D.2 / III.E.4.g: once access ends, the reactions read through the API go.
  forget(ctx, account) {
    ctx.store.purgeAccountStats('youtube', account.name);
  },

  validate(post, target, media) {
    const issues: Issue[] = [];
    const o = target.options as Partial<YouTubeOptions>;
    // Options fanout once accepted but YouTube's API can't set: say so instead of dropping them quietly
    // (a paid-promotion disclosure has legal weight).
    const chapters = chapterProblems(post.description);
    if (chapters.length) issues.push({ severity: 'warning', code: 'chapters', message: msg('설명의 타임스탬프로는 YouTube 챕터가 만들어지지 않습니다: {problems}', { problems: chapters.join(' / ') }) });
    // A real calendar day (Date.parse would take 2026-02-30 as 2 March).
    const realDay = (d: string) => RECORDING_DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
    if (o.recordingDate !== undefined && !(typeof o.recordingDate === 'string' && realDay(o.recordingDate))) {
      issues.push({ severity: 'error', code: 'recording_date', message: msg('recordingDate는 YYYY-MM-DD 날짜') });
    }
    if (o.paidProductPlacement !== undefined && typeof o.paidProductPlacement !== 'boolean') {
      issues.push({ severity: 'error', code: 'paid_placement', message: msg('paidProductPlacement는 true 또는 false') });
    }
    const unsettable = ['paidPromotion', 'audioLanguage'].filter((k) => k in (target.options ?? {}));
    if (unsettable.length) {
      issues.push({ severity: 'warning', code: 'unsettable', message: msg('YouTube API로 설정할 수 없어 적용되지 않습니다: {keys}. YouTube Studio에서 직접 설정하세요', { keys: unsettable.join(', ') }) });
    }
    if (!o.privacy || !['public', 'unlisted', 'private'].includes(o.privacy)) {
      issues.push({ severity: 'error', code: 'privacy', message: msg('YouTube 공개 범위(public/unlisted/private)를 직접 지정해야 합니다') });
    }
    if (typeof o.madeForKids !== 'boolean') {
      issues.push({ severity: 'error', code: 'made_for_kids', message: msg('YouTube "아동용 여부"(madeForKids yes/no)를 지정해야 합니다') });
    }
    // publishAt in the past is refused; e.g. a platform added to a post after its scheduled time. An
    // upload already under way set publishAt when it started, so resuming it is fine.
    const started = Boolean((target.resume as { sessionUri?: string; videoId?: string } | undefined)?.sessionUri || (target.resume as { videoId?: string } | undefined)?.videoId);
    if (post.scheduledAt && !started && !scheduleAhead(post)) {
      issues.push({ severity: 'warning', code: 'schedule_past', message: msg('YouTube 예약 시각이 이미 지나 예약 없이 바로 게시합니다') });
    }
    if (scheduleAhead(post) && o.privacy && o.privacy !== 'public') {
      issues.push({ severity: 'error', code: 'schedule_privacy', message: msg('YouTube 예약 게시는 public으로 공개되는 경우만 지원합니다') });
    }
    if (!post.title.trim()) issues.push({ severity: 'error', code: 'title', message: msg('YouTube 제목이 비어 있습니다') });
    if ([...post.title].length > 100) issues.push({ severity: 'error', code: 'title', message: msg('YouTube 제목은 100자 이하') });
    if (/[<>]/.test(post.title) || /[<>]/.test(post.description)) {
      issues.push({ severity: 'error', code: 'angle_brackets', message: msg('YouTube 제목·설명에 < > 문자를 쓸 수 없습니다') });
    }
    if (Buffer.byteLength(post.description) > 5000) issues.push({ severity: 'error', code: 'description', message: msg('YouTube 설명은 5000바이트 이하') });
    if (post.tags.join(',').length > 500) issues.push({ severity: 'error', code: 'tags', message: msg('YouTube 태그 합계 500자 이하') });
    if (o.license !== undefined && o.license !== 'youtube' && o.license !== 'creativeCommon') {
      issues.push({ severity: 'error', code: 'license', message: msg('YouTube 라이선스는 youtube 또는 creativeCommon') });
    }
    // Shape checked too: options can come from MCP or a watch-folder JSON.
    const raw = o.localizations as unknown;
    const localizations = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw as Record<string, unknown>) : [];
    if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
      issues.push({ severity: 'error', code: 'localizations', message: msg('localizations 형식: {"en": {"title": "…", "description": "…"}}') });
    }
    if (localizations.length && !o.defaultLanguage) {
      issues.push({ severity: 'error', code: 'localizations', message: msg('다른 언어 제목·설명을 쓰려면 기본 언어(defaultLanguage)를 정해야 합니다') });
    }
    for (const [lang, value] of localizations) {
      const l = value as { title?: unknown; description?: unknown } | null;
      const title = typeof l?.title === 'string' ? l.title : '';
      const description = l?.description === undefined ? '' : typeof l.description === 'string' ? l.description : null;
      if (!title.trim() || [...title].length > 100 || description === null || Buffer.byteLength(description) > 5000) {
        issues.push({ severity: 'error', code: 'localizations', message: msg('{lang} 제목은 1~100자, 설명은 5000바이트 이하여야 합니다', { lang }) });
      }
    }
    if (post.thumbnailPath && statSync(post.thumbnailPath).size > 2 * 1024 * 1024) {
      issues.push({ severity: 'error', code: 'thumbnail', message: msg('YouTube 썸네일은 2MB 이하') });
    }
    // A vertical fit makes it a Short too, as long as it's short enough.
    if (isShort(media) || ((target.options as { fit?: string }).fit && media.durationSec <= 180)) {
      issues.push({ severity: 'warning', code: 'shorts', message: msg('3분 이하 세로/정사각형 영상이라 YouTube가 Shorts로 분류합니다') });
    }
    return issues;
  },

  async publish({ ctx, post, target, account: initial, mediaPath, media, saveResume }): Promise<PublishOutcome> {
    let account = initial;
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
          ctx.log.info(msg('youtube: {offset} 바이트부터 이어 올립니다', { offset }));
        }
      }
      if (!video) {
        if (!sessionUri) {
          const day = pacificDay(ctx.now());
          const used = ctx.store.getUsage('youtube', 'project', day);
          if (used >= DAILY_UPLOADS) {
            throw new ProviderError('rejected', 'youtube.quota', msg('오늘 업로드 {used}/{DAILY_UPLOADS}회를 이미 썼습니다 (로컬 집계)', { used, DAILY_UPLOADS }), undefined, {
              retryAt: quotaReset(ctx.now()),
            });
          }
          sessionUri = await startSession(ctx, account, post, opts, size);
          saveResume({ sessionUri, size });
          ctx.store.bumpUsage('youtube', 'project', day);
        }
        try {
          video = await uploadBytes(ctx, account, sessionUri, mediaPath, size, offset);
        } catch (err) {
          // The access token expired mid-upload (they last an hour): refresh, ask the session how far
          // it got, and carry on instead of sending the target to needs_reauth.
          if (!(err instanceof ProviderError) || err.code !== 'youtube.http_401') throw err;
          account = await youtube.refresh(ctx, { ...account, credentials: { ...account.credentials, expiresAt: 0 } });
          const state = await querySession(ctx, account, sessionUri, size);
          if ('expired' in state) throw new ProviderError('retryable', 'youtube.session_expired', msg('업로드 세션이 만료돼 처음부터 다시 올립니다'));
          video = 'video' in state ? state.video : await uploadBytes(ctx, account, sessionUri, mediaPath, size, state.offset);
        }
      }
      saveResume({ videoId: video.id });
    }

    const done = [...(resume.extras ?? [])];
    const warnings = await applyExtras(
      ctx,
      account,
      post,
      opts,
      video.id,
      done,
      (key) => {
        done.push(key);
        saveResume({ videoId: video.id, extras: [...done] });
      },
      (key) => {
        if (done.includes(key)) done.splice(done.indexOf(key), 1);
        saveResume({ videoId: video.id, extras: [...done] });
      },
    );
    const outcome: PublishOutcome = video.status
      ? outcomeFor(video, post, opts, short)
      : { state: 'processing', remoteId: video.id, remoteUrl: videoUrl(video.id, short) };
    return { ...outcome, warnings: [...warnings, ...(outcome.warnings ?? [])] };
  },

  async poll({ ctx, post, target, account }): Promise<PollOutcome> {
    const res = await api<{ items?: VideoResource[] }>(ctx, account, `/videos?part=status,processingDetails&id=${target.remoteId}`);
    const video = res.items?.[0];
    if (!video) throw new ProviderError('rejected', 'youtube.not_found', msg('영상 {remoteId}을 찾을 수 없습니다 (삭제됨?)', { remoteId: target.remoteId }));
    const short = target.remoteUrl?.includes('/shorts/') ?? false;
    return outcomeFor(video, post, options(target), short);
  },

  signInExpiresAt(account) {
    return creds(account).refreshTokenExpiresAt;
  },

  async doctor({ ctx, account, live }): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    try {
      app(ctx);
      checks.push({ name: msg('BYO 앱'), status: 'ok', detail: msg('OAuth client 등록됨') });
    } catch (err) {
      checks.push({ name: msg('BYO 앱'), status: 'fail', detail: (err as Error).message });
      return checks;
    }

    let acct = account;
    try {
      acct = await youtube.refresh(ctx, { ...account, credentials: { ...account.credentials, expiresAt: 0 } });
      checks.push({ name: msg('토큰 갱신'), status: 'ok', detail: msg('refresh token 유효') });
    } catch (err) {
      checks.push({ name: msg('토큰 갱신'), status: 'fail', detail: (err as Error).message });
      return checks;
    }

    const rtExp = creds(acct).refreshTokenExpiresAt;
    checks.push(
      rtExp
        ? {
            name: msg('refresh token 수명'),
            status: 'warn',
            detail: msg('만료 예정 {date} — 동의 화면이 "Testing"이면 "In production"으로 바꾸고 다시 연결하세요', { date: new Date(rtExp).toISOString() }),
          }
        : { name: msg('refresh token 수명'), status: 'ok', detail: msg('만료 기한 없음 (In production으로 보임)') },
    );

    if (!mayReadAnalytics(acct)) {
      checks.push({ name: msg('분석 통계'), status: 'info', detail: msg('yt-analytics.readonly 권한이 없습니다 — 시청 시간 통계를 보려면 fanout connect youtube로 다시 연결하세요') });
    } else {
      // One cheap report (today, channel views) shows whether the API is on and the grant works.
      const day = pacificDay(ctx.now());
      try {
        await api(ctx, acct, `${ANALYTICS_API}/reports?${new URLSearchParams({ ids: 'channel==MINE', startDate: day, endDate: day, metrics: 'views' })}`);
        checks.push({ name: msg('분석 통계'), status: 'ok', detail: msg('yt-analytics.readonly 권한 있음 (시청 시간·평균 시청·구독 증가)') });
      } catch (err) {
        checks.push({ name: msg('분석 통계'), status: 'warn', detail: analyticsProblem(err, acct) ?? (err as Error).message });
      }
    }

    const ch = await api<{ items?: Array<{ id: string; snippet: { title: string }; status?: { longUploadsStatus?: string } }> }>(
      ctx,
      acct,
      '/channels?part=snippet,status&mine=true',
    );
    const channel = ch.items?.[0];
    checks.push({ name: msg('채널'), status: channel ? 'ok' : 'fail', detail: channel ? `${channel.snippet.title} (${channel.id})` : msg('채널 없음') });
    if (channel?.status?.longUploadsStatus && channel.status.longUploadsStatus !== 'allowed') {
      checks.push({ name: msg('15분 초과 업로드'), status: 'warn', detail: msg('longUploadsStatus={longUploadsStatus} — 전화번호 인증 필요', { longUploadsStatus: channel.status.longUploadsStatus }) });
    }

    const used = ctx.store.getUsage('youtube', 'project', pacificDay(ctx.now()));
    checks.push({ name: msg('오늘 업로드 (로컬 집계)'), status: used >= DAILY_UPLOADS ? 'fail' : 'info', detail: `${used}/${DAILY_UPLOADS}` });

    if (!live) {
      checks.push({
        name: msg('미검증 프로젝트 공개 업로드'),
        status: 'info',
        detail: msg('확인하려면 --live 로 다시 실행 (일부 공개 테스트 영상을 올리고 지웁니다)'),
      });
      return checks;
    }

    // Open question from the research: does an unverified project's upload still get locked to private?
    // The test video and the clip are removed whatever happens on the way.
    const clip = join(tmpdir(), `fanout-doctor-${Date.now()}.mp4`);
    let videoId: string | undefined;
    let removed = false;
    let uploading = false;
    let step = msg('테스트 업로드');
    const removeVideo = async (id: string) => {
      const del = await ytFetch(ctx, `${API}/videos?id=${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${creds(acct).accessToken}` } });
      return del.ok || del.status === 404 ? undefined : del.status;
    };
    try {
      await makeTestClip(clip);
      const media = await probe(clip);
      const post: Post = {
        id: 'doctor',
        createdAt: ctx.now().toISOString(),
        mediaPath: clip,
        title: msg('fanout doctor test (자동 삭제)'),
        description: msg('fanout doctor --live 가 업로드 동작을 확인하려고 올린 테스트 영상입니다.'),
        tags: [],
        captions: [],
        containsSyntheticMedia: false,
      };
      const opts: YouTubeOptions = { privacy: 'unlisted', madeForKids: false, notifySubscribers: false };
      const day = pacificDay(ctx.now());
      const session = await startSession(ctx, acct, post, opts, media.sizeBytes);
      ctx.store.bumpUsage('youtube', 'project', day);
      uploading = true;
      let video = await uploadBytes(ctx, acct, session, clip, media.sizeBytes, 0);
      videoId = video.id;
      checks.push({ name: msg('테스트 업로드'), status: 'ok', detail: msg('videoId={id}, 요청 unlisted → 응답 {privacyStatus}', { id: video.id, privacyStatus: video.status?.privacyStatus }) });

      step = msg('미검증 프로젝트 공개 업로드');
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
              name: msg('미검증 프로젝트 공개 업로드'),
              status: 'fail',
              detail: msg('처리 후 privacyStatus=private (uploadStatus={uploadStatus}). 비공개 고정 규칙이 아직 적용됩니다 — YouTube API audit 신청 필요', { uploadStatus: video.status?.uploadStatus }),
            }
          : {
              name: msg('미검증 프로젝트 공개 업로드'),
              status: video.status?.uploadStatus === 'processed' ? 'ok' : 'warn',
              detail:
                video.status?.uploadStatus === 'processed'
                  ? msg('privacyStatus={privacy}, uploadStatus={uploadStatus}. 비공개로 고정되지 않았습니다', { privacy, uploadStatus: video.status?.uploadStatus })
                  : msg('privacyStatus={privacy}, uploadStatus={uploadStatus}. 비공개로 고정되지 않았습니다 (처리 미완료 — 나중에 Studio에서 한 번 더 확인)', {
                      privacy,
                      uploadStatus: video.status?.uploadStatus,
                    }),
            },
      );
    } catch (err) {
      checks.push({ name: step, status: 'fail', detail: err instanceof Error ? err.message : String(err) });
    } finally {
      if (videoId) {
        const failed = await removeVideo(videoId).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
        removed = failed === undefined;
        checks.push({
          name: msg('테스트 영상 삭제'),
          status: removed ? 'ok' : 'warn',
          detail: removed ? msg('삭제함') : msg('삭제 실패 HTTP {status} — Studio에서 직접 지우세요: https://youtu.be/{id}', { status: failed, id: videoId }),
        });
      }
      // The upload may have landed with its answer lost: there is no id to delete, so say where to look.
      if (!videoId && uploading) checks.push({ name: msg('테스트 영상 삭제'), status: 'warn', detail: msg('업로드 응답을 받지 못했습니다. YouTube Studio에 "fanout doctor test" 영상이 있으면 지우세요') });
      rmSync(clip, { force: true });
    }
    return checks;
  },

  async stats({ ctx, account, target }) {
    const res = await api<{ items?: Array<{ statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }> }>(
      ctx,
      account,
      `/videos?part=statistics&id=${target.remoteId}`,
    );
    const st = res.items?.[0]?.statistics;
    if (!st) return { note: msg('영상을 찾을 수 없습니다 (삭제됐거나 비공개)') };
    const n = (v?: string) => (v === undefined ? undefined : Number(v));
    const deeper = await analytics(ctx, account, target);
    return definedOnly({ views: n(st.viewCount), likes: n(st.likeCount), comments: n(st.commentCount), ...deeper.values, ...(deeper.note ? { note: deeper.note } : {}) });
  },

  async remove({ ctx, account, target }) {
    const res = await ytFetch(ctx, `${API}/videos?id=${target.remoteId}`, { method: 'DELETE', headers: { authorization: `Bearer ${creds(account).accessToken}` } });
    if (res.ok || res.status === 404) return;
    throw await uploadError(res, ctx.now());
  },

  // videos.update replaces the whole snippet, so start from the current one (title and categoryId are
  // required) and change only what fanout owns.
  // Held for review rather than rejected: a held comment can be published again, a rejected one can't.
  async hideComment({ ctx, account, commentId, hidden }) {
    const status = hidden ? 'heldForReview' : 'published';
    await api(ctx, account, `/comments/setModerationStatus?${new URLSearchParams({ id: commentId, moderationStatus: status })}`, { method: 'POST' });
  },

  commentsKnowAnswers: true,

  visibilities: ['public', 'unlisted', 'private'],

  async setVisibility({ ctx, account, target, visibility, publishAt }) {
    const res = await api<{ items?: Array<{ status?: Record<string, unknown> }> }>(ctx, account, `/videos?part=status&id=${target.remoteId}`);
    const current = res.items?.[0]?.status;
    if (!current) throw new ProviderError('rejected', 'youtube.not_found', msg('영상을 찾을 수 없습니다'));
    // YouTube takes publishAt only on a private video that was never published.
    if (publishAt && current.privacyStatus !== 'private') {
      throw new ProviderError('rejected', 'youtube.publish_at', msg('예약 공개는 비공개 영상에만 걸 수 있습니다 (지금: {privacy})', { privacy: String(current.privacyStatus) }));
    }
    // videos.update replaces the whole status: carry over the settable fields being kept.
    const keep = ['embeddable', 'license', 'publicStatsViewable', 'selfDeclaredMadeForKids', 'containsSyntheticMedia'];
    const status: Record<string, unknown> = Object.fromEntries(keep.filter((k) => current[k] !== undefined).map((k) => [k, current[k]]));
    // A scheduled publish is a private video with publishAt; YouTube makes it public then.
    status.privacyStatus = publishAt ? 'private' : visibility;
    if (publishAt) status.publishAt = new Date(publishAt).toISOString();
    const out = await api<{ status?: { privacyStatus?: string; publishAt?: string } }>(ctx, account, '/videos?part=status', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: target.remoteId, status }),
    });
    // What YouTube actually set (an unverified project may keep it private), not what was asked.
    return { visibility: out.status?.privacyStatus ?? String(status.privacyStatus), publishAt: out.status?.publishAt ?? (status.publishAt as string | undefined) };
  },

  async update({ ctx, account, target, post }) {
    const res = await api<{ items?: Array<{ snippet: Record<string, unknown> }> }>(ctx, account, `/videos?part=snippet&id=${target.remoteId}`);
    const snippet = res.items?.[0]?.snippet;
    if (!snippet) throw new ProviderError('rejected', 'youtube.not_found', msg('영상을 찾을 수 없습니다'));
    const { title, description, tags, categoryId, defaultLanguage } = { ...snippet, title: post.title, description: post.description, tags: post.tags } as Record<string, unknown>;
    // videos.update replaces the whole snippet: carry over the settable fields fanout doesn't edit.
    await api(ctx, account, '/videos?part=snippet', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: target.remoteId, snippet: { title, description, tags, categoryId, ...(defaultLanguage ? { defaultLanguage } : {}) } }),
    });
  },

  async comments({ ctx, account, target, limit }) {
    type Snippet = { authorDisplayName?: string; authorChannelId?: { value?: string }; textOriginal?: string; textDisplay?: string; publishedAt: string; likeCount?: number };
    const res = await api<{
      items?: Array<{
        id: string;
        snippet: { totalReplyCount?: number; topLevelComment: { id?: string; snippet: Snippet } };
        replies?: { comments?: Array<{ snippet?: Snippet }> };
      }>;
      // textOriginal is only returned to the comment's own author; textDisplay in plain text otherwise.
    }>(ctx, account, `/commentThreads?part=snippet,replies&order=time&textFormat=plainText&maxResults=${Math.min(limit, 100)}&videoId=${target.remoteId}`).catch((err: unknown) => {
      // Comments turned off (or the video is gone) isn't an error worth failing the panel for.
      if (err instanceof ProviderError && err.platformCode === 'commentsDisabled') return { items: [] };
      throw err;
    });
    const channel = account.profile.channelId as string | undefined;
    return (res.items ?? []).map((t) => {
      const c = t.snippet.topLevelComment.snippet;
      // Replies take the top-level comment's id as parentId (in practice the same as the thread's).
      const id = t.snippet.topLevelComment.id ?? t.id;
      // The thread carries up to five replies: one from the channel answers it; with more than five
      // and none of those from the channel, it can't be told.
      const replies = t.replies?.comments ?? [];
      const byChannel = channel !== undefined && replies.some((r) => r.snippet?.authorChannelId?.value === channel);
      const total = t.snippet.totalReplyCount ?? replies.length;
      return {
        id,
        author: c.authorDisplayName ?? '',
        text: c.textOriginal ?? c.textDisplay ?? '',
        at: c.publishedAt,
        likes: c.likeCount,
        replies: t.snippet.totalReplyCount,
        url: `https://www.youtube.com/watch?v=${target.remoteId}&lc=${id}`,
        ...(channel !== undefined ? { mine: c.authorChannelId?.value === channel } : {}),
        ...(channel === undefined ? {} : byChannel ? { answered: true } : total <= replies.length ? { answered: false } : {}),
      };
    });
  },

  commentRules: {
    max: 10_000,
    refuses: (o) => (o.madeForKids === true ? msg('첫 댓글: YouTube 아동용 영상에는 댓글이 꺼져 있어 달 수 없습니다') : undefined),
  },

  // A new thread on the video, as the channel. Comments must be on (not "made for kids").
  async postComment({ ctx, account, target, text, sending }) {
    sending();
    const res = await api<{ id: string }>(ctx, account, '/commentThreads?part=snippet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snippet: { videoId: target.remoteId, topLevelComment: { snippet: { textOriginal: text } } } }),
    });
    return { id: res.id, url: `https://www.youtube.com/watch?v=${target.remoteId}&lc=${res.id}` };
  },

  // comments.insert with parentId; the thread id from comments() is the top-level comment's id.
  async reply({ ctx, account, target, comment, text, sending }) {
    sending();
    const res = await api<{ id: string }>(ctx, account, '/comments?part=snippet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snippet: { parentId: comment.id, textOriginal: text } }),
    });
    return { id: res.id, url: `https://www.youtube.com/watch?v=${target.remoteId}&lc=${res.id}` };
  },
};
