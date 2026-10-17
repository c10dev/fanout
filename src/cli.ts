#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { openContext } from './core/context.ts';
import { ProviderError } from './core/errors.ts';
import { CONFIG_FILE, defaultAccountName, exampleConfig, ingest, loadWatchConfig, Scanner, WatchConfigError, type WatchConfig } from './core/inbox.ts';
import { probe } from './core/media.ts';
import { assessMedia, createScheduledPost } from './core/posting.ts';
import { applyPrune, formatBytes, planPrune } from './core/prune.ts';
import type { DoctorCheck, Provider, ProviderContext } from './core/provider.ts';
import { settle, type RunnerDeps } from './core/runner.ts';
import { isTerminal } from './core/state.ts';
import type { CaptionFile, Post, PostInput, Target, TargetInput } from './core/types.ts';
import { BUILTIN_PROVIDERS, providerMap } from './providers/index.ts';
import { Dashboard } from './server/server.ts';
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

function accountLabel(ctx: ProviderContext, t: TargetInput): string {
  const acct = ctx.store.getAccount(t.platform, t.account);
  if (!acct) return `${t.platform}/${t.account} (연결 안 됨)`;
  const p = acct.profile as Record<string, string | undefined>;
  const who = p.channelTitle ?? p.username ?? p.pageName ?? p.displayName ?? t.account;
  return `${t.platform}/${t.account} → ${who}`;
}

function visibilityLabel(t: TargetInput, scheduledAt?: string): string {
  const o = t.options as Record<string, unknown>;
  switch (t.platform) {
    case 'youtube':
      return scheduledAt ? `private → ${scheduledAt}에 public` : String(o.privacy ?? '(미지정)');
    case 'tiktok':
      return o.mode === 'direct' ? `direct, ${String(o.privacyLevel ?? '(공개 범위 미지정)')}` : 'inbox (TikTok 앱에서 마무리)';
    default:
      return scheduledAt ? `public, ${scheduledAt}` : 'public';
  }
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
  fanout connect <platform> [--name main] [--token T] [--page ID]
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
  fanout prune [--days 7] [--dry-run]    다 올린 원본·오래된 변환 파일 정리 (~/.fanout 안만)
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

  // YouTube policy: show which channel and which visibility before uploading.
  console.log(`\n"${title}"  ${mediaPath}${input.scheduledAt ? `  예약 ${input.scheduledAt}` : ''}`);
  for (const t of targets) console.log(`  ${accountLabel(ctx, t).padEnd(40)} ${visibilityLabel(t, input.scheduledAt)}`);
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
    console.log(`  ${accountLabel(ctx, t).padEnd(40)} ${visibilityLabel(t, config.at)}`);
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
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
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

async function cmdRetry(ctx: ProviderContext, deps: RunnerDeps, args: Args): Promise<number> {
  const post = args.positionals[1] ? ctx.store.findPost(args.positionals[1]) : undefined;
  if (!post) throw new UsageError('fanout retry <postId> [platform]');
  const only = args.positionals[2];
  const ids: string[] = [];
  for (const t of ctx.store.targetsForPost(post.id)) {
    if ((t.state === 'failed' || t.state === 'needs_reauth') && (!only || t.platform === only)) {
      ctx.store.transition(t.id, 'queued', { attempts: 0, errorCode: undefined, errorMessage: undefined, notBefore: undefined }, 'manual retry');
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
