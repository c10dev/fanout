#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { fanoutHome, openContext, stderrLogger } from './core/context.ts';
import { restoreBackup, RestoreError } from './core/restore.ts';
import { DEFAULT_EVENTS, detectFormat, eventsToSave, flushNotifications, KNOWN_EVENTS, notifyConfig, send, validWebhookUrl, type NotifyConfig, type NotifyEvent } from './core/notify.ts';
import { ProviderError } from './core/errors.ts';
import { CONFIG_FILE, defaultAccountName, exampleConfig, ingest, loadWatchConfig, Scanner, watchAccount, WatchConfigError, type WatchConfig } from './core/inbox.ts';
import { exportRows, toCsv } from './core/export.ts';
import { fileHash, probe } from './core/media.ts';
import { MaybeLiveError, accountLabel, addTargets, assessMedia, cancelTarget, changeVisibility, hideComment, planAddTargets, createScheduledPost, describePrior, editPost, fetchComments, priorPosts, refreshStats, removeTarget, replyToComment, retryTarget, visibilityLabel, withTimeout } from './core/posting.ts';
import { applyPrune, formatBytes, planPrune } from './core/prune.ts';
import type { DoctorCheck, Limit, Provider, ProviderContext } from './core/provider.ts';
import { readLimits } from './core/limits.ts';
import { addLiveChecks } from './core/livepreview.ts';
import { settle, type RunnerDeps } from './core/runner.ts';
import { isTerminal } from './core/state.ts';
import type { CaptionFile, Post, PostInput, PostStats, Target, TargetInput, TargetState } from './core/types.ts';
import { BUILTIN_PROVIDERS, providerMap } from './providers/index.ts';
import { Dashboard } from './server/server.ts';
import { McpServer, serveStdio } from './mcp/server.ts';
import { refreshDueStats } from './core/stats.ts';
import { DEFAULT_STATS_EVERY_MS, Worker } from './core/worker.ts';
import { isShort } from './providers/youtube.ts';
import { currentLang, local, msg } from './core/i18n.ts';
import { ACCOUNT_NAME } from './core/store.ts';
import { disconnectAccount, signInExpiry, verifyDueAccounts } from './core/accounts.ts';
import { computeInsights, validTimeZone } from './core/insights.ts';

// ── Arg parsing ─────────────────────────────────────────────────────

export interface Args {
  positionals: string[];
  flags: Record<string, string | boolean | undefined>;
  /** Repeated flags, e.g. several --caption. */
  lists: Record<string, string[]>;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { positionals: [], flags: {}, lists: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      out.positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let value: string | boolean = true;
    if (eq > 0) value = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) value = argv[++i]!;
    out.flags[key] = value;
    if (typeof value === 'string') (out.lists[key] ??= []).push(value);
  }
  return out;
}

function str(args: Args, key: string): string | undefined {
  const v = args.flags[key];
  return typeof v === 'string' ? v : undefined;
}

function bool(args: Args, key: string): boolean | undefined {
  const v = args.flags[key];
  if (v === undefined) return undefined;
  if (v === true) return true;
  if (['yes', 'true', '1', 'y'].includes(String(v).toLowerCase())) return true;
  if (['no', 'false', '0', 'n'].includes(String(v).toLowerCase())) return false;
  throw new UsageError(msg('--{key} 값은 yes 또는 no', { key }));
}

function num(args: Args, key: string): number | undefined {
  const v = str(args, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(msg('--{key} 값은 숫자', { key }));
  return n;
}

class UsageError extends Error {}

// ── Per-platform options from flags ─────────────────────────────────

const TT_PRIVACY: Record<string, string> = {
  public: 'PUBLIC_TO_EVERYONE',
  friends: 'MUTUAL_FOLLOW_FRIENDS',
  followers: 'FOLLOWER_OF_CREATOR',
  private: 'SELF_ONLY',
};

/** Map CLI flags onto each provider's option object. Unset values stay unset so validation can insist on them. */
export function targetOptions(platform: string, args: Args): Record<string, unknown> {
  const drop = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  switch (platform) {
    case 'youtube':
      if (bool(args, 'paid-partnership')) console.error('⚠ ' + local(msg('--paid-partnership은 {platform} API로 표시할 수 없습니다. 앱에서 직접 설정하세요', { platform: 'YouTube' })));
      for (const gone of ['yt-paid-promo', 'yt-audio-lang']) {
        if (args.flags[gone] !== undefined) console.error('⚠ ' + local(msg('--{flag}는 YouTube API로 설정할 수 없어 무시합니다. YouTube Studio에서 직접 설정하세요', { flag: gone })));
      }
      return drop({
        privacy: str(args, 'yt-privacy'),
        madeForKids: bool(args, 'yt-made-for-kids'),
        categoryId: str(args, 'yt-category'),
        playlistId: str(args, 'yt-playlist'),
        notifySubscribers: args.flags['yt-no-notify'] ? false : undefined,
        defaultLanguage: str(args, 'yt-lang'),
        license: str(args, 'yt-license'),
        embeddable: bool(args, 'yt-embeddable'),
        publicStatsViewable: args.flags['yt-hide-stats'] ? false : undefined,
        localizations: localizationsFile(str(args, 'yt-localizations')),
        recordingDate: str(args, 'yt-recorded'),
      });
    case 'tiktok': {
      const privacy = str(args, 'tt-privacy');
      if (privacy && !TT_PRIVACY[privacy]) throw new UsageError(msg('--tt-privacy는 {values}', { values: Object.keys(TT_PRIVACY).join('|') }));
      return drop({
        mode: str(args, 'tt-mode') ?? 'inbox',
        caption: str(args, 'tt-caption'),
        privacyLevel: privacy ? TT_PRIVACY[privacy] : undefined,
        allowComment: bool(args, 'tt-allow-comment'),
        allowDuet: bool(args, 'tt-allow-duet'),
        allowStitch: bool(args, 'tt-allow-stitch'),
        brandOrganic: bool(args, 'tt-brand-organic'),
        brandedContent: bool(args, 'tt-branded') ?? bool(args, 'paid-partnership'),
        musicConsent: bool(args, 'tt-music-consent'),
        coverTimestampMs: num(args, 'tt-cover-ms'),
      });
    }
    case 'instagram':
      return drop({
        caption: str(args, 'ig-caption'),
        shareToFeed: args.flags['ig-no-feed'] ? false : undefined,
        thumbOffsetMs: num(args, 'ig-thumb-ms'),
        collaborators: str(args, 'ig-collab')?.split(',').map((u) => u.trim()).filter(Boolean),
        audioName: str(args, 'ig-audio'),
        trialReel: str(args, 'ig-trial'),
        paidPartnership: bool(args, 'paid-partnership'),
        userTags: str(args, 'ig-tag')?.split(',').map((u) => u.trim()).filter(Boolean),
        locationId: str(args, 'ig-location'),
      });
    case 'facebook':
      if (bool(args, 'paid-partnership')) console.error('⚠ ' + local(msg('--paid-partnership은 {platform} API로 표시할 수 없습니다. 앱에서 직접 설정하세요', { platform: 'Facebook' })));
      return drop({ caption: str(args, 'fb-caption'), title: str(args, 'fb-title'), draft: args.flags['fb-draft'] ? true : undefined, collaborators: str(args, 'fb-collab')?.split(',').map((p) => p.trim()).filter(Boolean), placeId: str(args, 'fb-place') });
    case 'x':
      return drop({ text: str(args, 'x-text'), paidPartnership: bool(args, 'x-paid-partnership') ?? bool(args, 'paid-partnership'), replySettings: str(args, 'x-reply'), alt: str(args, 'x-alt'), tagUsers: str(args, 'x-tag')?.split(',').map((u) => u.trim()).filter(Boolean), communityId: str(args, 'x-community') });
    case 'mastodon':
      return drop({ visibility: str(args, 'md-visibility'), text: str(args, 'md-text'), alt: str(args, 'md-alt'), language: str(args, 'md-lang'), spoilerText: str(args, 'md-cw') });
    case 'peertube':
      return drop({
        privacy: str(args, 'pt-privacy'),
        channel: str(args, 'pt-channel'),
        commentsPolicy: str(args, 'pt-comments'),
        nsfw: bool(args, 'pt-nsfw'),
        language: str(args, 'pt-lang'),
      });
    case 'bluesky':
      return drop({ text: str(args, 'bsky-text'), alt: str(args, 'bsky-alt'), langs: str(args, 'bsky-lang')?.split(',').map((l) => l.trim()) });
    default:
      return {};
  }
}

function parseTargets(spec: string, providers: Map<string, Provider>, args: Args, accounts: ReadonlyArray<{ platform: string; name: string }>): TargetInput[] {
  return spec.split(',').map((s) => {
    const [platform, explicit] = s.trim().split(':');
    if (!platform || !providers.has(platform)) throw new UsageError(msg('알 수 없는 플랫폼: {platform} (가능: {providers})', { platform, providers: [...providers.keys()].join(', ') }));
    // Without ":name", use "main" or the platform's only connected account.
    return { platform, account: explicit || defaultAccountName(accounts, platform), options: targetOptions(platform, args) };
  });
}

/** --yt-localizations file.json: { "en": { "title": "…", "description": "…" }, … } */
function localizationsFile(path: string | undefined): Record<string, { title: string; description?: string }> | undefined {
  if (!path) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(msg('--yt-localizations: JSON을 읽을 수 없습니다 ({err})', { err: (err as Error).message }));
  }
  const ok = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every((v) => v && typeof v === 'object' && typeof (v as { title?: unknown }).title === 'string');
  if (!ok) throw new UsageError(msg('--yt-localizations 형식: {"en": {"title": "…", "description": "…"}}'));
  return parsed as Record<string, { title: string; description?: string }>;
}

function parseCaptions(list: string[] | undefined): CaptionFile[] {
  return (list ?? []).map((c) => {
    const i = c.indexOf(':');
    if (i <= 0) throw new UsageError(msg(`--caption 형식은 언어:파일 (예: ko:subs.srt)`));
    const path = resolve(c.slice(i + 1));
    if (!existsSync(path)) throw new UsageError(msg('자막 파일 없음: {path}', { path }));
    return { language: c.slice(0, i), path };
  });
}

// ── Output ─────────────────────────────────────────────────────────

const STATE_ICON: Record<string, string> = {
  queued: '…',
  transcoding: '⚙',
  uploading: '↑',
  processing: '⧗',
  published: '✓',
  handed_off: '→',
  failed: '✗',
  needs_reauth: '🔑',
  removed: '⌫',
  canceled: '⊘',
};

function targetLine(t: Target): string {
  const head = `  ${STATE_ICON[t.state] ?? '?'} ${`${t.platform}/${t.account}`.padEnd(18)} ${t.state.padEnd(12)}`;
  const due = !t.notBefore ? '' : t.state === 'queued' ? local(msg('예정 {at}', { at: t.notBefore })) : t.state === 'processing' ? local(msg('{at}에 다시 확인', { at: t.notBefore })) : '';
  // A parked status check shows its time next to the link (a YouTube target has one from upload).
  const shown = t.state === 'processing' ? [t.remoteUrl, due] : [t.remoteUrl ?? due];
  const lines = [`${head} ${shown.filter(Boolean).join('  ')}`.trimEnd()];
  if (t.errorCode) lines.push(`      ${t.errorCode}: ${local(t.errorMessage ?? '')}`);
  for (const w of t.warnings) lines.push(`      ⚠ ${local(w)}`);
  return lines.join('\n');
}

function printPost(ctx: ProviderContext, post: Post, withEvents = false): void {
  console.log(`\n${post.id.slice(0, 8)}  "${post.title}"  ${post.createdAt}`);
  for (const t of ctx.store.targetsForPost(post.id)) {
    console.log(targetLine(t));
    if (withEvents) {
      for (const e of ctx.store.events(t.id)) console.log(`        ${e.at}  ${e.from ?? '·'} → ${e.to}${e.detail ? `  (${local(e.detail)})` : ''}`);
    }
  }
}

function accountLine(ctx: ProviderContext, t: { platform: string; account: string }): string {
  const acct = ctx.store.getAccount(t.platform, t.account);
  if (!acct) return local(msg('{platform}/{account} (연결 안 됨)', { platform: t.platform, account: t.account }));
  return `${t.platform}/${t.account} → ${accountLabel(acct.profile, t.account)}`;
}

/** A message for the person at the terminal, in FANOUT_LANG. */
function say(text: string): void {
  console.log(local(text));
}

function sayErr(text: string): void {
  console.error(local(text));
}

const LOCALE = () => (currentLang() === 'en' ? 'en-US' : 'ko-KR');

/** Reach, saves, watch time and subscribers gained where the platform reports them (Instagram, Facebook, YouTube). */
function deeper(stats: PostStats | undefined, fmt: (n?: number) => string): string {
  if (!stats) return '';
  const parts = [
    stats.reach !== undefined ? local(msg('도달 {n}', { n: fmt(stats.reach) })) : '',
    stats.saves !== undefined ? local(msg('저장 {n}', { n: fmt(stats.saves) })) : '',
    stats.avgWatchSec !== undefined ? local(msg('평균 시청 {s}초', { s: stats.avgWatchSec })) : '',
    stats.avgViewPct !== undefined ? local(msg('평균 {p}% 시청', { p: stats.avgViewPct })) : '',
    stats.watchTimeSec !== undefined ? local(msg('총 시청 {h}시간', { h: Math.round(stats.watchTimeSec / 360) / 10 })) : '',
    stats.subscribersGained !== undefined ? local(msg('구독 +{n}', { n: fmt(stats.subscribersGained) })) : '',
  ].filter(Boolean);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

/** "조회 1 · 좋아요 2 · 댓글 3 · 공유 4" in FANOUT_LANG. */
function counts(views: string, likes: string, comments: string, shares: string): string {
  return local(msg('조회 {views} · 좋아요 {likes} · 댓글 {comments} · 공유 {shares}', { views, likes, comments, shares }));
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${local(question)} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

function settleOpts(ctx: ProviderContext) {
  return {
    pollIntervalMs: 10_000,
    timeoutMs: 30 * 60_000,
    onChange: (t: Target) => ctx.log.info(targetLine(t)),
  };
}

// ── Commands ───────────────────────────────────────────────────────

const HELP = msg(`fanout — 영상 하나를 여러 플랫폼에 올리는 셀프호스팅 업로더

  fanout platforms                       지원 플랫폼과 기능
  fanout setup <platform>                내 개발자 앱(BYO) 만드는 방법
  fanout app set <platform> [--key 값]   BYO 앱 자격증명 저장 (instagram·facebook은 meta)
  fanout connect <platform> [--name main] [--token T] [--page ID] [--handle H] [--instance URL]
                                         PeerTube: --instance URL --username U --password P [--otp 코드]
  fanout accounts                        연결된 계정
  fanout disconnect <platform> <name>
  fanout doctor [platform] [--account main] [--live]   플랫폼 없이: 연결된 모든 계정 점검
  fanout check <video> [--to youtube,tiktok]
  fanout post <video> --title T --to youtube,tiktok:main,instagram,facebook [옵션]
  fanout add <postId> --to tiktok,x [플랫폼 옵션] [--yes]   이미 만든 게시물에 플랫폼 추가 (원본이 남아 있을 때)
  fanout status [postId] [--events]
  fanout retry <postId> [platform]
  fanout run                             밀린 작업 처리 후 종료
  fanout worker [--interval 60] [--stats-every 6]   예약·재시도 작업을 계속 처리 (+ 최근 30일 게시물 반응을 6시간마다 기록, 0이면 끔)
  fanout serve [--port 8780] [--host 127.0.0.1] [--keep-days 7 | --no-prune] [--stats-every 6]
                                         웹 대시보드 (작업 처리, 6시간마다 자동 정리 포함)
  fanout edit <postId> [--title T] [--description D | --description-file F] [--tags a,b]
                                         제목·설명·태그 수정 (YouTube·Facebook·Mastodon·PeerTube에 반영)
  fanout cancel <postId> [platform] [--confirmed-not-posted]   아직 안 올라간(대기·예약·실패) 대상 취소
  fanout visibility <postId> youtube public|unlisted|private [--at 시각]   게시된 영상의 공개 범위 변경 (--at: 그 시각에 공개)
  fanout remove <postId> <platform> [--account main] [--yes]   게시물을 플랫폼에서 삭제 (되돌릴 수 없음)
  fanout comments <postId> [--limit 20]  게시된 대상의 최근 댓글 (YouTube·Facebook·Instagram·Bluesky·Mastodon·PeerTube)
  fanout reply <postId> <platform> <commentId> <내용…> [--account main] [--yes]   댓글에 답글 (comments 의 [id])
  fanout hide-comment <postId> <platform> <commentId> [--show] [--account main]   댓글 숨기기 (YouTube·Instagram·Facebook, --show로 되돌림)
  fanout stats [postId] [--include-paid] [--history]  게시된 영상의 조회·좋아요·댓글과 24시간 변화 (X는 --include-paid일 때만)
  fanout limits [platform]               계정별 남은 게시 한도 (YouTube 하루 업로드, Instagram 24시간 게시, Bluesky·PeerTube 용량)
  fanout insights [platform] [--days 30] [--tz Asia/Seoul]   잘 되는 게시물·요일·시간 (기록된 반응 기준, API 호출 없음)
  fanout notify set <webhook URL> [--events failed,needs_reauth,published,handed_off,alert,expiring] [--format slack|discord|json]
  fanout notify test | off               상태 알림 (Slack·Discord·JSON webhook)
  fanout backup <폴더> [--without-key]    DB 스냅샷(+복호화 키) 백업 — 실행 중에도 안전
  fanout restore <백업 폴더> [--yes]      백업으로 되돌리기 (먼저 검사, 지금 데이터는 따로 보관)
  fanout export [--format csv|json] [--out 파일]   게시 기록 내보내기 (게시물 × 플랫폼, 상태, 링크, 통계)
  fanout prune [--days 7] [--dry-run]    다 올린 원본·오래된 변환 파일 정리 (~/.fanout 안만)
  fanout mcp                             MCP 서버 (stdio) — AI 에이전트용 도구, 업로드 처리 포함
                                         --allow 폴더1,폴더2 (또는 FANOUT_MCP_ROOTS): 에이전트가 읽을 수 있는 폴더 제한
  fanout watch <폴더> --init             감시 폴더와 예시 설정(fanout.watch.json) 만들기
  fanout watch <폴더> [--yes] [--once] [--interval 15] [--settle 10]
                                         폴더에 넣은 영상을 설정대로 자동으로 올림
                                         (--once: 지금 있는 영상만 올리고 종료, cron용)

post 공통 옵션
  --description 텍스트 | --description-file 파일   --tags a,b,c
  --thumbnail 이미지   --caption ko:subs.srt (여러 번)   --ai (AI 생성·합성 콘텐츠 표시: YouTube·TikTok·Instagram·X)
  --paid-partnership yes (유료 파트너십·광고 표시: X·TikTok(direct)·Instagram)
  --at 2026-10-20T09:00:00+09:00 (예약)   --yes (확인 생략)   --no-wait

플랫폼별 옵션
  YouTube    --yt-privacy public|unlisted|private (필수)  --yt-made-for-kids yes|no (필수)
             --yt-category 22  --yt-playlist ID  --yt-no-notify  --yt-lang ko
             --yt-license creativeCommon  --yt-embeddable no  --yt-hide-stats (확장 통계 숨김)
             --yt-localizations titles.json ({"en": {"title": "…", "description": "…"}})
             --yt-recorded 2026-10-18 (촬영일)
  TikTok     --tt-mode inbox|direct (기본 inbox)
             direct 전용: --tt-privacy public|friends|followers|private (필수)
             --tt-music-consent yes (필수)  --tt-allow-comment/--tt-allow-duet/--tt-allow-stitch yes
             --tt-brand-organic yes  --tt-branded yes  --tt-caption 텍스트  --tt-cover-ms 1000
  Instagram  --ig-caption 텍스트  --ig-no-feed  --ig-thumb-ms 1000  --ig-collab 사용자1,사용자2 (공동 작업자, 3명까지)  --ig-audio 오디오이름
             --ig-trial manual|auto (시험 릴스: 팔로워가 아닌 사람에게 먼저, auto면 반응이 좋을 때 자동 공유)  --ig-tag 사용자1,사용자2 (사람 태그)  --ig-location 페이지ID (장소)
  Facebook   --fb-caption 텍스트  --fb-title 제목  --fb-draft (게시하지 않고 초안으로)  --fb-collab 페이지ID,… (공동 작업자)  --fb-place 페이지ID (장소)
  X          --x-text 텍스트 (가중치 280 이하, 한글은 2로 셈)  --x-paid-partnership yes  --x-reply following|mentionedUsers|subscribers|verified
             --x-alt 대체텍스트 (1000자 이하)  --x-tag 사용자1,사용자2 (사람 태그, 10명까지)  --x-community ID
  Bluesky    --bsky-text 텍스트(300자 이하)  --bsky-alt 대체텍스트  --bsky-lang ko,en
  Mastodon   --md-visibility public|unlisted|private (필수)  --md-text 텍스트  --md-alt 대체텍스트
             --md-lang ko  --md-cw 내용경고
  PeerTube   --pt-privacy public|unlisted|private|internal (필수)  --pt-channel 채널  --pt-comments enabled|disabled|approval
             --pt-lang ko  --pt-nsfw

데이터 위치: FANOUT_HOME (기본 ~/.fanout). 토큰은 AES-256-GCM으로 암호화해 저장합니다.
언어: FANOUT_LANG=en 이면 영어로 출력합니다 (기본 한국어, fanout mcp는 기본 영어이고 FANOUT_LANG=ko 이면 한국어).`);

async function cmdPlatforms(providers: Map<string, Provider>): Promise<void> {
  for (const p of providers.values()) {
    const c = p.capabilities;
    const caps = [c.nativeSchedule && msg('네이티브 예약'), c.thumbnail && msg('썸네일'), c.captions && msg('자막'), c.syntheticMediaFlag && msg('AI 표시')].filter((x): x is string => Boolean(x)).map(local);
    console.log(`${p.id.padEnd(10)} ${p.displayName.padEnd(24)} ${caps.join(', ') || '-'}${p.appKey ? `  ${local(msg('(앱: {app})', { app: p.appKey }))}` : ''}`);
  }
}

async function cmdAppSet(ctx: ProviderContext, provider: Provider, args: Args): Promise<void> {
  const key = provider.appKey ?? provider.id;
  const config: Record<string, unknown> = { ...(ctx.store.getApp(key) ?? {}) };
  const file = str(args, 'file');
  if (file) {
    // Google's downloaded client JSON: { installed: { client_id, client_secret } } or { web: {...} }.
    const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { client_id?: string; client_secret?: string }>;
    const inner = json.installed ?? json.web;
    if (!inner?.client_id) throw new UsageError(msg('client_id가 있는 Google OAuth JSON이 아닙니다'));
    config.clientId = inner.client_id;
    config.clientSecret = inner.client_secret;
  }
  for (const f of provider.appFields) {
    const v = str(args, f.key);
    if (v !== undefined) config[f.key] = v;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const f of provider.appFields) {
      if (config[f.key] === undefined && !f.optional) config[f.key] = (await rl.question(`${f.label}: `)).trim();
    }
  } finally {
    rl.close();
  }
  ctx.store.setApp(key, config);
  const saved = provider.appFields.filter((f) => config[f.key] !== undefined).map((f) => f.key);
  say(saved.length ? msg('{key} 앱 저장됨 ({fields})', { key, fields: saved.join(', ') }) : msg('{key} 앱 저장됨', { key }));
}

/**
 * The account a command means when none is named: "main", or the platform's only account. With
 * several and no "main", asking beats guessing (connect would otherwise add a new "main").
 */
export function namedOrOnly(ctx: ProviderContext, platform: string, given: string | undefined, flag: string): string {
  if (given) return given;
  const names = ctx.store.listAccounts().filter((a) => a.platform === platform).map((a) => a.name);
  if (names.length > 1 && !names.includes('main')) {
    throw new UsageError(msg('{platform} 계정이 여러 개입니다 ({names}) — {flag} 로 고르세요', { platform, names: names.join(', '), flag }));
  }
  return defaultAccountName(ctx.store.listAccounts(), platform);
}

async function cmdDoctor(ctx: ProviderContext, provider: Provider, args: Args): Promise<number> {
  const name = namedOrOnly(ctx, provider.id, str(args, 'account'), '--account');
  const account = ctx.store.getAccount(provider.id, name);
  if (!account) {
    say(msg('{id}/{name} 계정이 연결되지 않았습니다. 먼저: fanout setup {id}', { id: provider.id, name }));
    return 1;
  }
  const checks: DoctorCheck[] = await provider.doctor({ ctx, account, live: Boolean(args.flags.live) });
  const icon = { ok: '✓', warn: '⚠', fail: '✗', info: 'ℹ' } as const;
  for (const c of checks) console.log(`${icon[c.status]} ${local(c.name)}: ${local(c.detail)}`);
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}

/** `fanout doctor` with no platform: check every connected account (never --live, which posts). */
async function cmdDoctorAll(ctx: ProviderContext, providers: Map<string, Provider>, args: Args): Promise<number> {
  if (args.flags.live) throw new UsageError(msg('--live 는 테스트 게시물을 실제로 올리므로 플랫폼을 지정해서 하나씩 실행하세요: fanout doctor <platform> --live'));
  if (args.flags.account) throw new UsageError(msg('--account 는 플랫폼과 함께 쓰세요: fanout doctor <platform> --account <이름>'));
  const accounts = ctx.store.listAccounts();
  if (!accounts.length) {
    say(msg('연결된 계정이 없습니다. fanout setup <platform> 부터 시작하세요'));
    return 1;
  }
  const icon = { ok: '✓', warn: '⚠', fail: '✗', info: 'ℹ' } as const;
  const failed: string[] = [];
  for (const a of accounts) {
    const provider = providers.get(a.platform);
    console.log(`\n== ${a.platform}/${a.name}`);
    if (!provider) {
      say(msg('✗ 이 버전의 fanout이 모르는 플랫폼입니다'));
      failed.push(`${a.platform}/${a.name}`);
      continue;
    }
    let checks: DoctorCheck[];
    try {
      const account = ctx.store.getAccount(a.platform, a.name)!;
      checks = await provider.doctor({ ctx: withTimeout(ctx, 30_000), account, live: false });
    } catch (err) {
      checks = [{ name: msg('점검'), status: 'fail', detail: err instanceof Error ? err.message : String(err) }];
    }
    for (const c of checks) console.log(`${icon[c.status]} ${local(c.name)}: ${local(c.detail)}`);
    if (checks.some((c) => c.status === 'fail')) failed.push(`${a.platform}/${a.name}`);
  }
  say(failed.length ? msg('\n{count}개 계정 점검, 문제 있음: {failed}', { count: accounts.length, failed: failed.join(', ') }) : msg('\n{count}개 계정 점검, 모두 정상', { count: accounts.length }));
  return failed.length ? 1 : 0;
}

async function cmdCheck(providers: Map<string, Provider>, args: Args): Promise<void> {
  const file = args.positionals[1];
  if (!file) throw new UsageError('fanout check <video>');
  const media = await probe(resolve(file));
  const v = media.video;
  const audio = media.audio ? `${media.audio.codec} ${media.audio.sampleRate}Hz` : local(msg('오디오 없음'));
  console.log(`${file}: ${v.width}x${v.height} ${v.codec} ${v.fps.toFixed(2)}fps, ${media.durationSec.toFixed(1)}s, ${(media.sizeBytes / 1024 / 1024).toFixed(1)}MB, ${audio}`);
  const ids = str(args, 'to')?.split(',').map((s) => s.split(':')[0]!) ?? [...providers.keys()];
  const selected = ids.map((id) => providers.get(id)).filter((p): p is Provider => Boolean(p));
  const label = { as_is: msg('✓ 원본 그대로'), transcode: msg('⚙ 변환 후 업로드'), blocked: msg('✗ 올릴 수 없음') } as const;
  for (const a of assessMedia(media, selected)) {
    console.log(`  ${a.platform.padEnd(10)} ${local(label[a.verdict])}${a.platform === 'youtube' && isShort(media) ? ` ${local(msg('(Shorts로 분류)'))}` : ''}`);
    for (const x of a.violations) console.log(`      ${x.fixable ? '⚙' : '✗'} ${local(x.message)}`);
  }
}

async function cmdPost(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const file = args.positionals[1];
  const title = str(args, 'title');
  const to = str(args, 'to');
  if (!file || !title || !to) throw new UsageError(msg('fanout post <video> --title 제목 --to youtube,tiktok,...'));
  const mediaPath = resolve(file);
  if (!existsSync(mediaPath)) throw new UsageError(msg('파일 없음: {path}', { path: mediaPath }));
  const descFile = str(args, 'description-file');
  const thumb = str(args, 'thumbnail');
  const at = str(args, 'at');
  if (at && Number.isNaN(Date.parse(at))) throw new UsageError(msg('--at 은 ISO-8601 시각 (예: 2026-10-20T09:00:00+09:00)'));

  const input: PostInput = {
    mediaPath,
    title,
    description: descFile ? readFileSync(descFile, 'utf8') : (str(args, 'description') ?? ''),
    tags: (str(args, 'tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    thumbnailPath: thumb ? resolve(thumb) : undefined,
    captions: parseCaptions(args.lists.caption),
    containsSyntheticMedia: Boolean(args.flags.ai),
    scheduledAt: at ? new Date(at).toISOString() : undefined,
  };
  const targets = parseTargets(to, deps.providers, args, ctx.store.listAccounts());
  input.mediaHash = await fileHash(mediaPath);
  const prior = priorPosts(ctx.store, input.mediaHash, targets);
  const limitNotes = targets.map((t) => ({ platform: t.platform, account: t.account, warnings: [] as string[], errors: [] as string[] }));
  await addLiveChecks(ctx, deps.providers, limitNotes, { input, targets, media: await probe(mediaPath) });

  // YouTube policy: show which channel and which visibility before uploading.
  console.log(`\n"${title}"  ${mediaPath}${input.scheduledAt ? `  ${local(msg('예약 {at}', { at: input.scheduledAt }))}` : ''}`);
  for (const t of targets) {
    console.log(`  ${accountLine(ctx, t).padEnd(40)} ${local(visibilityLabel(t, input.scheduledAt))}`);
    const before = prior.get(`${t.platform}/${t.account}`)?.[0];
    if (before) console.log(`      ⚠ ${local(describePrior(before))}`);
  }
  const blockers = limitNotes.flatMap((n) => n.errors.map((e) => `${n.platform}/${n.account}: ${e}`));
  for (const e of blockers) console.log(`  ✗ ${local(e)}`);
  for (const w of new Set(limitNotes.flatMap((n) => n.warnings.map((w) => `${n.platform}/${n.account}: ${w}`)))) console.log(`  ⚠ ${local(w)}`);
  // The account itself refuses these (e.g. a TikTok privacy level it doesn't allow): don't create the post.
  if (blockers.length) return 1;
  if (!args.flags.yes && !(await confirm(msg('이대로 업로드할까요?')))) return 1;

  const { post } = createScheduledPost(ctx.store, deps.providers, input, targets);
  say(msg('post {id} 생성', { id: post.id.slice(0, 8) }));
  if (args.flags['no-wait']) return 0;

  const due = ctx.store.targetsForPost(post.id).filter((t) => !t.notBefore || new Date(t.notBefore) <= ctx.now());
  await settle(deps, due.map((t) => t.id), settleOpts(ctx));
  printPost(ctx, post);
  const after = ctx.store.targetsForPost(post.id);
  if (after.some((t) => t.notBefore && t.state === 'queued')) say(msg('\n예약된 대상이 있습니다. 예약 시각에 올리려면 fanout worker 를 켜 두세요.'));
  return after.some((t) => t.state === 'failed' || t.state === 'needs_reauth') ? 1 : 0;
}

async function cmdAdd(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const post = args.positionals[1] ? ctx.store.findPost(args.positionals[1]) : undefined;
  const to = str(args, 'to');
  if (!post || !to) throw new UsageError(msg('fanout add <postId> --to tiktok,x [플랫폼 옵션] [--yes] [--no-wait]'));
  const targets = parseTargets(to, deps.providers, args, ctx.store.listAccounts());
  const fail = (err: unknown): never => {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  };
  if (!existsSync(post.mediaPath)) fail(new Error(msg('원본 영상이 이미 정리돼 없습니다. 새 게시물로 올리세요')));
  const media = await (deps.probe ?? probe)(post.mediaPath);
  let plan: ReturnType<typeof planAddTargets>;
  try {
    plan = planAddTargets(ctx.store, deps.providers, post.id, targets, media);
  } catch (err) {
    return fail(err);
  }
  await addLiveChecks(ctx, deps.providers, plan.preview, { input: post, targets, media });
  const adding = local(msg('"{title}"에 추가', { title: post.title }));
  const at = post.scheduledAt ? local(msg('예약 {at}', { at: post.scheduledAt })) : '';
  console.log(`\n${adding}${at ? `  ${at}` : ''}`);
  for (const p of plan.preview) {
    console.log(`  ${accountLine(ctx, p).padEnd(40)} ${local(p.visibility)}`);
    for (const e of p.errors) console.log(`      ✗ ${local(e)}`);
    for (const w of p.warnings) console.log(`      ⚠ ${local(w)}`);
  }
  if (plan.preview.some((p) => p.errors.length)) return 1;
  if (!args.flags.yes && !(await confirm(msg('이대로 추가해 업로드할까요?')))) return 1;
  const created = addTargets(ctx.store, deps.providers, post.id, targets, media);
  say(msg('{count}곳 추가', { count: created.length }));
  if (args.flags['no-wait']) return 0;
  const due = created.filter((t) => !t.notBefore || new Date(t.notBefore) <= ctx.now());
  await settle(deps, due.map((t) => t.id), settleOpts(ctx));
  printPost(ctx, post);
  return ctx.store.targetsForPost(post.id).some((t) => created.some((c) => c.id === t.id) && (t.state === 'failed' || t.state === 'needs_reauth')) ? 1 : 0;
}

async function cmdRun(ctx: ProviderContext, deps: RunnerDeps): Promise<number> {
  const ids = ctx.store.workableTargets().map((t) => t.id);
  if (!ids.length) {
    say(msg('처리할 작업 없음'));
    return 0;
  }
  const done = await settle(deps, ids, settleOpts(ctx));
  const postIds = [...new Set(done.map((t) => t.postId))];
  for (const id of postIds) printPost(ctx, ctx.store.getPost(id)!);
  return done.some((t) => t.state === 'failed' || t.state === 'needs_reauth') ? 1 : 0;
}

/** `--stats-every <hours>` (0 = off) for the background stats refresh. */
function statsEvery(args: Args): number {
  const hours = num(args, 'stats-every');
  return hours === undefined ? DEFAULT_STATS_EVERY_MS : Math.max(0, hours) * 3600_000;
}

async function cmdWorker(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<never> {
  const interval = (num(args, 'interval') ?? 60) * 1000;
  const everyMs = statsEvery(args);
  say(msg('worker 시작 ({interval}s 간격, Ctrl+C로 종료)', { interval: interval / 1000 }));
  // Stats run beside uploads, never in front of them: a slow instance mustn't hold back a scheduled post.
  let stats: Promise<unknown> | undefined;
  let upkeep: Promise<unknown> | undefined;
  for (;;) {
    // Account checks some platforms' terms require (core/accounts.ts); each account at most daily.
    upkeep ??= verifyDueAccounts(ctx, deps.providers)
      .catch((err: unknown) => ctx.log.warn(`verify: ${String(err)}`))
      .finally(() => {
        upkeep = undefined;
      });
    if (everyMs > 0 && !stats) {
      stats = refreshDueStats(ctx, deps.providers, (postId, platform) => refreshStats(ctx, deps.providers, postId, { platform }), { everyMs })
        .catch((err: unknown) => ctx.log.warn(`stats: ${String(err)}`))
        .finally(() => {
          stats = undefined;
        });
    }
    const ids = ctx.store.workableTargets().map((t) => t.id);
    if (ids.length) await settle(deps, ids, { ...settleOpts(ctx), timeoutMs: interval });
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function cmdWatch(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const dirArg = args.positionals[1];
  if (!dirArg) throw new UsageError(msg('fanout watch <폴더> [--init] [--once] [--yes] [--interval 15] [--settle 10]'));
  const dir = resolve(dirArg);
  if (args.flags.init) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, CONFIG_FILE);
    if (existsSync(path)) throw new UsageError(msg('이미 있습니다: {path}', { path }));
    writeFileSync(path, `${JSON.stringify(exampleConfig(ctx.store.listAccounts()), null, 2)}\n`);
    say(msg('예시 설정을 만들었습니다: {path}\n올릴 곳(to)과 플랫폼별 옵션을 확인한 뒤 fanout watch {dir} 로 시작하세요.', { path, dir: dirArg }));
    return 0;
  }
  if (!existsSync(dir)) throw new UsageError(msg('폴더 없음: {dir}', { dir }));
  let config: WatchConfig;
  try {
    config = loadWatchConfig(dir);
  } catch (err) {
    if (err instanceof WatchConfigError) throw new UsageError(err.message);
    throw err;
  }

  // YouTube policy: show the destination accounts and visibility before anything is uploaded.
  say(msg('\n감시 폴더: {dir}', { dir }));
  const connected = ctx.store.listAccounts();
  const accountOf = (platform: string, explicit?: string) => {
    try {
      return explicit || watchAccount(connected, platform);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
  };
  for (const spec of config.to ?? []) {
    const [platform = '', explicit] = spec.split(':');
    if (!deps.providers.has(platform)) throw new UsageError(msg('{file}: 알 수 없는 플랫폼 {platform}', { file: CONFIG_FILE, platform }));
    const account = accountOf(platform, explicit);
    const t: TargetInput = { platform, account, options: config.options?.[platform] ?? {} };
    const when = config.at ?? (config.slots?.length ? msg('다음 빈 슬롯({slots})', { slots: config.slots.join(', ') }) : undefined);
    console.log(`  ${accountLine(ctx, t).padEnd(40)} ${local(visibilityLabel(t, when))}`);
  }
  say(msg('  (영상별 <이름>.json 이 있으면 그 값이 우선합니다)'));
  const missing = (config.to ?? []).map((s) => s.split(':')).map(([p = '', a]) => [p, accountOf(p, a)] as const).filter(([p, a]) => !ctx.store.getAccount(p, a));
  if (missing.length) {
    throw new UsageError(msg('연결되지 않은 계정이 있어 시작하지 않습니다: {accounts}\n먼저 fanout connect 또는 대시보드 설정 탭에서 연결하세요.', { accounts: missing.map(([p, a]) => `${p}/${a}`).join(', ') }));
  }
  if (!args.flags.yes && !(await confirm(msg('이 폴더에 들어오는 영상을 위 설정대로 올릴까요?')))) return 1;

  const once = Boolean(args.flags.once);
  const interval = (num(args, 'interval') ?? 15) * 1000;
  const scanner = new Scanner(dir, (num(args, 'settle') ?? 10) * 1000);
  const probeFn = deps.probe ?? probe;
  let failures = 0;

  const scan = async (): Promise<void> => {
    for (const videoPath of scanner.ready(!once)) {
      scanner.forget(videoPath);
      let r: Awaited<ReturnType<typeof ingest>>;
      try {
        r = await ingest({ dir, config, videoPath, providers: deps.providers, store: ctx.store, probe: probeFn, now: ctx.now(), mediaDir: join(ctx.home, 'media') });
      } catch (err) {
        // One bad video (or a busy database) must not stop the watcher; it is picked up again next scan.
        failures++;
        console.log(`✗ ${basename(videoPath)}: ${local(err instanceof Error ? err.message : String(err))}`);
        continue;
      }
      if (!r.ok) {
        failures++;
        console.log(`✗ ${basename(videoPath)}: ${local(r.error)}\n    → ${r.movedTo}`);
        continue;
      }
      const when = r.plan.input.scheduledAt ? ', ' + local(msg('예약 {at}', { at: new Date(r.plan.input.scheduledAt).toLocaleString(LOCALE()) })) : '';
      console.log(`+ ${basename(videoPath)} → post ${r.postId.slice(0, 8)} "${r.plan.input.title}" (${r.plan.targets.map((t) => t.platform).join(', ')}${when})`);
      for (const s of r.plan.skipped) say(msg('    건너뜀 {platform}: {reason}', { platform: s.platform, reason: s.reason }));
    }
  };

  if (once) {
    await scan();
    const code = await cmdRun(ctx, deps);
    return failures ? 1 : code;
  }

  say(msg('감시 시작 ({interval}s 간격, Ctrl+C로 종료). 올린 영상은 posted/, 실패한 영상은 failed/ 로 옮깁니다.', { interval: interval / 1000 }));
  let stop = false;
  process.once('SIGINT', () => {
    stop = true;
    say(msg('\n종료 중… 진행 중인 업로드는 다음 실행 때 이어서 처리됩니다'));
  });
  while (!stop) {
    await scan();
    const ids = ctx.store.workableTargets().map((t) => t.id);
    if (ids.length) await settle(deps, ids, { ...settleOpts(ctx), timeoutMs: interval });
    else await new Promise((r) => setTimeout(r, interval));
  }
  return 0;
}

async function cmdServe(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const host = str(args, 'host') ?? '127.0.0.1';
  const assumeLocal = process.env.FANOUT_ASSUME_LOCAL === '1';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host) || assumeLocal;
  const token = process.env.FANOUT_DASHBOARD_TOKEN;
  if (!loopback && !token) {
    throw new UsageError(msg('127.0.0.1이 아닌 주소로 열려면 FANOUT_DASHBOARD_TOKEN 환경 변수로 접속 토큰을 정하세요'));
  }
  const dashboard = new Dashboard({
    ctx,
    providers: deps.providers,
    host,
    port: num(args, 'port') ?? 8780,
    token,
    allowedHosts: str(args, 'allow-host')?.split(','),
    pruneDays: args.flags['no-prune'] ? null : (num(args, 'keep-days') ?? 7),
    statsEveryMs: statsEvery(args),
    assumeLocal,
  });
  const url = await dashboard.start();
  say(msg('fanout 대시보드: {url}', { url }));
  if (!loopback) say(msg('외부 접속 허용 중입니다. 페이지에서 FANOUT_DASHBOARD_TOKEN 값을 입력해야 합니다. HTTPS 리버스 프록시 뒤에 두세요.'));
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  say(msg('\n대시보드 종료 중… 진행 중인 업로드는 다음 실행 때 이어서 처리됩니다'));
  await dashboard.stop();
  return 0;
}

/** Comments are other people's text: drop control and format characters (terminal escapes, bidi overrides). */
export function printable(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '');
}

async function cmdComments(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const post = args.positionals[1] ? ctx.store.findPost(args.positionals[1]) : undefined;
  if (!post) throw new UsageError('fanout comments <postId> [--limit 20]');
  for (const r of await fetchComments(ctx, deps.providers, post.id, num(args, 'limit') ?? 20)) {
    console.log(`\n${r.platform}/${r.account}${r.skipped ? ` — ${local(r.skipped)}` : r.error ? ` — ✗ ${local(r.error)}` : ` — ${local(msg('댓글 {count}개', { count: r.comments!.length }))}`}`);
    for (const c of r.comments ?? []) {
      const author = printable(c.author) || local(msg('(이름 없음)'));
      const hidden = c.hidden ? '  ' + local(msg('(숨김 — hide-comment --show로 되돌림)')) : '';
      console.log(`  ${c.at.slice(0, 16).replace('T', ' ')}  ${author}${c.likes ? `  ♥${c.likes}` : ''}${c.replies ? `  ↳${c.replies}` : ''}${r.canReply || r.canHide ? `  [${c.id}]` : ''}${hidden}`);
      console.log(`    ${printable(c.text).slice(0, 200)}`);
    }
  }
  return 0;
}

async function cmdEdit(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const post = args.positionals[1] ? ctx.store.findPost(args.positionals[1]) : undefined;
  if (!post) throw new UsageError('fanout edit <postId> [--title] [--description] [--tags]');
  const descFile = str(args, 'description-file');
  const patch = {
    ...(str(args, 'title') !== undefined ? { title: str(args, 'title')! } : {}),
    ...(descFile ? { description: readFileSync(descFile, 'utf8') } : str(args, 'description') !== undefined ? { description: str(args, 'description')! } : {}),
    ...(str(args, 'tags') !== undefined ? { tags: str(args, 'tags')!.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
  };
  if (!Object.keys(patch).length) throw new UsageError(msg('바꿀 것을 하나 이상 주세요 (--title, --description, --tags)'));
  const icon = { updated: '✓', skipped: '·', failed: '✗' } as const;
  for (const r of await editPost(ctx, deps.providers, post.id, patch)) {
    const result = local(r.status === 'updated' ? msg('반영함') : (r.detail ?? ''));
    console.log(`  ${icon[r.status]} ${`${r.platform}/${r.account}`.padEnd(18)} ${result}`);
  }
  return 0;
}

async function cmdCancel(ctx: ProviderContext, args: Args): Promise<number> {
  const post = args.positionals[1] ? ctx.store.findPost(args.positionals[1]) : undefined;
  if (!post) throw new UsageError('fanout cancel <postId> [platform]');
  const only = args.positionals[2];
  const targets = ctx.store.targetsForPost(post.id).filter((t) => (!only || t.platform === only) && ['queued', 'failed', 'needs_reauth'].includes(t.state));
  if (!targets.length) {
    say(msg('취소할 대상이 없습니다 (이미 올라갔거나 처리 중)'));
    return 1;
  }
  let failed = 0;
  for (const t of targets) {
    try {
      try {
        cancelTarget(ctx.store, t.id, { confirmedNotPosted: bool(args, 'confirmed-not-posted') });
      } catch (err) {
        // May already be live: only cancel once the user has checked the platform.
        if (!(err instanceof MaybeLiveError) || !process.stdin.isTTY) throw err;
        console.log(`  ! ${local(err.message)}`);
        if (!(await confirm(msg('  {platform}에서 직접 확인했고 올라가지 않았나요?', { platform: t.platform })))) throw new Error(msg('취소하지 않았습니다'));
        cancelTarget(ctx.store, t.id, { confirmedNotPosted: true });
      }
      say(msg('  ⊘ {platform}/{account} 취소함', { platform: t.platform, account: t.account }));
    } catch (err) {
      failed++;
      console.log(`  ✗ ${t.platform}/${t.account} ${local((err as Error).message)}`);
    }
  }
  return failed ? 1 : 0;
}

async function cmdReply(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const [, id, platform, commentId, ...words] = args.positionals;
  const usage = msg('fanout reply <postId> <platform> <commentId> <내용…> [--account main] [--yes]');
  const post = id ? ctx.store.findPost(id) : undefined;
  const text = words.join(' ').trim();
  if (!post || !platform || !commentId || !text) throw new UsageError(usage);
  const account = str(args, 'account');
  const candidates = ctx.store.targetsForPost(post.id).filter((t) => t.platform === platform && (!account || t.account === account));
  if (candidates.length !== 1) throw new UsageError(candidates.length ? msg('계정이 여러 개입니다. --account 로 고르세요: {candidates}', { candidates: candidates.map((t) => t.account).join(', ') }) : msg('{platform} 대상이 없습니다', { platform }));
  const t = candidates[0]!;
  say(msg('{platform}/{account} 댓글 {commentId}에 답글:\n  {text}', { platform: t.platform, account: t.account, commentId, text }));
  if (!args.flags.yes && !(await confirm(msg('이 계정 이름으로 공개 답글을 달까요?')))) return 1;
  const out = await replyToComment(ctx, deps.providers, t.id, commentId, text).catch((err: Error) => {
    throw err instanceof ProviderError ? err : new UsageError(err.message);
  });
  say(out.url ? msg('답글을 달았습니다: {url}', { url: out.url }) : msg('답글을 달았습니다'));
  return 0;
}

async function cmdHideComment(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const [, id, platform, commentId] = args.positionals;
  const post = id ? ctx.store.findPost(id) : undefined;
  if (!post || !platform || !commentId) throw new UsageError(msg('fanout hide-comment <postId> <platform> <commentId> [--show] [--account main]'));
  const account = str(args, 'account');
  const candidates = ctx.store.targetsForPost(post.id).filter((t) => t.platform === platform && (!account || t.account === account));
  if (candidates.length !== 1) throw new UsageError(candidates.length ? msg('계정이 여러 개입니다. --account 로 고르세요: {candidates}', { candidates: candidates.map((t) => t.account).join(', ') }) : msg('{platform} 대상이 없습니다', { platform }));
  const show = Boolean(args.flags.show);
  await hideComment(ctx, deps.providers, candidates[0]!.id, commentId, !show).catch((err: Error) => {
    throw err instanceof ProviderError ? err : new UsageError(err.message);
  });
  say(show ? msg('댓글을 다시 보이게 했습니다: {commentId}', { commentId }) : msg('댓글을 숨겼습니다: {commentId} (--show 로 되돌림)', { commentId }));
  return 0;
}

async function cmdVisibility(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const [, id, platform, visibility] = args.positionals;
  const post = id ? ctx.store.findPost(id) : undefined;
  if (!post || !platform || !visibility) throw new UsageError(msg('fanout visibility <postId> <platform> public|unlisted|private [--at 시각] [--account main]'));
  const account = str(args, 'account');
  const candidates = ctx.store.targetsForPost(post.id).filter((t) => t.platform === platform && (!account || t.account === account));
  if (candidates.length !== 1) throw new UsageError(candidates.length ? msg('계정이 여러 개입니다. --account 로 고르세요: {candidates}', { candidates: candidates.map((t) => t.account).join(', ') }) : msg('{platform} 대상이 없습니다', { platform }));
  // A bare or empty --at must not fall through to "public now".
  if (args.flags.at !== undefined && !str(args, 'at')?.trim()) throw new UsageError(msg('--at 은 ISO-8601 시각 (예: 2026-10-20T09:00:00+09:00)'));
  const at = str(args, 'at')?.trim();
  const done = await changeVisibility(ctx, deps.providers, candidates[0]!.id, visibility, at).catch((err: Error) => {
    throw err instanceof ProviderError ? err : new UsageError(err.message);
  });
  say(at ? msg('{platform}/{account}: {at}에 공개로 바뀌도록 예약했습니다', { platform: done.platform, account: done.account, at }) : msg('{platform}/{account}: 공개 범위를 {visibility}로 바꿨습니다', { platform: done.platform, account: done.account, visibility }));
  return 0;
}

async function cmdRemove(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const [, id, platform] = args.positionals;
  const post = id ? ctx.store.findPost(id) : undefined;
  if (!post || !platform) throw new UsageError('fanout remove <postId> <platform> [--account main] [--yes]');
  const account = str(args, 'account');
  const candidates = ctx.store.targetsForPost(post.id).filter((t) => t.platform === platform && (!account || t.account === account));
  if (candidates.length !== 1) throw new UsageError(candidates.length ? msg('계정이 여러 개입니다. --account 로 고르세요: {candidates}', { candidates: candidates.map((t) => t.account).join(', ') }) : msg('{platform} 대상이 없습니다', { platform }));
  const t = candidates[0]!;
  console.log(`"${post.title}" → ${t.platform}/${t.account} ${t.remoteUrl ?? t.remoteId ?? ''}`);
  if (!args.flags.yes && !(await confirm(msg('플랫폼에서 이 게시물을 삭제할까요? 되돌릴 수 없습니다')))) return 1;
  const done = await removeTarget(ctx, deps.providers, t.id).catch((err: Error) => {
    throw err instanceof ProviderError ? err : new UsageError(err.message);
  });
  say(msg('삭제했습니다: {platform}/{account}', { platform: done.platform, account: done.account }));
  return 0;
}

async function cmdNotify(ctx: ProviderContext, args: Args): Promise<number> {
  const sub = args.positionals[1];
  if (sub === 'set') {
    const url = args.positionals[2];
    if (!url || !validWebhookUrl(url)) throw new UsageError(msg('fanout notify set <올바른 https://… webhook URL>'));
    const events = str(args, 'events')?.split(',').map((e) => e.trim()) as NotifyEvent[] | undefined;
    const known: readonly string[] = KNOWN_EVENTS;
    if (events?.some((e) => !known.includes(e))) throw new UsageError(msg('--events 는 {known} 중에서', { known: known.join(', ') }));
    const format = str(args, 'format') as NotifyConfig['format'];
    if (format && !['slack', 'discord', 'json'].includes(format)) throw new UsageError(msg('--format 은 slack, discord, json'));
    const picked = events ? eventsToSave(events) : undefined;
    ctx.store.setApp('notify', { url, ...(picked ? { events: picked } : {}), ...(format ? { format } : {}) });
    say(msg('알림을 켰습니다 ({format} 형식, {events}). fanout notify test 로 확인하세요', { format: format ?? detectFormat(url), events: (events ?? DEFAULT_EVENTS).join(', ') }));
    return 0;
  }
  if (sub === 'off') {
    ctx.store.setApp('notify', {});
    say(msg('알림을 껐습니다'));
    return 0;
  }
  const config = notifyConfig(ctx);
  if (sub === 'test') {
    if (!config) throw new UsageError(msg('알림이 꺼져 있습니다 — fanout notify set <URL>'));
    const format = config.format ?? detectFormat(config.url);
    const text = msg('🔔 fanout 알림 테스트입니다');
    await send(ctx, config, format === 'slack' ? { text } : format === 'discord' ? { content: text } : { event: 'test', text });
    say(msg('보냈습니다'));
    return 0;
  }
  if (!config) say(msg('알림 꺼짐'));
  else say(msg('알림 켜짐: {host} ({format}, {events}){source}', { host: new URL(config.url).host, format: config.format ?? detectFormat(config.url), events: (config.events ?? DEFAULT_EVENTS).join(', '), source: process.env.FANOUT_WEBHOOK_URL ? ' — FANOUT_WEBHOOK_URL' : '' }));
  return 0;
}

function cmdBackup(ctx: ProviderContext, args: Args): number {
  const dirArg = args.positionals[1];
  if (!dirArg) throw new UsageError(msg('fanout backup <폴더> [--without-key]'));
  const stamp = ctx.now().toISOString().replace(/[:.]/g, '-');
  const dir = resolve(dirArg, `fanout-${stamp}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  ctx.store.backupTo(join(dir, 'fanout.db'));
  chmodSync(join(dir, 'fanout.db'), 0o600);
  const keyPath = join(ctx.home, 'secret.key');
  if (!args.flags['without-key'] && !process.env.FANOUT_SECRET_KEY && existsSync(keyPath)) {
    writeFileSync(join(dir, 'secret.key'), readFileSync(keyPath), { mode: 0o600 });
  }
  say(msg('백업했습니다: {dir}', { dir }));
  if (process.env.FANOUT_SECRET_KEY) say(msg('복호화 키는 FANOUT_SECRET_KEY 환경 변수에 있어 백업에 넣지 않았습니다. 따로 보관하세요.'));
  else if (args.flags['without-key']) say(msg('⚠ 키 없이 백업했습니다. secret.key 가 없으면 저장된 토큰을 풀 수 없어 계정을 다시 연결해야 합니다.'));
  else say(msg('⚠ secret.key 가 함께 들어 있습니다. 이 폴더가 있으면 모든 계정 토큰을 풀 수 있으니 안전한 곳에 두세요.'));
  return 0;
}

async function cmdRestore(args: Args): Promise<number> {
  const dirArg = args.positionals[1];
  if (!dirArg) throw new UsageError(msg('fanout restore <백업 폴더> [--yes] [--force]'));
  const home = fanoutHome();
  say(msg('{backup} 의 백업으로 {home} 의 데이터를 바꿉니다. 지금 데이터는 지우지 않고 따로 옮겨 둡니다.', { backup: resolve(dirArg), home }));
  if (!args.flags.yes && !(await confirm(msg('복원할까요?')))) return 1;
  try {
    const r = restoreBackup({ home, backupDir: resolve(dirArg), now: new Date(), envKey: process.env.FANOUT_SECRET_KEY || undefined, force: Boolean(args.flags.force) });
    say(r.keyRestored ? msg('복원했습니다: 게시물 {posts}개, 계정 {accounts}개, secret.key 포함', { posts: r.posts, accounts: r.accounts }) : msg('복원했습니다: 게시물 {posts}개, 계정 {accounts}개', { posts: r.posts, accounts: r.accounts }));
    if (r.savedTo) say(msg('이전 데이터: {savedTo}', { savedTo: r.savedTo }));
    return 0;
  } catch (err) {
    if (err instanceof RestoreError) throw new UsageError(err.message);
    throw err;
  }
}

function cmdExport(ctx: ProviderContext, args: Args): number {
  const format = str(args, 'format') ?? 'csv';
  if (format !== 'csv' && format !== 'json') throw new UsageError(msg('--format 은 csv 또는 json'));
  const rows = exportRows(ctx.store);
  const text = format === 'csv' ? toCsv(rows) : `${JSON.stringify(rows, null, 2)}\n`;
  const out = str(args, 'out');
  if (out) {
    writeFileSync(resolve(out), text);
    sayErr(msg('{count}줄을 {path}에 썼습니다', { count: rows.length, path: resolve(out) }));
  } else {
    process.stdout.write(text);
  }
  return 0;
}

async function cmdLimits(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const platform = args.positionals[1];
  if (platform && !deps.providers.has(platform)) throw new UsageError(msg('알 수 없는 플랫폼: {platform} (가능: {providers})', { platform, providers: [...deps.providers.keys()].join(', ') }));
  const all = await readLimits(ctx, deps.providers, platform);
  if (!all.length) say(msg('한도를 알려 주는 플랫폼에 연결된 계정이 없습니다 (YouTube·Instagram·Bluesky·PeerTube)'));
  for (const a of all) {
    console.log(`\n${a.platform}/${a.account}`);
    if (a.error) console.log(`  ✗ ${local(a.error)}`);
    for (const l of a.limits) {
      const resets = l.resetsAt ? '  ' + local(msg('{time}에 초기화', { time: new Date(l.resetsAt).toLocaleString(LOCALE()) })) : '';
      const note = l.note ? `  (${local(l.note)})` : '';
      console.log(`  ${local(l.what)}: ${limitText(l)}${resets}${note}`);
    }
  }
  return 0;
}

/** "3/100, 97 left", in FANOUT_LANG. */
function limitText(l: Limit): string {
  const n = (v: number) => (l.unit === 'bytes' ? formatBytes(v) : v.toLocaleString(LOCALE()));
  if (l.unlimited) return local(l.used === undefined ? msg('무제한') : msg('{used} 씀, 무제한', { used: n(l.used) }));
  const parts: string[] = [];
  if (l.used !== undefined && l.total !== undefined) parts.push(`${n(l.used)}/${n(l.total)}`);
  if (l.remaining !== undefined) parts.push(local(msg('남은 {remaining}', { remaining: n(l.remaining) })));
  return parts.join(', ') || '?';
}

async function cmdStats(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const id = args.positionals[1];
  const posts = id ? [ctx.store.findPost(id)].filter((p): p is Post => Boolean(p)) : ctx.store.listPosts(5);
  if (!posts.length) {
    say(id ? msg('post {id} 없음', { id }) : msg('게시물 없음'));
    return 1;
  }
  const fmt = (n?: number) => (n === undefined ? '-' : n.toLocaleString(LOCALE()));
  const delta = (n?: number) => (n === undefined ? '' : ` (${n >= 0 ? '+' : ''}${n.toLocaleString(LOCALE())})`);
  for (const p of posts) {
    console.log(`\n${p.id.slice(0, 8)}  "${p.title}"`);
    for (const r of await refreshStats(ctx, deps.providers, p.id, { includePaid: Boolean(args.flags['include-paid']) })) {
      const name = `${r.platform}/${r.account}`.padEnd(18);
      const history = () => {
        if (!args.flags.history) return;
        for (const h of ctx.store.statsHistory(r.targetId)) {
          console.log(`  ${''.padEnd(18)} ${h.at.slice(0, 16).replace('T', ' ')}  ${counts(fmt(h.views), fmt(h.likes), fmt(h.comments), fmt(h.shares))}`);
        }
      };
      if (r.skipped) {
        console.log(`  ${name} ${local(r.skipped)}`);
        history();
        continue;
      }
      const t = r.trend;
      console.log(
        `  ${name} ${counts(fmt(r.stats?.views) + delta(t?.views), fmt(r.stats?.likes) + delta(t?.likes), fmt(r.stats?.comments) + delta(t?.comments), fmt(r.stats?.shares) + delta(t?.shares))}${deeper(r.stats, fmt)}${r.stats?.note ? `  (${local(r.stats.note)})` : ''}`,
      );
      if (t) console.log(''.padEnd(21) + local(msg('괄호는 {since} 이후 변화', { since: t.since.slice(0, 16).replace('T', ' ') })));
      history();
    }
  }
  return 0;
}

function cmdPrune(ctx: ProviderContext, args: Args): number {
  const days = num(args, 'days') ?? 7;
  const items = planPrune(ctx.home, ctx.store, { days, now: ctx.now() });
  const label = { orphan_upload: msg('게시 안 된 업로드'), posted_original: msg('게시 끝난 원본'), old_variant: msg('오래된 변환 파일') } as const;
  for (const i of items) console.log(`  ${local(label[i.reason]).padEnd(12)} ${formatBytes(i.bytes).padStart(8)}  ${i.path}`);
  const total = items.reduce((n, i) => n + i.bytes, 0);
  if (!items.length) say(msg('정리할 파일이 없습니다'));
  else if (args.flags['dry-run']) say(msg('{count}개, {size} 정리 가능 (--dry-run이라 지우지 않음)', { count: items.length, size: formatBytes(total) }));
  else say(msg('{count}개, {size} 정리했습니다', { count: items.length, size: formatBytes(applyPrune(items)) }));
  return 0;
}

/** What performs, from the recorded stats: per platform and account, and the best time to post once there's enough. */
function cmdInsights(ctx: ProviderContext, args: Args): number {
  const days = num(args, 'days') ?? 30;
  if (!(days > 0 && days <= 365)) throw new UsageError(msg('--days 는 1~365'));
  const tz = str(args, 'tz');
  if (tz && !validTimeZone(tz)) throw new UsageError(msg('알 수 없는 시간대입니다: {tz} (예: Asia/Seoul)', { tz }));
  const r = computeInsights(ctx.store, ctx.now(), { days, platform: args.positionals[1], locale: LOCALE(), timeZone: tz });
  if (!r.groups.length) {
    say(msg('최근 {days}일 동안 게시된 영상이 없습니다', { days }));
    return 0;
  }
  const fmt = (n?: number) => (n === undefined ? '-' : n.toLocaleString(LOCALE()));
  say(msg('최근 {days}일 ({timeZone} 기준)', { days, timeZone: r.timeZone }));
  for (const g of r.groups) {
    console.log(`\n${g.platform}/${g.account}`);
    say(msg('  게시물 {posts}개 · 조회 합계 {total} · 중앙값 {median}{likes}', { posts: g.posts, total: fmt(g.totalViews), median: fmt(g.medianViews), likes: g.likesPer100Views === undefined ? '' : local(msg(' · 조회 100회당 좋아요 {n}', { n: g.likesPer100Views })) }));
    for (const t of g.top) console.log(`    ${fmt(t.views).padStart(9)}  ${printable(t.title).slice(0, 60)}${t.url ? `  ${t.url}` : ''}`);
    if (g.bestWeekday) say(msg('  잘 되는 요일: {label} (하루 뒤 조회 중앙값 {views} · 게시물 수 {posts})', { label: g.bestWeekday.label, views: fmt(g.bestWeekday.medianViews), posts: g.bestWeekday.posts }));
    if (g.bestHours) say(msg('  잘 되는 시간: {label} (하루 뒤 조회 중앙값 {views} · 게시물 수 {posts})', { label: g.bestHours.label, views: fmt(g.bestHours.medianViews), posts: g.bestHours.posts }));
    if (g.note) say('  ' + local(g.note));
  }
  return 0;
}

/** MCP server on stdio; it also runs the upload worker, so posts it creates actually go out. */
/** --allow a,b or FANOUT_MCP_ROOTS (path-list separated): the folders MCP agents may read from. */
export function mcpRoots(allow: string | true | undefined, env = process.env.FANOUT_MCP_ROOTS): string[] | undefined {
  // "--allow" with nothing after it (or an empty variable) must not quietly mean "anywhere".
  if (allow === true) throw new UsageError(msg('--allow에 폴더를 하나 이상 적으세요'));
  const list = (allow !== undefined ? allow.split(',') : (env ?? '').split(delimiter)).map((d) => d.trim()).filter(Boolean);
  if (allow !== undefined && !list.length) throw new UsageError(msg('--allow에 폴더를 하나 이상 적으세요'));
  if (!list.length) return undefined;
  return list.map((d) => {
    // The shell expands only the first ~ in "a,~/b".
    const path = resolve(d.startsWith('~/') || d === '~' ? join(homedir(), d.slice(1)) : d);
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new UsageError(msg('허용할 폴더가 없습니다: {path}', { path }));
    return realpathSync(path);
  });
}

async function cmdMcp(providers: Map<string, Provider>, args: Args): Promise<number> {
  // Agents are mostly prompted in English, so the MCP server (results and its worker's logs) speaks
  // English unless FANOUT_LANG asks otherwise; FANOUT_LANG=ko keeps Korean.
  process.env.FANOUT_LANG ||= 'en';
  const roots = mcpRoots(args.flags.allow === true ? true : str(args, 'allow'));
  const ctx = openContext(undefined, stderrLogger);
  if (roots) ctx.log.info(msg('MCP: 이 폴더의 파일만 읽습니다: {roots}', { roots: roots.join(', ') }));
  const worker = new Worker({ ctx, providers });
  worker.start();
  try {
    await serveStdio(new McpServer({ ctx, providers, worker, roots }));
  } finally {
    // Unfinished uploads resume in the next fanout process (its lease takeover sees this pid is gone).
    worker.stop();
    ctx.store.close();
  }
  return 0;
}

async function cmdRetry(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const post = args.positionals[1] ? ctx.store.findPost(args.positionals[1]) : undefined;
  if (!post) throw new UsageError('fanout retry <postId> [platform]');
  const only = args.positionals[2];
  const ids: string[] = [];
  for (const t of ctx.store.targetsForPost(post.id)) {
    if ((t.state === 'failed' || t.state === 'needs_reauth') && (!only || t.platform === only)) {
      retryTarget(ctx.store, t.id, 'manual retry');
      ids.push(t.id);
    }
  }
  if (!ids.length) {
    say(msg('다시 시도할 대상 없음'));
    return 0;
  }
  await settle(deps, ids, settleOpts(ctx));
  printPost(ctx, post);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const [cmd] = args.positionals;
  const providers = providerMap();
  if (!cmd || cmd === 'help' || args.flags.help) {
    say(HELP);
    return 0;
  }
  const needProvider = (i = 1): Provider => {
    const id = args.positionals[i];
    const p = id === 'meta' ? providers.get('instagram') : id ? providers.get(id) : undefined;
    if (!p) throw new UsageError(msg('플랫폼을 지정하세요: {platforms}', { platforms: BUILTIN_PROVIDERS.map((x) => x.id).join(', ') }));
    return p;
  };

  if (cmd === 'platforms') return cmdPlatforms(providers).then(() => 0);
  if (cmd === 'setup') {
    say(needProvider().setupGuide());
    return 0;
  }
  if (cmd === 'check') return cmdCheck(providers, args).then(() => 0);

  if (cmd === 'mcp') return cmdMcp(providers, args);
  // Before anything opens the database (or creates a key) in the data folder.
  if (cmd === 'restore') return cmdRestore(args);

  const ctx = openContext();
  const deps: RunnerDeps = { ctx, providers };
  try {
    switch (cmd) {
      case 'app':
        if (args.positionals[1] !== 'set') throw new UsageError('fanout app set <platform>');
        await cmdAppSet(ctx, needProvider(2), args);
        return 0;
      case 'connect': {
        const p = needProvider();
        const name = namedOrOnly(ctx, p.id, str(args, 'name'), '--name');
        if (!ACCOUNT_NAME.test(name)) throw new UsageError(msg('계정 이름은 영문·숫자·-·_ 32자 이내'));
        // Reconnecting the only account under its own name; a second account needs --name.
        if (!str(args, 'name') && name !== 'main') say(msg('{id}/{name} 계정을 다시 연결합니다 (새 계정을 더하려면 --name)', { id: p.id, name }));
        const account = await p.connect(ctx, name, args.flags);
        ctx.store.saveAccount(account);
        say(msg('연결됨: {id}/{name} {profile}', { id: p.id, name, profile: JSON.stringify(account.profile) }));
        return 0;
      }
      case 'accounts':
        for (const a of ctx.store.listAccounts()) {
          const expiry = signInExpiry(ctx, deps.providers, a.platform, a.name);
          const when = expiry ? new Date(expiry.expiresAt).toISOString().slice(0, 10) : '';
          const note = expiry?.soon ? '  ⚠ ' + local(msg('로그인 만료 {when} — 다시 연결하세요', { when })) : '';
          console.log(`${`${a.platform}/${a.name}`.padEnd(20)} ${JSON.stringify(a.profile)}${note}`);
        }
        return 0;
      case 'disconnect': {
        const [, platform, name] = args.positionals;
        if (!platform || !name) throw new UsageError('fanout disconnect <platform> <name>');
        const done = await disconnectAccount(ctx, deps.providers, platform, name);
        if (!done) say(msg('해당 계정 없음'));
        else if (done.forgot) say(done.revoked ? msg('삭제됨 (토큰을 철회하고 플랫폼에서 받은 반응 통계도 지웠습니다)') : msg('삭제됨 (플랫폼에서 받은 반응 통계를 지웠습니다. 토큰은 철회하지 않았습니다)'));
        else say(msg('삭제됨'));
        return 0;
      }
      case 'doctor':
        return args.positionals[1] ? await cmdDoctor(ctx, needProvider(), args) : await cmdDoctorAll(ctx, providers, args);
      case 'post':
        return await cmdPost(ctx, deps, args);
      case 'status': {
        const id = args.positionals[1];
        const posts = id ? [ctx.store.findPost(id)].filter((p): p is Post => Boolean(p)) : ctx.store.listPosts(10);
        if (!posts.length) say(id ? msg('post {id} 없음', { id }) : msg('게시물 없음'));
        for (const p of posts) printPost(ctx, p, Boolean(args.flags.events));
        const pending = posts.flatMap((p) => ctx.store.targetsForPost(p.id)).filter((t) => !isTerminal(t.state));
        if (pending.length) say(msg('\n진행 중 {count}건 — fanout run 으로 이어서 처리', { count: pending.length }));
        return 0;
      }
      case 'prune':
        return cmdPrune(ctx, args);
      case 'backup':
        return cmdBackup(ctx, args);
      case 'export':
        return cmdExport(ctx, args);
      case 'stats':
        return await cmdStats(ctx, deps, args);
      case 'limits':
        return await cmdLimits(ctx, deps, args);
      case 'insights':
        return cmdInsights(ctx, args);
      case 'hide-comment':
        return await cmdHideComment(ctx, deps, args);
      case 'visibility':
        return await cmdVisibility(ctx, deps, args);
      case 'remove':
        return await cmdRemove(ctx, deps, args);
      case 'cancel':
        return await cmdCancel(ctx, args);
      case 'edit':
        return await cmdEdit(ctx, deps, args);
      case 'comments':
        return await cmdComments(ctx, deps, args);
      case 'reply':
        return await cmdReply(ctx, deps, args);
      case 'add':
        return await cmdAdd(ctx, deps, args);
      case 'notify':
        return await cmdNotify(ctx, args);
      case 'retry':
        return await cmdRetry(ctx, deps, args);
      case 'run':
        return await cmdRun(ctx, deps);
      case 'worker':
        return await cmdWorker(ctx, deps, args);
      case 'serve':
        return await cmdServe(ctx, deps, args);
      case 'watch':
        return await cmdWatch(ctx, deps, args);
      default:
        throw new UsageError(msg('알 수 없는 명령: {cmd}', { cmd }) + '\n\n' + local(HELP));
    }
  } finally {
    await flushNotifications();
    ctx.store.close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      if (err instanceof UsageError) console.error(local(err.message));
      else if (err instanceof ProviderError) console.error(`✗ ${err.code}${err.platformCode ? ` (${err.platformCode})` : ''}: ${local(err.message)}`);
      else if (err instanceof Error && currentLang() === 'en') console.error(local(err.message));
      else console.error(err);
      process.exit(2);
    },
  );
}
