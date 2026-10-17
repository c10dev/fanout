#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { openContext, stderrLogger } from './core/context.ts';
import { DEFAULT_EVENTS, detectFormat, flushNotifications, notifyConfig, send, type NotifyConfig } from './core/notify.ts';
import { ProviderError } from './core/errors.ts';
import { CONFIG_FILE, defaultAccountName, exampleConfig, ingest, loadWatchConfig, Scanner, WatchConfigError, type WatchConfig } from './core/inbox.ts';
import { fileHash, probe } from './core/media.ts';
import { accountLabel, assessMedia, createScheduledPost, describePrior, editPost, priorPosts, refreshStats, removeTarget, retryTarget, visibilityLabel } from './core/posting.ts';
import { applyPrune, formatBytes, planPrune } from './core/prune.ts';
import type { DoctorCheck, Provider, ProviderContext } from './core/provider.ts';
import { settle, type RunnerDeps } from './core/runner.ts';
import { isTerminal } from './core/state.ts';
import type { CaptionFile, Post, PostInput, Target, TargetInput, TargetState } from './core/types.ts';
import { BUILTIN_PROVIDERS, providerMap } from './providers/index.ts';
import { Dashboard } from './server/server.ts';
import { McpServer, serveStdio } from './mcp/server.ts';
import { Worker } from './core/worker.ts';
import { isShort } from './providers/youtube.ts';

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
  throw new UsageError(`--${key} 값은 yes 또는 no`);
}

function num(args: Args, key: string): number | undefined {
  const v = str(args, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${key} 값은 숫자`);
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
      return drop({
        privacy: str(args, 'yt-privacy'),
        madeForKids: bool(args, 'yt-made-for-kids'),
        categoryId: str(args, 'yt-category'),
        playlistId: str(args, 'yt-playlist'),
        notifySubscribers: args.flags['yt-no-notify'] ? false : undefined,
        defaultLanguage: str(args, 'yt-lang'),
      });
    case 'tiktok': {
      const privacy = str(args, 'tt-privacy');
      if (privacy && !TT_PRIVACY[privacy]) throw new UsageError(`--tt-privacy는 ${Object.keys(TT_PRIVACY).join('|')}`);
      return drop({
        mode: str(args, 'tt-mode') ?? 'inbox',
        caption: str(args, 'tt-caption'),
        privacyLevel: privacy ? TT_PRIVACY[privacy] : undefined,
        allowComment: bool(args, 'tt-allow-comment'),
        allowDuet: bool(args, 'tt-allow-duet'),
        allowStitch: bool(args, 'tt-allow-stitch'),
        brandOrganic: bool(args, 'tt-brand-organic'),
        brandedContent: bool(args, 'tt-branded'),
        musicConsent: bool(args, 'tt-music-consent'),
        coverTimestampMs: num(args, 'tt-cover-ms'),
      });
    }
    case 'instagram':
      return drop({
        caption: str(args, 'ig-caption'),
        shareToFeed: args.flags['ig-no-feed'] ? false : undefined,
        thumbOffsetMs: num(args, 'ig-thumb-ms'),
      });
    case 'facebook':
      return drop({ caption: str(args, 'fb-caption') });
    case 'x':
      return drop({ text: str(args, 'x-text') });
    case 'mastodon':
      return drop({ visibility: str(args, 'md-visibility'), text: str(args, 'md-text'), alt: str(args, 'md-alt'), language: str(args, 'md-lang'), spoilerText: str(args, 'md-cw') });
    case 'bluesky':
      return drop({ text: str(args, 'bsky-text'), alt: str(args, 'bsky-alt'), langs: str(args, 'bsky-lang')?.split(',').map((l) => l.trim()) });
    default:
      return {};
  }
}

function parseTargets(spec: string, providers: Map<string, Provider>, args: Args, accounts: ReadonlyArray<{ platform: string; name: string }>): TargetInput[] {
  return spec.split(',').map((s) => {
    const [platform, explicit] = s.trim().split(':');
    if (!platform || !providers.has(platform)) throw new UsageError(`알 수 없는 플랫폼: ${platform} (가능: ${[...providers.keys()].join(', ')})`);
    // Without ":name", use "main" or the platform's only connected account.
    return { platform, account: explicit || defaultAccountName(accounts, platform), options: targetOptions(platform, args) };
  });
}

function parseCaptions(list: string[] | undefined): CaptionFile[] {
  return (list ?? []).map((c) => {
    const i = c.indexOf(':');
    if (i <= 0) throw new UsageError(`--caption 형식은 언어:파일 (예: ko:subs.srt)`);
    const path = resolve(c.slice(i + 1));
    if (!existsSync(path)) throw new UsageError(`자막 파일 없음: ${path}`);
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
};

function targetLine(t: Target): string {
  const head = `  ${STATE_ICON[t.state] ?? '?'} ${`${t.platform}/${t.account}`.padEnd(18)} ${t.state.padEnd(12)}`;
  const lines = [`${head} ${t.remoteUrl ?? (t.notBefore && t.state === 'queued' ? `예정 ${t.notBefore}` : '')}`.trimEnd()];
  if (t.errorCode) lines.push(`      ${t.errorCode}: ${t.errorMessage ?? ''}`);
  for (const w of t.warnings) lines.push(`      ⚠ ${w}`);
  return lines.join('\n');
}

function printPost(ctx: ProviderContext, post: Post, withEvents = false): void {
  console.log(`\n${post.id.slice(0, 8)}  "${post.title}"  ${post.createdAt}`);
  for (const t of ctx.store.targetsForPost(post.id)) {
    console.log(targetLine(t));
    if (withEvents) {
      for (const e of ctx.store.events(t.id)) console.log(`        ${e.at}  ${e.from ?? '·'} → ${e.to}${e.detail ? `  (${e.detail})` : ''}`);
    }
  }
}

function accountLine(ctx: ProviderContext, t: TargetInput): string {
  const acct = ctx.store.getAccount(t.platform, t.account);
  if (!acct) return `${t.platform}/${t.account} (연결 안 됨)`;
  return `${t.platform}/${t.account} → ${accountLabel(acct.profile, t.account)}`;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
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

const HELP = `fanout — 영상 하나를 여러 플랫폼에 올리는 셀프호스팅 업로더

  fanout platforms                       지원 플랫폼과 기능
  fanout setup <platform>                내 개발자 앱(BYO) 만드는 방법
  fanout app set <platform> [--key 값]   BYO 앱 자격증명 저장 (instagram·facebook은 meta)
  fanout connect <platform> [--name main] [--token T] [--page ID] [--handle H] [--instance URL]
  fanout accounts                        연결된 계정
  fanout disconnect <platform> <name>
  fanout doctor <platform> [--account main] [--live]
  fanout check <video> [--to youtube,tiktok]
  fanout post <video> --title T --to youtube,tiktok:main,instagram,facebook [옵션]
  fanout status [postId] [--events]
  fanout retry <postId> [platform]
  fanout run                             밀린 작업 처리 후 종료
  fanout worker [--interval 60]          예약·재시도 작업을 계속 처리
  fanout serve [--port 8780] [--host 127.0.0.1] [--keep-days 7 | --no-prune]
                                         웹 대시보드 (작업 처리, 6시간마다 자동 정리 포함)
  fanout edit <postId> [--title T] [--description D | --description-file F] [--tags a,b]
                                         제목·설명·태그 수정 (YouTube·Facebook·Mastodon에 반영)
  fanout remove <postId> <platform> [--account main] [--yes]   게시물을 플랫폼에서 삭제 (되돌릴 수 없음)
  fanout stats [postId] [--include-paid]  게시된 영상의 조회·좋아요·댓글 (X는 --include-paid일 때만)
  fanout notify set <webhook URL> [--events failed,needs_reauth,published,handed_off] [--format slack|discord|json]
  fanout notify test | off               상태 알림 (Slack·Discord·JSON webhook)
  fanout prune [--days 7] [--dry-run]    다 올린 원본·오래된 변환 파일 정리 (~/.fanout 안만)
  fanout mcp                             MCP 서버 (stdio) — AI 에이전트용 도구, 업로드 처리 포함
  fanout watch <폴더> --init             감시 폴더와 예시 설정(fanout.watch.json) 만들기
  fanout watch <폴더> [--yes] [--once] [--interval 15] [--settle 10]
                                         폴더에 넣은 영상을 설정대로 자동으로 올림
                                         (--once: 지금 있는 영상만 올리고 종료, cron용)

post 공통 옵션
  --description 텍스트 | --description-file 파일   --tags a,b,c
  --thumbnail 이미지   --caption ko:subs.srt (여러 번)   --ai (AI 생성·합성 콘텐츠 표시)
  --at 2026-10-20T09:00:00+09:00 (예약)   --yes (확인 생략)   --no-wait

플랫폼별 옵션
  YouTube    --yt-privacy public|unlisted|private (필수)  --yt-made-for-kids yes|no (필수)
             --yt-category 22  --yt-playlist ID  --yt-no-notify  --yt-lang ko
  TikTok     --tt-mode inbox|direct (기본 inbox)
             direct 전용: --tt-privacy public|friends|followers|private (필수)
             --tt-music-consent yes (필수)  --tt-allow-comment/--tt-allow-duet/--tt-allow-stitch yes
             --tt-brand-organic yes  --tt-branded yes  --tt-caption 텍스트  --tt-cover-ms 1000
  Instagram  --ig-caption 텍스트  --ig-no-feed  --ig-thumb-ms 1000
  Facebook   --fb-caption 텍스트
  X          --x-text 텍스트 (가중치 280 이하, 한글은 2로 셈)
  Bluesky    --bsky-text 텍스트(300자 이하)  --bsky-alt 대체텍스트  --bsky-lang ko,en
  Mastodon   --md-visibility public|unlisted|private (필수)  --md-text 텍스트  --md-alt 대체텍스트
             --md-lang ko  --md-cw 내용경고

데이터 위치: FANOUT_HOME (기본 ~/.fanout). 토큰은 AES-256-GCM으로 암호화해 저장합니다.`;

async function cmdPlatforms(providers: Map<string, Provider>): Promise<void> {
  for (const p of providers.values()) {
    const c = p.capabilities;
    const caps = [c.nativeSchedule && '네이티브 예약', c.thumbnail && '썸네일', c.captions && '자막', c.syntheticMediaFlag && 'AI 표시'].filter(Boolean);
    console.log(`${p.id.padEnd(10)} ${p.displayName.padEnd(24)} ${caps.join(', ') || '-'}${p.appKey ? `  (앱: ${p.appKey})` : ''}`);
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
    if (!inner?.client_id) throw new UsageError('client_id가 있는 Google OAuth JSON이 아닙니다');
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
  console.log(`${key} 앱 저장됨 (${provider.appFields.filter((f) => config[f.key] !== undefined).map((f) => f.key).join(', ')})`);
}

async function cmdDoctor(ctx: ProviderContext, provider: Provider, args: Args): Promise<number> {
  const name = str(args, 'account') ?? 'main';
  const account = ctx.store.getAccount(provider.id, name);
  if (!account) {
    console.log(`${provider.id}/${name} 계정이 연결되지 않았습니다. 먼저: fanout setup ${provider.id}`);
    return 1;
  }
  const checks: DoctorCheck[] = await provider.doctor({ ctx, account, live: Boolean(args.flags.live) });
  const icon = { ok: '✓', warn: '⚠', fail: '✗', info: 'ℹ' } as const;
  for (const c of checks) console.log(`${icon[c.status]} ${c.name}: ${c.detail}`);
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}

async function cmdCheck(providers: Map<string, Provider>, args: Args): Promise<void> {
  const file = args.positionals[1];
  if (!file) throw new UsageError('fanout check <video>');
  const media = await probe(resolve(file));
  const v = media.video;
  console.log(
    `${file}: ${v.width}x${v.height} ${v.codec} ${v.fps.toFixed(2)}fps, ${media.durationSec.toFixed(1)}s, ${(media.sizeBytes / 1024 / 1024).toFixed(1)}MB, ` +
      `${media.audio ? `${media.audio.codec} ${media.audio.sampleRate}Hz` : '오디오 없음'}`,
  );
  const ids = str(args, 'to')?.split(',').map((s) => s.split(':')[0]!) ?? [...providers.keys()];
  const selected = ids.map((id) => providers.get(id)).filter((p): p is Provider => Boolean(p));
  const label = { as_is: '✓ 원본 그대로', transcode: '⚙ 변환 후 업로드', blocked: '✗ 올릴 수 없음' } as const;
  for (const a of assessMedia(media, selected)) {
    console.log(`  ${a.platform.padEnd(10)} ${label[a.verdict]}${a.platform === 'youtube' && isShort(media) ? ' (Shorts로 분류)' : ''}`);
    for (const x of a.violations) console.log(`      ${x.fixable ? '⚙' : '✗'} ${x.message}`);
  }
}

async function cmdPost(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const file = args.positionals[1];
  const title = str(args, 'title');
  const to = str(args, 'to');
  if (!file || !title || !to) throw new UsageError('fanout post <video> --title 제목 --to youtube,tiktok,...');
  const mediaPath = resolve(file);
  if (!existsSync(mediaPath)) throw new UsageError(`파일 없음: ${mediaPath}`);
  const descFile = str(args, 'description-file');
  const thumb = str(args, 'thumbnail');
  const at = str(args, 'at');
  if (at && Number.isNaN(Date.parse(at))) throw new UsageError('--at 은 ISO-8601 시각 (예: 2026-10-20T09:00:00+09:00)');

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

  // YouTube policy: show which channel and which visibility before uploading.
  console.log(`\n"${title}"  ${mediaPath}${input.scheduledAt ? `  예약 ${input.scheduledAt}` : ''}`);
  for (const t of targets) {
    console.log(`  ${accountLine(ctx, t).padEnd(40)} ${visibilityLabel(t, input.scheduledAt)}`);
    const before = prior.get(`${t.platform}/${t.account}`)?.[0];
    if (before) console.log(`      ⚠ ${describePrior(before)}`);
  }
  if (!args.flags.yes && !(await confirm('이대로 업로드할까요?'))) return 1;

  const { post } = createScheduledPost(ctx.store, deps.providers, input, targets);
  console.log(`post ${post.id.slice(0, 8)} 생성`);
  if (args.flags['no-wait']) return 0;

  const due = ctx.store.targetsForPost(post.id).filter((t) => !t.notBefore || new Date(t.notBefore) <= ctx.now());
  await settle(deps, due.map((t) => t.id), settleOpts(ctx));
  printPost(ctx, post);
  const after = ctx.store.targetsForPost(post.id);
  if (after.some((t) => t.notBefore && t.state === 'queued')) console.log('\n예약된 대상이 있습니다. 예약 시각에 올리려면 fanout worker 를 켜 두세요.');
  return after.some((t) => t.state === 'failed' || t.state === 'needs_reauth') ? 1 : 0;
}

async function cmdRun(ctx: ProviderContext, deps: RunnerDeps): Promise<number> {
  const ids = ctx.store.workableTargets().map((t) => t.id);
  if (!ids.length) {
    console.log('처리할 작업 없음');
    return 0;
  }
  const done = await settle(deps, ids, settleOpts(ctx));
  const postIds = [...new Set(done.map((t) => t.postId))];
  for (const id of postIds) printPost(ctx, ctx.store.getPost(id)!);
  return done.some((t) => t.state === 'failed' || t.state === 'needs_reauth') ? 1 : 0;
}

async function cmdWorker(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<never> {
  const interval = (num(args, 'interval') ?? 60) * 1000;
  console.log(`worker 시작 (${interval / 1000}s 간격, Ctrl+C로 종료)`);
  for (;;) {
    const ids = ctx.store.workableTargets().map((t) => t.id);
    if (ids.length) await settle(deps, ids, { ...settleOpts(ctx), timeoutMs: interval });
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function cmdWatch(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const dirArg = args.positionals[1];
  if (!dirArg) throw new UsageError('fanout watch <폴더> [--init] [--once] [--yes] [--interval 15] [--settle 10]');
  const dir = resolve(dirArg);
  if (args.flags.init) {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, CONFIG_FILE);
    if (existsSync(path)) throw new UsageError(`이미 있습니다: ${path}`);
    writeFileSync(path, `${JSON.stringify(exampleConfig(ctx.store.listAccounts()), null, 2)}\n`);
    console.log(`예시 설정을 만들었습니다: ${path}\n올릴 곳(to)과 플랫폼별 옵션을 확인한 뒤 fanout watch ${dirArg} 로 시작하세요.`);
    return 0;
  }
  if (!existsSync(dir)) throw new UsageError(`폴더 없음: ${dir}`);
  let config: WatchConfig;
  try {
    config = loadWatchConfig(dir);
  } catch (err) {
    if (err instanceof WatchConfigError) throw new UsageError(err.message);
    throw err;
  }

  // YouTube policy: show the destination accounts and visibility before anything is uploaded.
  console.log(`\n감시 폴더: ${dir}`);
  for (const spec of config.to ?? []) {
    const [platform = '', account = 'main'] = spec.split(':');
    if (!deps.providers.has(platform)) throw new UsageError(`${CONFIG_FILE}: 알 수 없는 플랫폼 ${platform}`);
    const t: TargetInput = { platform, account, options: config.options?.[platform] ?? {} };
    console.log(`  ${accountLine(ctx, t).padEnd(40)} ${visibilityLabel(t, config.at)}`);
  }
  console.log('  (영상별 <이름>.json 이 있으면 그 값이 우선합니다)');
  const missing = (config.to ?? []).map((s) => s.split(':')).filter(([p = '', a = 'main']) => !ctx.store.getAccount(p, a));
  if (missing.length) {
    throw new UsageError(`연결되지 않은 계정이 있어 시작하지 않습니다: ${missing.map(([p, a = 'main']) => `${p}/${a}`).join(', ')}\n먼저 fanout connect 또는 대시보드 설정 탭에서 연결하세요.`);
  }
  if (!args.flags.yes && !(await confirm('이 폴더에 들어오는 영상을 위 설정대로 올릴까요?'))) return 1;

  const once = Boolean(args.flags.once);
  const interval = (num(args, 'interval') ?? 15) * 1000;
  const scanner = new Scanner(dir, (num(args, 'settle') ?? 10) * 1000);
  const probeFn = deps.probe ?? probe;
  let failures = 0;

  const scan = async (): Promise<void> => {
    for (const videoPath of scanner.ready(!once)) {
      scanner.forget(videoPath);
      const r = await ingest({ dir, config, videoPath, providers: deps.providers, store: ctx.store, probe: probeFn, now: ctx.now() });
      if (!r.ok) {
        failures++;
        console.log(`✗ ${basename(videoPath)}: ${r.error}\n    → ${r.movedTo}`);
        continue;
      }
      console.log(`+ ${basename(videoPath)} → post ${r.postId.slice(0, 8)} "${r.plan.input.title}" (${r.plan.targets.map((t) => t.platform).join(', ')})`);
      for (const s of r.plan.skipped) console.log(`    건너뜀 ${s.platform}: ${s.reason}`);
    }
  };

  if (once) {
    await scan();
    const code = await cmdRun(ctx, deps);
    return failures ? 1 : code;
  }

  console.log(`감시 시작 (${interval / 1000}s 간격, Ctrl+C로 종료). 올린 영상은 posted/, 실패한 영상은 failed/ 로 옮깁니다.`);
  let stop = false;
  process.once('SIGINT', () => {
    stop = true;
    console.log('\n종료 중… 진행 중인 업로드는 다음 실행 때 이어서 처리됩니다');
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
    throw new UsageError('127.0.0.1이 아닌 주소로 열려면 FANOUT_DASHBOARD_TOKEN 환경 변수로 접속 토큰을 정하세요');
  }
  const dashboard = new Dashboard({
    ctx,
    providers: deps.providers,
    host,
    port: num(args, 'port') ?? 8780,
    token,
    allowedHosts: str(args, 'allow-host')?.split(','),
    pruneDays: args.flags['no-prune'] ? null : (num(args, 'keep-days') ?? 7),
    assumeLocal,
  });
  const url = await dashboard.start();
  console.log(`fanout 대시보드: ${url}`);
  if (!loopback) console.log('외부 접속 허용 중입니다. 페이지에서 FANOUT_DASHBOARD_TOKEN 값을 입력해야 합니다. HTTPS 리버스 프록시 뒤에 두세요.');
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  console.log('\n대시보드 종료 중… 진행 중인 업로드는 다음 실행 때 이어서 처리됩니다');
  await dashboard.stop();
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
  if (!Object.keys(patch).length) throw new UsageError('바꿀 것을 하나 이상 주세요 (--title, --description, --tags)');
  const icon = { updated: '✓', skipped: '·', failed: '✗' } as const;
  for (const r of await editPost(ctx, deps.providers, post.id, patch)) {
    console.log(`  ${icon[r.status]} ${`${r.platform}/${r.account}`.padEnd(18)} ${r.status === 'updated' ? '반영함' : (r.detail ?? '')}`);
  }
  return 0;
}

async function cmdRemove(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const [, id, platform] = args.positionals;
  const post = id ? ctx.store.findPost(id) : undefined;
  if (!post || !platform) throw new UsageError('fanout remove <postId> <platform> [--account main] [--yes]');
  const account = str(args, 'account');
  const candidates = ctx.store.targetsForPost(post.id).filter((t) => t.platform === platform && (!account || t.account === account));
  if (candidates.length !== 1) throw new UsageError(candidates.length ? `계정이 여러 개입니다. --account 로 고르세요: ${candidates.map((t) => t.account).join(', ')}` : `${platform} 대상이 없습니다`);
  const t = candidates[0]!;
  console.log(`"${post.title}" → ${t.platform}/${t.account} ${t.remoteUrl ?? t.remoteId ?? ''}`);
  if (!args.flags.yes && !(await confirm('플랫폼에서 이 게시물을 삭제할까요? 되돌릴 수 없습니다'))) return 1;
  const done = await removeTarget(ctx, deps.providers, t.id).catch((err: Error) => {
    throw err instanceof ProviderError ? err : new UsageError(err.message);
  });
  console.log(`삭제했습니다: ${done.platform}/${done.account}`);
  return 0;
}

async function cmdNotify(ctx: ProviderContext, args: Args): Promise<number> {
  const sub = args.positionals[1];
  if (sub === 'set') {
    const url = args.positionals[2];
    if (!url || !/^https:\/\//.test(url)) throw new UsageError('fanout notify set <https://… webhook URL>');
    const events = str(args, 'events')?.split(',').map((e) => e.trim()) as TargetState[] | undefined;
    const known: readonly string[] = ['published', 'handed_off', 'failed', 'needs_reauth', 'removed'];
    if (events?.some((e) => !known.includes(e))) throw new UsageError(`--events 는 ${known.join(', ')} 중에서`);
    const format = str(args, 'format') as NotifyConfig['format'];
    if (format && !['slack', 'discord', 'json'].includes(format)) throw new UsageError('--format 은 slack, discord, json');
    ctx.store.setApp('notify', { url, ...(events ? { events } : {}), ...(format ? { format } : {}) });
    console.log(`알림을 켰습니다 (${format ?? detectFormat(url)} 형식, ${(events ?? DEFAULT_EVENTS).join(', ')}). fanout notify test 로 확인하세요`);
    return 0;
  }
  if (sub === 'off') {
    ctx.store.setApp('notify', {});
    console.log('알림을 껐습니다');
    return 0;
  }
  const config = notifyConfig(ctx);
  if (sub === 'test') {
    if (!config) throw new UsageError('알림이 꺼져 있습니다 — fanout notify set <URL>');
    const format = config.format ?? detectFormat(config.url);
    const text = '🔔 fanout 알림 테스트입니다';
    await send(ctx, config, format === 'slack' ? { text } : format === 'discord' ? { content: text } : { event: 'test', text });
    console.log('보냈습니다');
    return 0;
  }
  if (!config) console.log('알림 꺼짐');
  else console.log(`알림 켜짐: ${new URL(config.url).host} (${config.format ?? detectFormat(config.url)}, ${(config.events ?? DEFAULT_EVENTS).join(', ')})${process.env.FANOUT_WEBHOOK_URL ? ' — FANOUT_WEBHOOK_URL' : ''}`);
  return 0;
}

async function cmdStats(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const id = args.positionals[1];
  const posts = id ? [ctx.store.findPost(id)].filter((p): p is Post => Boolean(p)) : ctx.store.listPosts(5);
  if (!posts.length) {
    console.log(id ? `post ${id} 없음` : '게시물 없음');
    return 1;
  }
  const fmt = (n?: number) => (n === undefined ? '-' : n.toLocaleString('ko-KR'));
  for (const p of posts) {
    console.log(`\n${p.id.slice(0, 8)}  "${p.title}"`);
    for (const r of await refreshStats(ctx, deps.providers, p.id, { includePaid: Boolean(args.flags['include-paid']) })) {
      const name = `${r.platform}/${r.account}`.padEnd(18);
      if (r.skipped) console.log(`  ${name} ${r.skipped}`);
      else console.log(`  ${name} 조회 ${fmt(r.stats?.views)} · 좋아요 ${fmt(r.stats?.likes)} · 댓글 ${fmt(r.stats?.comments)} · 공유 ${fmt(r.stats?.shares)}${r.stats?.note ? `  (${r.stats.note})` : ''}`);
    }
  }
  return 0;
}

function cmdPrune(ctx: ProviderContext, args: Args): number {
  const days = num(args, 'days') ?? 7;
  const items = planPrune(ctx.home, ctx.store, { days, now: ctx.now() });
  const label = { orphan_upload: '게시 안 된 업로드', posted_original: '게시 끝난 원본', old_variant: '오래된 변환 파일' } as const;
  for (const i of items) console.log(`  ${label[i.reason].padEnd(12)} ${formatBytes(i.bytes).padStart(8)}  ${i.path}`);
  const total = items.reduce((n, i) => n + i.bytes, 0);
  if (!items.length) console.log('정리할 파일이 없습니다');
  else if (args.flags['dry-run']) console.log(`${items.length}개, ${formatBytes(total)} 정리 가능 (--dry-run이라 지우지 않음)`);
  else console.log(`${items.length}개, ${formatBytes(applyPrune(items))} 정리했습니다`);
  return 0;
}

/** MCP server on stdio; it also runs the upload worker, so posts it creates actually go out. */
async function cmdMcp(providers: Map<string, Provider>): Promise<number> {
  const ctx = openContext(undefined, stderrLogger);
  const worker = new Worker({ ctx, providers });
  worker.start();
  try {
    await serveStdio(new McpServer({ ctx, providers, worker }));
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
    console.log('다시 시도할 대상 없음');
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
    console.log(HELP);
    return 0;
  }
  const needProvider = (i = 1): Provider => {
    const id = args.positionals[i];
    const p = id === 'meta' ? providers.get('instagram') : id ? providers.get(id) : undefined;
    if (!p) throw new UsageError(`플랫폼을 지정하세요: ${BUILTIN_PROVIDERS.map((x) => x.id).join(', ')}`);
    return p;
  };

  if (cmd === 'platforms') return cmdPlatforms(providers).then(() => 0);
  if (cmd === 'setup') {
    console.log(needProvider().setupGuide());
    return 0;
  }
  if (cmd === 'check') return cmdCheck(providers, args).then(() => 0);

  if (cmd === 'mcp') return cmdMcp(providers);

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
        const name = str(args, 'name') ?? 'main';
        const account = await p.connect(ctx, name, args.flags);
        ctx.store.saveAccount(account);
        console.log(`연결됨: ${p.id}/${name} ${JSON.stringify(account.profile)}`);
        return 0;
      }
      case 'accounts':
        for (const a of ctx.store.listAccounts()) console.log(`${`${a.platform}/${a.name}`.padEnd(20)} ${JSON.stringify(a.profile)}`);
        return 0;
      case 'disconnect': {
        const [, platform, name] = args.positionals;
        if (!platform || !name) throw new UsageError('fanout disconnect <platform> <name>');
        console.log(ctx.store.removeAccount(platform, name) ? '삭제됨' : '해당 계정 없음');
        return 0;
      }
      case 'doctor':
        return await cmdDoctor(ctx, needProvider(), args);
      case 'post':
        return await cmdPost(ctx, deps, args);
      case 'status': {
        const id = args.positionals[1];
        const posts = id ? [ctx.store.findPost(id)].filter((p): p is Post => Boolean(p)) : ctx.store.listPosts(10);
        if (!posts.length) console.log(id ? `post ${id} 없음` : '게시물 없음');
        for (const p of posts) printPost(ctx, p, Boolean(args.flags.events));
        const pending = posts.flatMap((p) => ctx.store.targetsForPost(p.id)).filter((t) => !isTerminal(t.state));
        if (pending.length) console.log(`\n진행 중 ${pending.length}건 — fanout run 으로 이어서 처리`);
        return 0;
      }
      case 'prune':
        return cmdPrune(ctx, args);
      case 'stats':
        return await cmdStats(ctx, deps, args);
      case 'remove':
        return await cmdRemove(ctx, deps, args);
      case 'edit':
        return await cmdEdit(ctx, deps, args);
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
        throw new UsageError(`알 수 없는 명령: ${cmd}\n\n${HELP}`);
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
      if (err instanceof UsageError) console.error(err.message);
      else if (err instanceof ProviderError) console.error(`✗ ${err.code}${err.platformCode ? ` (${err.platformCode})` : ''}: ${err.message}`);
      else console.error(err);
      process.exit(2);
    },
  );
}
