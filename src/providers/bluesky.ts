import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ProviderError, kindForStatus } from '../core/errors.ts';
import type { DoctorCheck, PollOutcome, Provider, ProviderContext, PublishOutcome } from '../core/provider.ts';
import type { Account } from '../core/store.ts';
import type { Issue, Post } from '../core/types.ts';
import { msg } from '../core/i18n.ts';

// Docs: https://docs.bsky.app/docs/tutorials/video (recommended method: upload to the video
// service, poll the job for a blob, then create the post). Lexicons: app.bsky.video.*,
// app.bsky.embed.video (mp4 ≤300MB, up to 20 VTT captions ≤20KB each).

const DEFAULT_SERVICE = 'https://bsky.social';
const VIDEO_SERVICE = 'https://video.bsky.app';
/** Public read-only AppView: post counts without auth. */
const PUBLIC_APPVIEW = 'https://public.api.bsky.app';
const TEXT_MAX = 300;

export interface BlueskyCredentials {
  /** PDS that hosts the account (from the session's DID document). */
  pds: string;
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
}

export interface BlueskyOptions {
  /** Post text; defaults to title + description + hashtags, trimmed to fit. */
  text?: string;
  /** Alt text for the video. */
  alt?: string;
  /** BCP-47 languages of the post text, e.g. ["ko"]. */
  langs?: string[];
}

interface BlobRef {
  $type?: 'blob';
  ref: { $link: string };
  mimeType: string;
  size: number;
}

interface JobStatus {
  jobId: string;
  state: string;
  blob?: BlobRef;
  error?: string;
  failureCode?: string;
  message?: string;
}

function creds(account: Account): BlueskyCredentials {
  return account.credentials as unknown as BlueskyCredentials;
}

/** Seconds-since-epoch `exp` from a JWT, without verifying it (the PDS does that). */
export function jwtExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    return (payload.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

async function xrpc<T>(
  ctx: ProviderContext,
  base: string,
  method: string,
  init: { token?: string; query?: Record<string, string>; json?: unknown; body?: Buffer; contentType?: string; post?: boolean } = {},
): Promise<T> {
  const url = new URL(`/xrpc/${method}`, base);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let body: string | Buffer | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.body) {
    headers['content-type'] = init.contentType ?? 'application/octet-stream';
    body = init.body;
  }
  const res = await ctx.fetch(url, { method: body || init.post ? 'POST' : 'GET', headers, body });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) {
    const code = data.error ?? `http_${res.status}`;
    const auth = res.status === 401 || code === 'ExpiredToken' || code === 'InvalidToken' || code === 'AuthenticationRequired';
    const err = new ProviderError(auth ? 'auth' : kindForStatus(res.status), `bluesky.${code}`, `Bluesky ${method}: ${data.message ?? code}`, code);
    (err as ProviderError & { body?: unknown }).body = data;
    throw err;
  }
  return data;
}

function pdsFromDidDoc(doc: unknown): string | undefined {
  const services = (doc as { service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }> } | undefined)?.service;
  return services?.find((s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer')?.serviceEndpoint;
}

async function serviceAuth(ctx: ProviderContext, c: BlueskyCredentials, aud: string, lxm: string): Promise<string> {
  const exp = String(Math.floor(ctx.now().getTime() / 1000) + 30 * 60);
  const res = await xrpc<{ token: string }>(ctx, c.pds, 'com.atproto.server.getServiceAuth', { token: c.accessJwt, query: { aud, lxm, exp } });
  return res.token;
}

async function uploadLimits(ctx: ProviderContext, c: BlueskyCredentials) {
  const token = await serviceAuth(ctx, c, 'did:web:video.bsky.app', 'app.bsky.video.getUploadLimits');
  return xrpc<{ canUpload: boolean; remainingDailyVideos?: number; remainingDailyBytes?: number; message?: string; error?: string }>(
    ctx,
    VIDEO_SERVICE,
    'app.bsky.video.getUploadLimits',
    { token },
  );
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function graphemes(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/** Default post text: title, description and hashtags, dropping the description first if it is too long. */
export function postText(post: Post, opts: BlueskyOptions): string {
  if (opts.text !== undefined) return opts.text;
  const tags = post.tags.map((t) => `#${t.replace(/^#/, '').replace(/\s+/g, '')}`).join(' ');
  const full = [post.title, post.description, tags].filter((s) => s.trim()).join('\n\n');
  if (graphemes(full) <= TEXT_MAX) return full;
  return [post.title, tags].filter((s) => s.trim()).join('\n\n');
}

/** Rich-text facets so hashtags and links are clickable (byte offsets into UTF-8). */
export function facets(text: string): unknown[] {
  const out: unknown[] = [];
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
  for (const m of text.matchAll(/(^|\s)(#[^\s#.,!?;:()]+)/gu)) {
    const start = bytes(text.slice(0, m.index + m[1]!.length));
    out.push({
      index: { byteStart: start, byteEnd: start + bytes(m[2]!) },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2]!.slice(1) }],
    });
  }
  for (const m of text.matchAll(/https?:\/\/[^\s]+/g)) {
    const start = bytes(text.slice(0, m.index));
    out.push({ index: { byteStart: start, byteEnd: start + bytes(m[0]) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] });
  }
  return out;
}

const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';

/** atproto record key (TID): 53-bit microsecond timestamp + 10-bit clock id, base32-sortable, 13 chars. */
export function newTid(nowMs: number, clockId = Math.floor(Math.random() * 1024)): string {
  let n = (BigInt(Math.floor(nowMs)) * 1000n) << 10n | BigInt(clockId & 1023);
  let out = '';
  for (let i = 0; i < 13; i++) {
    out = TID_ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

function postUrl(handle: string, uri: string): string {
  return `https://bsky.app/profile/${handle}/post/${uri.split('/').pop()}`;
}

async function createPostRecord(
  ctx: ProviderContext,
  account: Account,
  post: Post,
  opts: BlueskyOptions,
  blob: BlobRef,
  aspect: { width: number; height: number },
  rkey: string,
) {
  const c = creds(account);
  const warnings: string[] = [];
  const captions: Array<{ lang: string; file: BlobRef }> = [];
  for (const cap of post.captions) {
    if (extname(cap.path).toLowerCase() !== '.vtt') {
      warnings.push(msg('Bluesky 자막은 VTT만 받습니다 — {basename} 건너뜀', { basename: basename(cap.path) }));
      continue;
    }
    const data = readFileSync(cap.path);
    if (data.length > 20_000) {
      warnings.push(msg('Bluesky 자막은 20KB 이하 — {basename} 건너뜀', { basename: basename(cap.path) }));
      continue;
    }
    const up = await xrpc<{ blob: BlobRef }>(ctx, c.pds, 'com.atproto.repo.uploadBlob', { token: c.accessJwt, body: data, contentType: 'text/vtt' });
    captions.push({ lang: cap.language, file: up.blob });
  }
  const text = postText(post, opts);
  const record = {
    $type: 'app.bsky.feed.post',
    text,
    facets: facets(text),
    createdAt: ctx.now().toISOString(),
    ...(opts.langs?.length ? { langs: opts.langs } : {}),
    embed: {
      $type: 'app.bsky.embed.video',
      video: blob,
      aspectRatio: aspect,
      ...(opts.alt ? { alt: opts.alt } : {}),
      ...(captions.length ? { captions } : {}),
    },
  };
  const res = await xrpc<{ uri: string; cid: string }>(ctx, c.pds, 'com.atproto.repo.createRecord', {
    token: c.accessJwt,
    json: { repo: c.did, collection: 'app.bsky.feed.post', rkey, record },
  });
  return { uri: res.uri, warnings };
}

export const bluesky: Provider = {
  id: 'bluesky',
  displayName: 'Bluesky',
  capabilities: { nativeSchedule: false, thumbnail: false, captions: true, syntheticMediaFlag: false },
  spec: {
    maxBytes: 300_000_000,
    maxDurationSec: 180,
    containers: ['mp4', 'mov'],
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
  },
  // No developer app: accounts sign in with an app password.
  appFields: [],
  connectMethod: 'token',
  connectFields: [
    { key: 'handle', label: msg('핸들 (예: name.bsky.social)'), secret: false },
    { key: 'token', label: msg('앱 비밀번호'), secret: true },
    { key: 'service', label: msg('PDS 주소 (기본 {DEFAULT_SERVICE})', { DEFAULT_SERVICE }), secret: false, optional: true },
  ],

  setupGuide() {
    return msg(`Bluesky — 앱 비밀번호로 연결 (개발자 앱 필요 없음)

1. Bluesky 앱 → 설정 → 개인정보 및 보안 → 앱 비밀번호 → 새로 만들기
   (fanout 전용으로 하나 만들고, DM 접근은 켜지 마세요)
2. 계정 이메일 인증을 마쳐야 영상을 올릴 수 있습니다
3. 연결:
     fanout connect bluesky --name main --handle 내핸들.bsky.social --token <앱 비밀번호>
   또는 대시보드 설정 탭의 Bluesky 칸
4. fanout doctor bluesky 로 오늘 남은 영상 업로드 한도를 확인

fanout은 앱 비밀번호를 저장하지 않습니다. 로그인해서 받은 토큰만 암호화해 보관하고 자동으로 갱신합니다.
토큰이 만료되면(오래 쓰지 않았을 때) 다시 연결하세요. 영상은 mp4, 최대 300MB입니다.`);
  },

  async connect(ctx, name, flags) {
    let handle = typeof flags.handle === 'string' ? flags.handle.trim().replace(/^@/, '') : '';
    let password = typeof flags.token === 'string' ? flags.token.trim() : typeof flags.password === 'string' ? flags.password.trim() : '';
    if (!handle || !password) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        if (!handle) handle = (await rl.question(msg('Bluesky 핸들: '))).trim().replace(/^@/, '');
        if (!password) password = (await rl.question(msg('앱 비밀번호: '))).trim();
      } finally {
        rl.close();
      }
    }
    const service = typeof flags.service === 'string' && flags.service.trim() ? flags.service.trim() : DEFAULT_SERVICE;
    const s = await xrpc<{ did: string; handle: string; accessJwt: string; refreshJwt: string; didDoc?: unknown; emailConfirmed?: boolean }>(
      ctx,
      service,
      'com.atproto.server.createSession',
      { json: { identifier: handle, password } },
    );
    const credentials: BlueskyCredentials = { pds: pdsFromDidDoc(s.didDoc) ?? service, did: s.did, handle: s.handle, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt };
    if (s.emailConfirmed === false) ctx.log.warn(msg('Bluesky 계정 이메일이 인증되지 않아 영상을 올릴 수 없습니다. 앱에서 이메일 인증을 마치세요.'));
    return { platform: 'bluesky', name, credentials: { ...credentials }, profile: { handle: s.handle, username: s.handle, did: s.did } };
  },

  async refresh(ctx, account) {
    const c = creds(account);
    if (jwtExpiry(c.accessJwt) - ctx.now().getTime() > 5 * 60_000) return account;
    const s = await xrpc<{ accessJwt: string; refreshJwt: string; handle: string; didDoc?: unknown }>(ctx, c.pds, 'com.atproto.server.refreshSession', {
      token: c.refreshJwt,
      post: true,
    }).catch((err: unknown) => {
      // Network trouble or a PDS outage is retryable; only a refused refresh token means reconnecting.
      if (!(err instanceof ProviderError) || err.kind === 'retryable') throw err;
      throw new ProviderError('auth', 'bluesky.session_expired', msg('Bluesky 세션이 만료됐습니다 — 다시 연결하세요 ({err})', { err: err.platformCode ?? err.message }), err.platformCode);
    });
    const next: Account = {
      ...account,
      credentials: { ...c, pds: pdsFromDidDoc(s.didDoc) ?? c.pds, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt, handle: s.handle ?? c.handle },
    };
    ctx.store.saveAccount(next);
    return next;
  },

  validate(post, target) {
    const issues: Issue[] = [];
    const text = postText(post, target.options as BlueskyOptions);
    if (graphemes(text) > TEXT_MAX) issues.push({ severity: 'error', code: 'text', message: msg('Bluesky 글은 {TEXT_MAX}자 이하 (현재 {graphemes}) — options.text로 줄이세요', { TEXT_MAX, graphemes: graphemes(text) }) });
    if (post.thumbnailPath) issues.push({ severity: 'warning', code: 'thumbnail', message: msg('Bluesky는 썸네일을 받지 않아 무시됩니다') });
    if (post.scheduledAt) issues.push({ severity: 'warning', code: 'schedule', message: msg('Bluesky는 예약 게시가 없어 fanout이 예약 시각에 올립니다 (fanout worker 필요)') });
    return issues;
  },

  async publish({ ctx, target, account, mediaPath, media, saveResume }): Promise<PublishOutcome> {
    const c = creds(account);
    const resume = (target.resume ?? {}) as { jobId?: string; postUri?: string };
    if (resume.postUri) return { state: 'published', remoteId: resume.postUri, remoteUrl: postUrl(c.handle, resume.postUri) };
    if (resume.jobId) return { state: 'processing', remoteId: resume.jobId };

    const limits = await uploadLimits(ctx, c);
    if (!limits.canUpload) {
      throw new ProviderError('rejected', 'bluesky.upload_limit', msg('Bluesky 영상 업로드 불가: {reason}', { reason: limits.message ?? limits.error ?? msg('한도 초과') }), limits.error);
    }
    const pdsHost = new URL(c.pds).host;
    const token = await serviceAuth(ctx, c, `did:web:${pdsHost}`, 'com.atproto.repo.uploadBlob');
    const size = statSync(mediaPath).size;
    let job: JobStatus;
    try {
      const res = await xrpc<JobStatus | { jobStatus: JobStatus }>(ctx, VIDEO_SERVICE, 'app.bsky.video.uploadVideo', {
        token,
        query: { did: c.did, name: basename(mediaPath) },
        body: readFileSync(mediaPath),
        contentType: 'video/mp4',
      });
      job = 'jobStatus' in res ? res.jobStatus : res;
    } catch (err) {
      // The same file was processed before: the error body still carries the job (and its blob).
      const body = (err as { body?: JobStatus & { jobStatus?: JobStatus } }).body;
      const prior = body?.jobStatus ?? (body?.jobId ? body : undefined);
      if (!prior) throw err;
      job = prior;
    }
    saveResume({ jobId: job.jobId, width: media.video.width, height: media.video.height });
    ctx.log.info(msg('bluesky: {size}MB 업로드, 처리 대기 (job {jobId})', { size: (size / 1024 / 1024).toFixed(1), jobId: job.jobId }));
    return { state: 'processing', remoteId: job.jobId, warnings: limits.remainingDailyVideos !== undefined ? [msg('Bluesky 오늘 남은 영상 {limits}개', { limits: limits.remainingDailyVideos - 1 })] : [] };
  },

  async poll({ ctx, post, target, account }): Promise<PollOutcome> {
    const c = creds(account);
    const resume = (target.resume ?? {}) as { jobId?: string; postUri?: string; rkey?: string; width?: number; height?: number };
    if (resume.postUri) return { state: 'published', remoteId: resume.postUri, remoteUrl: postUrl(c.handle, resume.postUri) };
    const jobId = resume.jobId ?? target.remoteId;

    // A previous attempt may have created the post and then lost the response: the record key was
    // fixed in advance, so look it up before creating anything.
    if (resume.rkey) {
      const existing = await xrpc<{ uri: string }>(ctx, c.pds, 'com.atproto.repo.getRecord', {
        query: { repo: c.did, collection: 'app.bsky.feed.post', rkey: resume.rkey },
      }).catch((err: ProviderError) => {
        if (err.platformCode === 'RecordNotFound') return undefined;
        throw err;
      });
      if (existing) {
        ctx.store.updateTarget(target.id, { resume: { ...resume, postUri: existing.uri } });
        return { state: 'published', remoteId: existing.uri, remoteUrl: postUrl(c.handle, existing.uri) };
      }
    }
    const { jobStatus } = await xrpc<{ jobStatus: JobStatus }>(ctx, VIDEO_SERVICE, 'app.bsky.video.getJobStatus', { query: { jobId } });
    // A blob can arrive even on "failure" (already_exists), so check for it first.
    if (!jobStatus.blob) {
      if (jobStatus.state === 'JOB_STATE_FAILED') {
        throw new ProviderError('rejected', `bluesky.${jobStatus.failureCode ?? 'job_failed'}`, msg('Bluesky 영상 처리 실패: {jobStatus}', { jobStatus: jobStatus.message ?? jobStatus.error ?? jobStatus.failureCode ?? 'unknown' }), jobStatus.failureCode);
      }
      return { state: 'processing', remoteId: jobId };
    }
    const rkey = resume.rkey ?? newTid(ctx.now().getTime());
    if (!resume.rkey) ctx.store.updateTarget(target.id, { resume: { ...resume, rkey } });
    const { uri, warnings } = await createPostRecord(
      ctx,
      account,
      post,
      target.options as BlueskyOptions,
      jobStatus.blob,
      { width: resume.width ?? 1080, height: resume.height ?? 1920 },
      rkey,
    );
    ctx.store.updateTarget(target.id, { resume: { ...resume, rkey, postUri: uri } });
    return { state: 'published', remoteId: uri, remoteUrl: postUrl(c.handle, uri), warnings };
  },

  async limits({ ctx, account }) {
    const acct = await bluesky.refresh(ctx, account);
    const l = await uploadLimits(ctx, creds(acct));
    const note = l.canUpload ? undefined : (l.message ?? l.error ?? msg('업로드 불가'));
    return [
      { what: msg('하루 영상'), unit: 'posts', remaining: l.canUpload ? l.remainingDailyVideos : 0, note },
      { what: msg('하루 용량'), unit: 'bytes', remaining: l.canUpload ? l.remainingDailyBytes : 0, note },
    ];
  },

  async doctor({ ctx, account }): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    let acct = account;
    try {
      acct = await bluesky.refresh(ctx, { ...account, credentials: { ...account.credentials, accessJwt: '' } });
      checks.push({ name: msg('세션 갱신'), status: 'ok', detail: `@${creds(acct).handle} (${creds(acct).pds})` });
    } catch (err) {
      checks.push({ name: msg('세션 갱신'), status: 'fail', detail: (err as Error).message });
      return checks;
    }
    try {
      const s = await xrpc<{ emailConfirmed?: boolean }>(ctx, creds(acct).pds, 'com.atproto.server.getSession', { token: creds(acct).accessJwt });
      checks.push(
        s.emailConfirmed === false
          ? { name: msg('이메일 인증'), status: 'fail', detail: msg('영상 업로드에는 이메일 인증이 필요합니다') }
          : { name: msg('이메일 인증'), status: 'ok', detail: msg('인증됨') },
      );
    } catch (err) {
      checks.push({ name: msg('이메일 인증'), status: 'warn', detail: (err as Error).message });
    }
    try {
      const l = await uploadLimits(ctx, creds(acct));
      checks.push({
        name: msg('영상 업로드 한도'),
        status: l.canUpload ? 'ok' : 'fail',
        detail: l.canUpload
          ? msg('오늘 남은 영상 {videos}개, {size}', { videos: l.remainingDailyVideos ?? '?', size: l.remainingDailyBytes !== undefined ? `${(l.remainingDailyBytes / 1e9).toFixed(1)}GB` : '?' })
          : (l.message ?? l.error ?? msg('업로드 불가')),
      });
    } catch (err) {
      checks.push({ name: msg('영상 업로드 한도'), status: 'fail', detail: (err as Error).message });
    }
    return checks;
  },

  async stats({ ctx, target }) {
    const res = await xrpc<{ posts?: Array<{ likeCount?: number; replyCount?: number; repostCount?: number; quoteCount?: number }> }>(
      ctx,
      PUBLIC_APPVIEW,
      'app.bsky.feed.getPosts',
      { query: { uris: target.remoteId } },
    );
    const p = res.posts?.[0];
    if (!p) return { note: msg('게시물을 찾을 수 없습니다 (삭제됨?)') };
    return { likes: p.likeCount, comments: p.replyCount, shares: (p.repostCount ?? 0) + (p.quoteCount ?? 0), note: msg('Bluesky는 조회수를 공개하지 않습니다') };
  },

  async remove({ ctx, account, target }) {
    const c = creds(account);
    // at://<did>/app.bsky.feed.post/<rkey>: only delete from the repo the post actually lives in.
    const [, , repo, , rkey] = target.remoteId.split('/');
    if (repo !== c.did) throw new ProviderError('rejected', 'bluesky.not_owner', msg('이 게시물은 지금 연결된 계정(@{handle})의 것이 아니라 지울 수 없습니다', { handle: c.handle }));
    await xrpc(ctx, c.pds, 'com.atproto.repo.deleteRecord', { token: c.accessJwt, json: { repo, collection: 'app.bsky.feed.post', rkey } });
  },

  async comments({ ctx, target, limit }) {
    type Reply = { post?: { uri: string; author: { handle: string; displayName?: string }; record: { text?: string; createdAt?: string }; likeCount?: number; replyCount?: number } };
    const res = await xrpc<{ thread?: { replies?: Reply[] } }>(ctx, PUBLIC_APPVIEW, 'app.bsky.feed.getPostThread', {
      query: { uri: target.remoteId, depth: '1', parentHeight: '0' },
    });
    return (res.thread?.replies ?? [])
      .filter((r): r is Required<Reply> => Boolean(r.post))
      .map((r) => ({
        id: r.post.uri,
        author: r.post.author.displayName ? `${r.post.author.displayName} (@${r.post.author.handle})` : `@${r.post.author.handle}`,
        text: r.post.record.text ?? '',
        at: r.post.record.createdAt ?? '',
        likes: r.post.likeCount,
        replies: r.post.replyCount,
        url: `https://bsky.app/profile/${r.post.author.handle}/post/${r.post.uri.split('/').pop()}`,
      }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  },

  async reply({ ctx, account, target, comment, text, sending }) {
    if (graphemes(text) > TEXT_MAX) throw new ProviderError('rejected', 'bluesky.text', msg('Bluesky 답글은 {TEXT_MAX}자 이하 (현재 {graphemes})', { TEXT_MAX, graphemes: graphemes(text) }));
    const c = creds(account);
    type Ref = { uri: string; cid: string };
    const { posts } = await xrpc<{ posts?: Array<Ref & { record?: { reply?: { root?: Ref } } }> }>(ctx, PUBLIC_APPVIEW, 'app.bsky.feed.getPosts', { query: { uris: comment.id } });
    const parent = posts?.[0];
    if (!parent) throw new ProviderError('rejected', 'bluesky.reply_gone', msg('답글을 달 댓글을 찾을 수 없습니다 (지워졌을 수 있습니다)'));
    // A reply names the thread's root as well as its parent; ours is the root of its own thread.
    const root = parent.record?.reply?.root;
    if (!root || root.uri !== target.remoteId) throw new ProviderError('rejected', 'bluesky.reply_thread', msg('이 게시물의 댓글이 아닙니다'));
    sending();
    const res = await xrpc<{ uri: string }>(ctx, c.pds, 'com.atproto.repo.createRecord', {
      token: c.accessJwt,
      json: {
        repo: c.did,
        collection: 'app.bsky.feed.post',
        record: { $type: 'app.bsky.feed.post', text, createdAt: ctx.now().toISOString(), reply: { root, parent: { uri: parent.uri, cid: parent.cid } } },
      },
    });
    return { id: res.uri, url: `https://bsky.app/profile/${c.handle}/post/${res.uri.split('/').pop()}` };
  },
};
