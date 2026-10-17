import { openAsBlob, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ProviderError, kindForStatus } from '../core/errors.ts';
import { imageMime, readChunk } from '../core/http.ts';
import type { DoctorCheck, PollOutcome, Provider, ProviderContext, PublishOutcome } from '../core/provider.ts';
import type { Account } from '../core/store.ts';
import type { Comment, Issue, Post } from '../core/types.ts';
import { htmlToText } from './mastodon.ts';

// Docs: https://docs.joinpeertube.org/api-rest-reference.html (OpenAPI: support/doc/api/openapi.yaml)
//       https://docs.joinpeertube.org/api/rest-getting-started (OAuth client + password grant)
//       resumable upload follows https://github.com/kukhariev/node-uploadx/blob/master/proto.md

/** Chunks of 8 MiB, or 1/10,000 of the file if larger (newer instances require that), below proxy limits. */
const MIN_CHUNK = 8 * 1024 * 1024;
const NAME_MIN = 3;
const NAME_MAX = 120;
const DESCRIPTION_MAX = 10_000;
const TAGS_MAX = 5;
const TAG_MIN = 2;
const TAG_MAX = 30;

const PRIVACY = { public: 1, unlisted: 2, private: 3, internal: 4 } as const;
type Privacy = keyof typeof PRIVACY;
const COMMENTS_POLICY = { enabled: 1, disabled: 2, approval: 3 } as const;

/** state.id values (packages/models/src/videos/video-state.enum.ts). */
const STATE_PUBLISHED = 1;
const STATE_WORKING = new Set([2, 3, 6, 9, 10]);
const STATE_FAILED: Record<number, string> = { 7: '트랜스코딩 실패', 8: '외부 저장소 이동 실패', 11: '파일 시스템 이동 실패', 12: '가져오기 실패' };

export interface PeerTubeCredentials {
  instance: string;
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  /** ms epoch */
  expiresAt: number;
}

export interface PeerTubeOptions {
  privacy: Privacy;
  /** Channel name (handle) or numeric id; default: the account's first channel. */
  channel?: string;
  commentsPolicy?: keyof typeof COMMENTS_POLICY;
  nsfw?: boolean;
  downloadEnabled?: boolean;
  /** Language id, e.g. "ko". */
  language?: string;
  category?: number;
  licence?: number;
}

interface Channel {
  id: number;
  name: string;
  displayName?: string;
}

interface PeerTubeResume {
  /** Absolute resumable session URL (…/upload-resumable?upload_id=…). */
  location?: string;
  total?: number;
  /** The last chunk was sent: if the session is gone now, the video may exist. */
  finalSent?: boolean;
  videoId?: number;
  shortUUID?: string;
  extrasDone?: boolean;
  instance?: string;
  userId?: number;
  /** Channel and start time of the session, to find the video if the last chunk's answer was lost. */
  channelId?: number;
  startedAt?: string;
}

function creds(account: Account): PeerTubeCredentials {
  return account.credentials as unknown as PeerTubeCredentials;
}

export function normalizePeerTubeInstance(raw: string): string {
  const url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new ProviderError('rejected', 'peertube.insecure', '인스턴스 주소는 https여야 합니다');
  }
  return url.origin;
}

interface ApiError {
  detail?: string;
  title?: string;
  /** A string from the REST API and OAuth, an object from the resumable upload endpoint (uploadx). */
  error?: string | { code?: string; message?: string };
  code?: string;
}

function apiError(status: number, body: ApiError | undefined, what: string): ProviderError {
  const inner = typeof body?.error === 'object' ? body.error : undefined;
  const text = typeof body?.error === 'string' ? body.error : undefined;
  const code = body?.code ?? inner?.code ?? text;
  const msg = body?.detail ?? inner?.message ?? text ?? body?.title ?? `HTTP ${status}`;
  // platformCode always starts with the HTTP status, so a 404 is recognisable whatever the body says.
  return new ProviderError(kindForStatus(status), `peertube.${code ?? `http_${status}`}`, `PeerTube ${what}: ${msg}`, code ? `${status}/${code}` : String(status));
}

const notFound = (err: unknown): boolean => err instanceof ProviderError && /^404(\/|$)/.test(err.platformCode ?? '');

async function api<T>(ctx: ProviderContext, c: PeerTubeCredentials, path: string, init: RequestInit & { allow?: number[] } = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await ctx.fetch(`${c.instance}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${c.accessToken}`, ...(init.headers as Record<string, string>) },
  });
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok && !(init.allow ?? []).includes(res.status)) throw apiError(res.status, body as ApiError, path.split('?')[0]!);
  return { status: res.status, body: body as T, headers: res.headers };
}

async function tokenRequest(ctx: ProviderContext, instance: string, form: Record<string, string>, otp?: string): Promise<{ access_token: string; refresh_token: string; expires_in?: number }> {
  const res = await ctx.fetch(`${instance}/api/v1/users/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(otp ? { 'x-peertube-otp': otp } : {}) },
    body: new URLSearchParams(form),
  });
  const body = (await res.json().catch(() => ({}))) as ApiError & { access_token?: string; refresh_token?: string; expires_in?: number };
  if (res.ok && body.access_token && body.refresh_token) return body as { access_token: string; refresh_token: string; expires_in?: number };
  const code = body.code ?? (typeof body.error === 'string' ? body.error : body.error?.code);
  if (code === 'missing_two_factor') throw new ProviderError('rejected', 'peertube.otp', '2단계 인증이 켜진 계정입니다. 인증 앱의 코드(otp)를 함께 넣어 주세요');
  if (code === 'invalid_grant' || code === 'invalid_token' || res.status === 400 || res.status === 401) {
    throw new ProviderError('auth', `peertube.${code ?? 'invalid_grant'}`, `PeerTube 로그인이 만료됐거나 거부됐습니다. 다시 연결하세요 (${body.detail ?? code ?? res.status})`, code);
  }
  throw apiError(res.status, body, 'token');
}

function fromToken(c: Omit<PeerTubeCredentials, 'accessToken' | 'refreshToken' | 'expiresAt'>, tok: { access_token: string; refresh_token: string; expires_in?: number }, now: number): PeerTubeCredentials {
  return { ...c, accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: now + (tok.expires_in ?? 86_400) * 1000 };
}

interface Me {
  id: number;
  username: string;
  account?: { id?: number; name?: string };
  videoChannels?: Channel[];
  videoQuota?: number;
  videoQuotaDaily?: number;
}

function channelFor(account: Account, o: Partial<PeerTubeOptions>, channels: Channel[]): Channel | undefined {
  if (!o.channel) return channels[0];
  const want = String(o.channel).replace(/^@/, '');
  return channels.find((ch) => String(ch.id) === want || ch.name === want);
}

/** Tags PeerTube accepts: at most 5, each 2–30 characters, no duplicates. */
export function peertubeTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.replace(/^#/, '').trim();
    // The server counts characters, not UTF-16 units (an emoji is one).
    const n = chars(t);
    if (n < TAG_MIN || n > TAG_MAX || out.includes(t)) continue;
    out.push(t);
    if (out.length === TAGS_MAX) break;
  }
  return out;
}

const chars = (s: string): number => [...s].length;

function description(post: Post): string | undefined {
  const d = post.description.trim();
  // PeerTube refuses descriptions under 3 characters; leave it out instead.
  return chars(d) >= 3 ? [...d].slice(0, DESCRIPTION_MAX).join('') : undefined;
}

function watchUrl(instance: string, shortUUID: string | undefined, id: number | string): string {
  return shortUUID ? `${instance}/w/${shortUUID}` : `${instance}/videos/watch/${id}`;
}

/** Refuse to act on a video through a connection to another instance or another user. */
function assertOwner(account: Account, target: { resume?: Record<string, unknown> }): void {
  const r = (target.resume ?? {}) as PeerTubeResume;
  const c = creds(account);
  if (r.instance && r.instance !== c.instance) {
    throw new ProviderError('rejected', 'peertube.other_instance', `이 영상은 ${r.instance} 에 올렸는데 지금 ${account.name} 계정은 ${c.instance} 에 연결돼 있습니다`);
  }
  const userId = account.profile.userId as number | undefined;
  if (r.userId && userId && r.userId !== userId) {
    throw new ProviderError('rejected', 'peertube.not_owner', `이 영상은 지금 연결된 계정(${String(account.profile.username ?? account.name)})이 올린 영상이 아닙니다`);
  }
}

/** Server version as [major, minor], from /api/v1/config. */
async function serverVersion(ctx: ProviderContext, c: PeerTubeCredentials): Promise<[number, number] | undefined> {
  const { body } = await api<{ serverVersion?: string }>(ctx, c, '/api/v1/config').catch(() => ({ body: {} as { serverVersion?: string } }));
  const m = /^(\d+)\.(\d+)/.exec(body.serverVersion ?? '');
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** Thumbnail and captions go on after the upload; both are replace-in-place, so redoing them is harmless. */
async function applyExtras(ctx: ProviderContext, c: PeerTubeCredentials, post: Post, videoId: number): Promise<string[]> {
  const warnings: string[] = [];
  if (post.thumbnailPath) {
    const form = new FormData();
    // PeerTube checks the part's MIME type, not just the file name.
    form.set('thumbnailfile', await openAsBlob(post.thumbnailPath, { type: imageMime(post.thumbnailPath) }), basename(post.thumbnailPath));
    await api(ctx, c, `/api/v1/videos/${videoId}`, { method: 'PUT', body: form }).catch((err: Error) => warnings.push(`썸네일을 올리지 못했습니다: ${err.message}`));
  }
  for (const cap of post.captions) {
    const form = new FormData();
    const type = extname(cap.path).toLowerCase() === '.srt' ? 'application/x-subrip' : 'text/vtt';
    form.set('captionfile', await openAsBlob(cap.path, { type }), basename(cap.path));
    await api(ctx, c, `/api/v1/videos/${videoId}/captions/${encodeURIComponent(cap.language)}`, { method: 'PUT', body: form }).catch((err: Error) =>
      warnings.push(`자막(${cap.language})을 올리지 못했습니다: ${err.message}`),
    );
  }
  return warnings;
}

/** The byte offset the server has, or the finished video if the last chunk already landed. */
type Put = (headers: Record<string, string>, body?: Buffer) => Promise<Response>;

async function uploadOffset(put: Put, total: number): Promise<number | { id: number; shortUUID?: string }> {
  const res = await put({ 'content-length': '0', 'content-range': `bytes */${total}` });
  if (res.status === 308) return nextOffset(res.headers);
  const body = (await res.json().catch(() => ({}))) as ApiError & { video?: { id: number; shortUUID?: string } };
  if (res.ok && body.video) return body.video;
  throw apiError(res.status, body, 'upload');
}

function nextOffset(headers: Headers): number {
  const m = /bytes=\d+-(\d+)/.exec(headers.get('range') ?? '');
  return m ? Number(m[1]) + 1 : 0;
}

export const peertube: Provider = {
  id: 'peertube',
  displayName: 'PeerTube',
  capabilities: { nativeSchedule: true, thumbnail: true, captions: true, syntheticMediaFlag: false },
  // PeerTube transcodes on the server; these are the inputs every default instance accepts.
  spec: {
    containers: ['mp4', 'mov', 'webm', 'matroska'],
    videoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
    audioCodecs: ['aac', 'opus', 'mp3', 'vorbis'],
  },
  appFields: [],
  connectMethod: 'token',
  connectFields: [
    { key: 'instance', label: '인스턴스 주소 (예: peertube.example)', secret: false },
    { key: 'username', label: '사용자 이름', secret: false },
    { key: 'password', label: '비밀번호 (저장하지 않고 토큰만 받습니다)', secret: true },
    { key: 'otp', label: '2단계 인증 코드 (켜 둔 경우)', secret: false, optional: true },
  ],

  setupGuide() {
    return `PeerTube — 인스턴스 계정으로 연결 (개발자 앱 등록·심사 없음)

1. 영상을 올릴 수 있는 PeerTube 계정과 채널이 있어야 합니다
2. fanout connect peertube --name main --instance peertube.example --username <이름> --password <비밀번호> [--otp <코드>]
   또는 대시보드 설정 탭의 PeerTube 칸
   비밀번호는 로그인에만 쓰고 저장하지 않습니다. 인스턴스가 준 토큰만 암호화해 저장합니다.
   OIDC·LDAP 같은 외부 로그인만 쓰는 계정(비밀번호 없음)은 아직 연결할 수 없습니다.
3. fanout doctor peertube 로 서버 버전, 채널, 남은 저장 용량을 확인

공개 범위(privacy)는 매번 직접 고릅니다: public, unlisted, private, internal(인스턴스 사용자만).
로그인은 인스턴스 설정에 따라 2~4주 동안 쓰지 않으면 만료되니 그때 다시 연결하세요.`;
  },

  async connect(ctx, name, flags) {
    const ask = async (key: string, label: string): Promise<string> => {
      const v = typeof flags[key] === 'string' ? (flags[key] as string).trim() : '';
      if (v) return v;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(`${label}: `)).trim();
      } finally {
        rl.close();
      }
    };
    const instance = normalizePeerTubeInstance(await ask('instance', '인스턴스 주소'));
    const username = await ask('username', '사용자 이름');
    const password = typeof flags.password === 'string' ? flags.password : await ask('password', '비밀번호');
    const otp = typeof flags.otp === 'string' && flags.otp.trim() ? flags.otp.trim() : undefined;
    // The instance's own web client credentials; nothing is shipped with fanout.
    const clientRes = await ctx.fetch(`${instance}/api/v1/oauth-clients/local`);
    const client = (await clientRes.json().catch(() => ({}))) as ApiError & { client_id?: string; client_secret?: string };
    if (!clientRes.ok || !client.client_id || !client.client_secret) {
      throw new ProviderError('rejected', 'peertube.client', `PeerTube 로그인 클라이언트를 받지 못했습니다. 인스턴스의 공개 주소로 연결했는지 확인하세요 (${client.detail ?? clientRes.status})`);
    }
    const base = { instance, clientId: client.client_id, clientSecret: client.client_secret };
    const tok = await tokenRequest(ctx, instance, { client_id: base.clientId, client_secret: base.clientSecret, grant_type: 'password', username, password }, otp);
    const c = fromToken(base, tok, ctx.now().getTime());
    const { body: me } = await api<Me>(ctx, c, '/api/v1/users/me');
    const channels = (me.videoChannels ?? []).map((ch) => ({ id: ch.id, name: ch.name, displayName: ch.displayName }));
    return {
      platform: 'peertube',
      name,
      credentials: { ...c },
      profile: { username: `${me.username}@${new URL(instance).host}`, userId: me.id, channels },
    };
  },

  async refresh(ctx, account) {
    const c = creds(account);
    // Access tokens live a day: refresh with ten minutes of headroom.
    if (c.expiresAt - ctx.now().getTime() > 600_000) return account;
    const tok = await tokenRequest(ctx, c.instance, { client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token', refresh_token: c.refreshToken });
    const next: Account = { ...account, credentials: { ...fromToken(c, tok, ctx.now().getTime()) } };
    ctx.store.saveAccount(next);
    return next;
  },

  validate(post, target) {
    const issues: Issue[] = [];
    const o = target.options as Partial<PeerTubeOptions>;
    if (!o.privacy || !(o.privacy in PRIVACY)) {
      issues.push({ severity: 'error', code: 'privacy', message: 'PeerTube 공개 범위(public/unlisted/private/internal)를 직접 지정해야 합니다' });
    }
    const name = post.title.trim();
    if (chars(name) < NAME_MIN || chars(name) > NAME_MAX) {
      issues.push({ severity: 'error', code: 'title', message: `PeerTube 제목은 ${NAME_MIN}~${NAME_MAX}자여야 합니다 (현재 ${chars(name)})` });
    }
    if (chars(post.description) > DESCRIPTION_MAX) issues.push({ severity: 'warning', code: 'description', message: `PeerTube 설명은 ${DESCRIPTION_MAX}자까지만 올라갑니다` });
    const kept = peertubeTags(post.tags);
    if (kept.length < post.tags.length) {
      issues.push({ severity: 'warning', code: 'tags', message: `PeerTube 태그는 ${TAGS_MAX}개까지, 각 ${TAG_MIN}~${TAG_MAX}자만 올라갑니다: ${kept.join(', ') || '(없음)'}` });
    }
    if (o.commentsPolicy && !(o.commentsPolicy in COMMENTS_POLICY)) issues.push({ severity: 'error', code: 'comments', message: 'commentsPolicy는 enabled, disabled, approval 중 하나' });
    if (post.scheduledAt && o.privacy && o.privacy !== 'public' && o.privacy !== 'unlisted' && o.privacy !== 'internal') {
      issues.push({ severity: 'error', code: 'schedule', message: 'PeerTube 예약 공개는 public·unlisted·internal로만 바꿀 수 있습니다' });
    }
    if (post.containsSyntheticMedia) issues.push({ severity: 'warning', code: 'synthetic', message: 'PeerTube에는 AI 콘텐츠 표시가 없습니다. 필요하면 설명에 적어 주세요' });
    return issues;
  },

  async publish({ ctx, post, target, account, mediaPath, saveResume }): Promise<PublishOutcome> {
    let c = creds(account);
    let r = (target.resume ?? {}) as PeerTubeResume;
    if (r.videoId) return { state: 'processing', remoteId: String(r.videoId), remoteUrl: watchUrl(c.instance, r.shortUUID, r.videoId) };
    const total = statSync(mediaPath).size;
    const save = (next: PeerTubeResume) => {
      r = next;
      saveResume({ ...next });
    };
    // Access tokens live a day and a refresh anywhere revokes the old one: on a 401 mid-upload, take
    // the token another process may have stored, or refresh, and send the request once more.
    const renew = async () => {
      const stored = ctx.store.getAccount('peertube', account.name);
      const sc = stored ? creds(stored) : c;
      if (sc.accessToken !== c.accessToken && sc.expiresAt > ctx.now().getTime()) {
        c = sc;
        return;
      }
      const tok = await tokenRequest(ctx, sc.instance, { client_id: sc.clientId, client_secret: sc.clientSecret, grant_type: 'refresh_token', refresh_token: sc.refreshToken });
      const next: Account = { ...(stored ?? account), credentials: { ...fromToken(sc, tok, ctx.now().getTime()) } };
      ctx.store.saveAccount(next);
      c = creds(next);
    };
    const put: Put = async (headers, body) => {
      const send = () => ctx.fetch(r.location!, { method: 'PUT', headers: { authorization: `Bearer ${c.accessToken}`, ...headers }, body });
      const res = await send();
      if (res.status !== 401) return res;
      await renew();
      return send();
    };

    if (r.location && r.total === total) {
      // Pick up an interrupted session where the server left it.
      const at = await uploadOffset(put, total).catch((err: unknown) => {
        // Sessions die after an hour without chunks, and once the server has finished with the last
        // chunk (only that request gets the video back). A 503 means it is still working on it.
        if (notFound(err)) return 'gone' as const;
        throw err;
      });
      if (typeof at === 'object') return finishUpload(at);
      if (at !== 'gone') return sendFrom(at);
      if (r.finalSent) {
        // The last chunk went out: find the video it made, if it made one.
        const found = await findUploaded();
        if (found) return finishUpload(found);
        if (found === undefined) {
          throw new ProviderError('rejected', 'peertube.maybe_posted', `업로드 세션이 끝났는데 마지막 조각은 이미 보냈습니다. ${c.instance} 에서 영상이 있는지 확인한 뒤, 없으면 다시 시도하세요`, '404', { keepResume: true });
        }
      }
      save({ ...r, location: undefined, finalSent: undefined });
    }

    // New session.
    const o = target.options as unknown as PeerTubeOptions;
    const { body: me } = await api<Me>(ctx, c, '/api/v1/users/me');
    const channel = channelFor(account, o, me.videoChannels ?? []);
    if (!channel) throw new ProviderError('rejected', 'peertube.channel', `채널 ${o.channel ?? ''}을(를) 찾을 수 없습니다. 가능: ${(me.videoChannels ?? []).map((ch) => ch.name).join(', ') || '(없음)'}`);
    const { body: used } = await api<{ videoQuotaUsed?: number; videoQuotaUsedDaily?: number }>(ctx, c, '/api/v1/users/me/video-quota-used');
    for (const [limit, spent, label] of [
      [me.videoQuota, used.videoQuotaUsed, '전체'],
      [me.videoQuotaDaily, used.videoQuotaUsedDaily, '하루'],
    ] as const) {
      if (limit !== undefined && limit >= 0 && (spent ?? 0) + total > limit) {
        throw new ProviderError('rejected', 'peertube.quota', `PeerTube ${label} 저장 용량이 모자랍니다 (남은 ${Math.max(0, (limit - (spent ?? 0)) / 1024 / 1024).toFixed(0)}MB, 파일 ${(total / 1024 / 1024).toFixed(0)}MB)`);
      }
    }
    const version = await serverVersion(ctx, c);
    const newComments = !version || version[0] > 6 || (version[0] === 6 && version[1] >= 2);
    const scheduled = post.scheduledAt && Date.parse(post.scheduledAt) > ctx.now().getTime() ? new Date(post.scheduledAt).toISOString() : undefined;
    const body: Record<string, unknown> = {
      channelId: channel.id,
      name: post.title.trim(),
      filename: basename(mediaPath),
      privacy: scheduled ? PRIVACY.private : PRIVACY[o.privacy],
      ...(scheduled ? { scheduleUpdate: { updateAt: scheduled, privacy: PRIVACY[o.privacy] } } : {}),
      ...(description(post) ? { description: description(post) } : {}),
      tags: peertubeTags(post.tags),
      waitTranscoding: true,
      ...(o.commentsPolicy ? (newComments ? { commentsPolicy: COMMENTS_POLICY[o.commentsPolicy] } : { commentsEnabled: o.commentsPolicy !== 'disabled' }) : {}),
      ...(o.nsfw !== undefined ? { nsfw: o.nsfw } : {}),
      ...(o.downloadEnabled !== undefined ? { downloadEnabled: o.downloadEnabled } : {}),
      ...(o.language ? { language: o.language } : {}),
      ...(o.category ? { category: o.category } : {}),
      ...(o.licence ? { licence: o.licence } : {}),
    };
    const init = await api<unknown>(ctx, c, '/api/v1/videos/upload-resumable', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-upload-content-length': String(total), 'x-upload-content-type': mediaPath.endsWith('.webm') ? 'video/webm' : 'video/mp4' },
      body: JSON.stringify(body),
      allow: [200, 201],
    });
    const loc = init.headers.get('location');
    if (!loc) throw new ProviderError('retryable', 'peertube.no_session', 'PeerTube가 업로드 세션 주소를 주지 않았습니다');
    save({ location: new URL(loc, c.instance).toString(), total, instance: c.instance, userId: me.id, channelId: channel.id, startedAt: ctx.now().toISOString() });
    // 200 means the server already holds this file for us: ask where it is.
    if (init.status === 200) {
      const at = await uploadOffset(put, total);
      return typeof at === 'object' ? finishUpload(at) : sendFrom(at);
    }
    return sendFrom(0);

    async function sendFrom(start: number): Promise<PublishOutcome> {
      const { body: cfg } = await api<{ client?: { videos?: { resumableUpload?: { maxChunkSize?: number } } } }>(ctx, c, '/api/v1/config').catch(() => ({ body: {} as Record<string, never> }));
      const cap = (cfg as { client?: { videos?: { resumableUpload?: { maxChunkSize?: number } } } }).client?.videos?.resumableUpload?.maxChunkSize ?? 0;
      let size = Math.max(MIN_CHUNK, Math.ceil(total / 10_000));
      if (cap > 0) size = Math.min(size, cap);
      let offset = start;
      while (offset < total) {
        const chunk = await readChunk(mediaPath, offset, Math.min(size, total - offset));
        const last = offset + chunk.length >= total;
        if (last) save({ ...r, finalSent: true });
        const res = await put({ 'content-type': 'application/octet-stream', 'content-range': `bytes ${offset}-${offset + chunk.length - 1}/${total}` }, chunk);
        if (res.status === 308) {
          offset = nextOffset(res.headers);
          continue;
        }
        const out = (await res.json().catch(() => ({}))) as ApiError & { video?: { id: number; shortUUID?: string } };
        if (res.ok && out.video) return finishUpload(out.video);
        // The server refused the last chunk (unreadable file, upload filter): it deleted the upload
        // and made no video, so the next try starts clean instead of looking for one.
        if (last && res.status >= 400 && res.status < 500) save({ ...r, location: undefined, finalSent: undefined });
        // A 503 after the last chunk means the server is still assembling it; the next try looks it up.
        throw apiError(res.status, out, 'upload');
      }
      // Everything was there already; the status query returns the video.
      const at = await uploadOffset(put, total);
      if (typeof at === 'object') return finishUpload(at);
      throw new ProviderError('retryable', 'peertube.incomplete', `PeerTube가 ${at}/${total}바이트만 받았다고 합니다`);
    }

    /**
     * The video the last chunk created, matched by name and channel among this account's videos
     * created since the session started. null: certainly none; undefined: can't tell (an older
     * session that didn't record when it started).
     */
    async function findUploaded(): Promise<{ id: number; shortUUID?: string } | null | undefined> {
      if (!r.startedAt || !r.channelId) return undefined;
      const since = Date.parse(r.startedAt) - 60_000;
      const { body } = await api<{ data?: Array<{ id: number; shortUUID?: string; name?: string; createdAt?: string; channel?: { id?: number } }> }>(
        ctx,
        c,
        '/api/v1/users/me/videos?sort=-createdAt&start=0&count=25',
      );
      const match = (body.data ?? []).find((v) => v.name === post.title.trim() && v.channel?.id === r.channelId && Date.parse(v.createdAt ?? '') >= since);
      return match ? { id: match.id, shortUUID: match.shortUUID } : null;
    }

    async function finishUpload(video: { id: number; shortUUID?: string }): Promise<PublishOutcome> {
      save({ ...r, videoId: video.id, shortUUID: video.shortUUID, location: undefined, finalSent: undefined });
      const warnings = await applyExtras(ctx, c, post, video.id);
      save({ ...r, extrasDone: true });
      return { state: 'processing', remoteId: String(video.id), remoteUrl: watchUrl(c.instance, video.shortUUID, video.id), warnings };
    }
  },

  async poll({ ctx, post, target, account }): Promise<PollOutcome> {
    const c = creds(account);
    const r = (target.resume ?? {}) as PeerTubeResume;
    const id = Number(target.remoteId);
    const warnings = r.extrasDone ? [] : await applyExtras(ctx, c, post, id);
    if (!r.extrasDone) ctx.store.updateTarget(target.id, { resume: { ...r, extrasDone: true } });
    const { body: v } = await api<{ state?: { id: number; label?: string }; shortUUID?: string; privacy?: { id: number }; scheduledUpdate?: { updateAt?: string } | null; blacklisted?: boolean }>(
      ctx,
      c,
      `/api/v1/videos/${id}`,
    );
    const url = watchUrl(c.instance, v.shortUUID ?? r.shortUUID, id);
    const stateId = v.state?.id ?? 0;
    if (STATE_FAILED[stateId]) {
      throw new ProviderError('rejected', 'peertube.processing_failed', `PeerTube ${STATE_FAILED[stateId]}. ${url} 에서 확인하세요`, String(stateId), { keepResume: true });
    }
    if (stateId !== STATE_PUBLISHED && (STATE_WORKING.has(stateId) || !stateId)) return { state: 'processing', remoteId: String(id), remoteUrl: url, warnings };
    if (v.blacklisted) warnings.push('인스턴스 관리자가 이 영상을 숨겼습니다');
    if (v.scheduledUpdate?.updateAt) warnings.push(`예약 공개: ${v.scheduledUpdate.updateAt}`);
    return { state: 'published', remoteId: String(id), remoteUrl: url, warnings };
  },

  async doctor({ ctx, account, live }): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    let c = creds(account);
    try {
      c = creds(await peertube.refresh(ctx, account));
      const { body: me } = await api<Me>(ctx, c, '/api/v1/users/me');
      const channels = me.videoChannels ?? [];
      checks.push({ name: '계정', status: 'ok', detail: `${me.username} (${c.instance})` });
      checks.push({ name: '채널', status: channels.length ? 'ok' : 'fail', detail: channels.length ? channels.map((ch) => `${ch.name}(${ch.id})`).join(', ') : '영상을 올릴 채널이 없습니다' });
      const { body: used } = await api<{ videoQuotaUsed?: number; videoQuotaUsedDaily?: number }>(ctx, c, '/api/v1/users/me/video-quota-used');
      const mb = (n?: number) => (n === undefined ? '?' : n < 0 ? '무제한' : `${(n / 1024 / 1024).toFixed(0)}MB`);
      checks.push({ name: '저장 용량', status: 'info', detail: `전체 ${mb(used.videoQuotaUsed)} / ${mb(me.videoQuota)}, 오늘 ${mb(used.videoQuotaUsedDaily)} / ${mb(me.videoQuotaDaily)}` });
    } catch (err) {
      checks.push({ name: '계정', status: 'fail', detail: (err as Error).message });
      return checks;
    }
    const version = await serverVersion(ctx, c);
    checks.push({ name: '서버 버전', status: version ? 'info' : 'warn', detail: version ? version.join('.') : '알 수 없음' });
    if (live) checks.push({ name: '실제 업로드 점검', status: 'info', detail: 'PeerTube는 아직 --live 점검을 하지 않습니다' });
    return checks;
  },

  async stats({ ctx, account, target }) {
    // Video ids are per instance: never read another instance's video with the same number.
    assertOwner(account, target);
    const { body: v } = await api<{ views?: number; likes?: number; dislikes?: number; comments?: number }>(ctx, creds(account), `/api/v1/videos/${target.remoteId}`);
    return { views: v.views, likes: v.likes, comments: v.comments, ...(v.dislikes ? { note: `싫어요 ${v.dislikes}` } : {}) };
  },

  async remove({ ctx, account, target }) {
    assertOwner(account, target);
    const c = creds(account);
    try {
      await api(ctx, c, `/api/v1/videos/${target.remoteId}`, { method: 'DELETE' });
    } catch (err) {
      if (!notFound(err)) throw err;
      // Only call it gone when the instance itself says the video doesn't exist.
      const still = await api(ctx, c, `/api/v1/videos/${target.remoteId}`).then(
        () => true,
        (e: unknown) => {
          if (notFound(e)) return false;
          throw e;
        },
      );
      if (still) throw new ProviderError('rejected', 'peertube.not_owner', '이 영상을 지울 권한이 없습니다');
    }
  },

  async update({ ctx, account, target, post }) {
    assertOwner(account, target);
    await api(ctx, creds(account), `/api/v1/videos/${target.remoteId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      // null clears the description; '' fails the server's 3-character minimum and the whole edit with it.
      body: JSON.stringify({ name: post.title.trim(), description: description(post) ?? null, tags: peertubeTags(post.tags) }),
    });
  },

  async comments({ ctx, account, target, limit }) {
    assertOwner(account, target);
    const c = creds(account);
    type Thread = { id: number; text?: string; createdAt: string; isDeleted?: boolean; totalReplies?: number; account?: { name?: string; host?: string; displayName?: string } };
    const { body } = await api<{ data?: Thread[] }>(ctx, c, `/api/v1/videos/${target.remoteId}/comment-threads?start=0&count=${Math.min(limit, 100)}&sort=-createdAt`);
    const url = target.remoteUrl;
    return (body.data ?? [])
      .filter((t) => !t.isDeleted)
      .map(
        (t): Comment => ({
          id: String(t.id),
          author: t.account?.displayName ? `${t.account.displayName} (@${t.account.name}@${t.account.host})` : `@${t.account?.name ?? '?'}@${t.account?.host ?? '?'}`,
          text: htmlToText(t.text ?? ''),
          at: t.createdAt,
          replies: t.totalReplies,
          ...(url ? { url } : {}),
        }),
      );
  },

  async reply({ ctx, account, target, comment, text, sending }) {
    assertOwner(account, target);
    const c = creds(account);
    sending();
    const { body } = await api<{ comment?: { id: number } }>(ctx, c, `/api/v1/videos/${target.remoteId}/comments/${encodeURIComponent(comment.id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return { id: String(body.comment?.id ?? ''), ...(target.remoteUrl ? { url: target.remoteUrl } : {}) };
  },
};
