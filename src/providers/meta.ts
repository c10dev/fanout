import { readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { ProviderError, kindForStatus, type ErrorKind } from '../core/errors.ts';
import { jsonOr } from '../core/http.ts';
import type { ProviderContext } from '../core/provider.ts';
import type { Account } from '../core/store.ts';
import type { Post, PostStats } from '../core/types.ts';
import { msg } from '../core/i18n.ts';

// Shared plumbing for Instagram (via Facebook Login) and Facebook Pages.
// Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
//       https://developers.facebook.com/docs/video-api/guides/reels-publishing

export const DEFAULT_GRAPH_VERSION = 'v24.0';

export interface MetaApp {
  appId: string;
  appSecret: string;
  graphVersion?: string;
}

/** Page access tokens minted from a long-lived user token do not expire. */
export interface MetaPageCredentials {
  pageId: string;
  pageToken: string;
  igUserId?: string;
}

export const META_APP_FIELDS = [
  { key: 'appId', label: 'App ID', secret: false },
  { key: 'appSecret', label: 'App secret', secret: true },
  { key: 'graphVersion', label: msg('Graph API 버전 (기본 {DEFAULT_GRAPH_VERSION})', { DEFAULT_GRAPH_VERSION }), secret: false, optional: true },
] as const;

export const META_SETUP_GUIDE = msg(`Instagram · Facebook — 내 Meta 앱 만들기 (BYO, 두 플랫폼 공용)

앱에 역할(관리자·개발자·테스터)이 있는 사용자는 App Review 없이 Standard Access로 게시할 수 있습니다.

1. https://developers.facebook.com/apps 에서 앱 생성 (유형: Business)
2. 제품 추가: "Facebook 로그인(비즈니스용)", "Instagram Graph API"
3. Instagram은 프로페셔널(비즈니스/크리에이터) 계정이어야 하고 Facebook 페이지에 연결돼 있어야 합니다
   Facebook Reels는 개인 프로필이 아니라 페이지에만 올릴 수 있습니다
4. fanout app set meta --appId <ID> --appSecret <SECRET>
5. Graph API 탐색기(https://developers.facebook.com/tools/explorer/)에서 내 앱을 고르고
   권한 pages_show_list, pages_read_engagement, pages_manage_posts,
   instagram_basic, instagram_content_publish, business_management 를 선택해 "Generate Access Token"
   (댓글 모아보기·Instagram 답글: instagram_manage_comments, Facebook 답글: pages_manage_engagement,
    조회수: Instagram은 instagram_manage_insights, Facebook은 read_insights 도 선택)
6. 그 토큰으로 연결 (장기 토큰으로 바꾼 뒤, 만료되지 않는 페이지 토큰을 저장합니다):
     fanout connect instagram --name main [--page <페이지 ID>]
     fanout connect facebook  --name main [--page <페이지 ID>]
7. fanout doctor instagram 으로 오늘 남은 게시 한도를 확인

⚠ 공식 문서에 Instagram 하루 한도가 100건과 50건으로 엇갈려 있어, fanout은 매번
   content_publishing_limit를 직접 조회합니다.`);

export function metaApp(ctx: ProviderContext): MetaApp {
  const a = ctx.store.getApp<MetaApp>('meta');
  if (!a?.appId || !a.appSecret) {
    throw new ProviderError('auth', 'meta.app_missing', msg('Meta 앱이 설정되지 않았습니다 — fanout setup instagram 참고'));
  }
  return a;
}

export function graphBase(ctx: ProviderContext): string {
  return `https://graph.facebook.com/${metaApp(ctx).graphVersion ?? DEFAULT_GRAPH_VERSION}`;
}

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string };
}

export function graphError(status: number, body: GraphError | undefined): ProviderError {
  const e = body?.error;
  const code = e?.code;
  let kind: ErrorKind = kindForStatus(status);
  // 190: invalid/expired token. 10/200-299: permission missing.
  if (code === 190 || code === 10 || (code !== undefined && code >= 200 && code < 300)) kind = 'auth';
  // 4/17/32/613: rate limits. 2: temporary service error.
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 2) kind = 'retryable';
  // 9: IG publishing limit reached for the day.
  if (code === 9) kind = 'rejected';
  const platformCode = code !== undefined ? `${code}${e?.error_subcode ? `/${e.error_subcode}` : ''}` : undefined;
  return new ProviderError(kind, `meta.${code ?? `http_${status}`}`, e?.error_user_msg ?? e?.message ?? `Graph API HTTP ${status}`, platformCode);
}

export async function graph<T>(
  ctx: ProviderContext,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
  const url = path.startsWith('http') ? path : `${graphBase(ctx)}${path}`;
  const res =
    method === 'GET'
      ? await ctx.fetch(`${url}?${qs}`)
      : await ctx.fetch(url, { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: qs });
  const body = (await jsonOr(res, undefined)) as (T & GraphError) | undefined;
  if (!res.ok || body?.error) throw graphError(res.status, body);
  return body as T;
}

/** Push the whole file to a rupload endpoint (resumable protocol, offset 0). */
export async function rupload(ctx: ProviderContext, url: string, token: string, path: string): Promise<void> {
  const size = statSync(path).size;
  const res = await ctx.fetch(url, {
    method: 'POST',
    headers: { authorization: `OAuth ${token}`, offset: '0', file_size: String(size), 'content-type': 'application/octet-stream' },
    body: readFileSync(path),
  });
  const body = (await jsonOr(res, undefined)) as (GraphError & { success?: boolean }) | undefined;
  if (!res.ok || body?.error || body?.success === false) throw graphError(res.status, body);
}

interface PageRow {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

/**
 * Exchange a pasted short-lived user token for a long-lived one, then pick a Page and keep its
 * (non-expiring) Page token.
 */
export async function connectPage(
  ctx: ProviderContext,
  platform: 'instagram' | 'facebook',
  name: string,
  flags: Record<string, string | boolean | undefined>,
): Promise<Account> {
  const app = metaApp(ctx);
  let userToken = typeof flags.token === 'string' ? flags.token : undefined;
  if (!userToken) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      userToken = (await rl.question(msg('Graph API 탐색기에서 만든 사용자 액세스 토큰: '))).trim();
    } finally {
      rl.close();
    }
  }
  const long = await graph<{ access_token: string }>(ctx, 'GET', '/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: app.appId,
    client_secret: app.appSecret,
    fb_exchange_token: userToken,
  });
  const pages = await graph<{ data: PageRow[] }>(ctx, 'GET', '/me/accounts', {
    fields: 'id,name,access_token,instagram_business_account{id,username}',
    access_token: long.access_token,
    limit: 100,
  });
  const candidates = platform === 'instagram' ? pages.data.filter((p) => p.instagram_business_account) : pages.data;
  if (!candidates.length) {
    throw new ProviderError(
      'rejected',
      `${platform}.no_page`,
      platform === 'instagram'
        ? msg('Instagram 프로페셔널 계정이 연결된 Facebook 페이지가 없습니다 (토큰 권한도 확인하세요)')
        : msg('관리 중인 Facebook 페이지가 없습니다 (pages_show_list 권한 확인)'),
    );
  }
  const wanted = typeof flags.page === 'string' ? flags.page : undefined;
  const page = wanted ? candidates.find((p) => p.id === wanted || p.name === wanted) : candidates[0];
  if (!page) {
    throw new ProviderError('rejected', `${platform}.page_not_found`, msg('페이지 {wanted} 없음. 후보: {candidates}', { wanted, candidates: candidates.map((p) => `${p.name}(${p.id})`).join(', ') }));
  }
  if (!wanted && candidates.length > 1) {
    ctx.log.warn(msg('페이지가 여러 개라 첫 번째({page})를 골랐습니다. 다른 페이지는 --page <ID>: {candidates}', { page: page.name, candidates: candidates.map((p) => `${p.name}(${p.id})`).join(', ') }));
  }
  const credentials: MetaPageCredentials = { pageId: page.id, pageToken: page.access_token, igUserId: page.instagram_business_account?.id };
  return {
    platform,
    name,
    credentials: { ...credentials },
    profile:
      platform === 'instagram'
        ? { username: page.instagram_business_account?.username, igUserId: page.instagram_business_account?.id, pageName: page.name }
        : { pageName: page.name, pageId: page.id },
  };
}

/**
 * Explain a failed one-shot write (a comment reply): a permission error names the scope the original
 * connection guide didn't grant, and a rate limit (4/17/32/613, the request was not executed) is a
 * plain "not sent" rather than "may have posted".
 */
export function missingScope(err: unknown, scope: string): unknown {
  if (!(err instanceof ProviderError) || !err.platformCode) return err;
  const code = Number.parseInt(err.platformCode, 10);
  if ([4, 17, 32, 613].includes(code)) {
    return new ProviderError('rejected', err.code, msg('요청 한도에 걸려 보내지 못했습니다. 잠시 뒤 다시 시도하세요 ({message})', { message: err.message }), err.platformCode);
  }
  if (err.kind !== 'auth') return err;
  if (code !== 10 && !(code >= 200 && code < 300)) return err;
  return new ProviderError(
    'auth',
    err.code,
    msg('권한이 없습니다: {scope} 권한을 더해 Graph API 탐색기에서 토큰을 다시 만들고 다시 연결하세요 ({message})', { scope, message: err.message }),
    err.platformCode,
  );
}

interface InsightRow {
  name: string;
  values?: Array<{ value?: number }>;
  total_value?: { value?: number };
}

/**
 * Read lifetime insight metrics; resolves to the numbers by name, or to why they couldn't be read.
 * Insights need extra permissions the posting scopes don't include, so a refusal is expected and
 * only costs the view count.
 */
export async function readInsights(
  ctx: ProviderContext,
  path: string,
  params: Record<string, string>,
  scope: string,
): Promise<{ values: Record<string, number>; note?: string; transient?: boolean }> {
  try {
    const res = await graph<{ data?: InsightRow[] }>(ctx, 'GET', path, params);
    const values: Record<string, number> = {};
    for (const row of res.data ?? []) {
      const v = row.values?.[0]?.value ?? row.total_value?.value;
      if (typeof v === 'number') values[row.name] = v;
    }
    return { values };
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'auth') return { values: {}, note: msg('조회수는 {scope} 권한이 있어야 가져올 수 있습니다', { scope }) };
    // A rate limit or server hiccup: the caller keeps the last numbers it had. Anything else (e.g. a
    // metric this media doesn't have) is permanent, and old numbers would go stale forever.
    // Timeouts and network failures aren't ProviderErrors, and are just as passing.
    const transient = !(err instanceof ProviderError) || err.kind === 'retryable';
    return { values: {}, note: msg('조회수를 가져오지 못했습니다: {err}', { err: err instanceof Error ? err.message : String(err) }), ...(transient ? { transient } : {}) };
  }
}

interface CopyrightInfo {
  status?: { status?: string; matches_found?: boolean };
  copyright_matches?: Array<{ content_title?: string; author?: string; owner_copyright_policy?: { name?: string; actions?: Array<{ action?: string; geos?: string[] }> } }>;
}

/**
 * Meta's copyright check on a published reel (Instagram media and Facebook Reels alike): once it has
 * finished, whether anything matched, and an alert for each match that mutes or blocks the video
 * somewhere. Read on its own, so a token or media type without the field never costs the stats; a
 * finished result is kept by the caller and not read again.
 */
export async function copyrightCheck(ctx: ProviderContext, id: string, token: string): Promise<Pick<PostStats, 'copyright' | 'alerts'>> {
  const res = await graph<{ copyright_check_information?: CopyrightInfo }>(ctx, 'GET', `/${id}`, { fields: 'copyright_check_information', access_token: token }).catch(() => undefined);
  const info = res?.copyright_check_information;
  const status = info?.status?.status;
  // "complete" on Facebook, "completed" on Instagram; anything else is still running (or failed).
  if (status !== 'complete' && status !== 'completed') return {};
  if (!info?.status?.matches_found) return { copyright: 'clear' };
  const labels: Record<string, string> = { BLOCK: msg('차단'), MUTE: msg('음소거') };
  const alerts = (info.copyright_matches ?? []).flatMap((m) =>
    (m.owner_copyright_policy?.actions ?? [])
      .filter((a) => a.action === 'BLOCK' || a.action === 'MUTE')
      .map((a) =>
        msg('저작권 일치 "{title}": {action} ({where})', {
          title: m.content_title ?? m.author ?? '?',
          action: labels[a.action!]!,
          where: a.geos?.length ? a.geos.join(', ') : msg('모든 지역'),
        }),
      ),
  );
  return { copyright: 'matched', ...(alerts.length ? { alerts } : {}) };
}

/** Stats without the fields nothing was read for, so they stay absent rather than `undefined`. */
export function definedOnly<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function pageCreds(account: Account): MetaPageCredentials {
  return account.credentials as unknown as MetaPageCredentials;
}

export function metaCaption(post: Post, override?: string): string {
  if (override !== undefined) return override;
  const tags = post.tags.map((t) => `#${t.replace(/^#/, '').replace(/\s+/g, '')}`).join(' ');
  return [post.title, post.description, tags].filter((s) => s.trim()).join('\n\n');
}
