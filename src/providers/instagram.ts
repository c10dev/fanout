import { ProviderError } from '../core/errors.ts';
import type { DoctorCheck, PollOutcome, Provider, ProviderContext, PublishOutcome } from '../core/provider.ts';
import type { Account } from '../core/store.ts';
import type { Issue } from '../core/types.ts';
import { connectPage, definedOnly, graph, META_APP_FIELDS, META_SETUP_GUIDE, metaApp, metaCaption, missingScope, pageCreds, readInsights, rupload } from './meta.ts';
import { msg } from '../core/i18n.ts';

export interface InstagramOptions {
  caption?: string;
  /** Also show the Reel on the profile grid. Defaults to true on Instagram's side. */
  shareToFeed?: boolean;
  /** Cover frame offset in ms. */
  thumbOffsetMs?: number;
  /** Up to 3 Instagram usernames invited as collaborators (the Reel shows on their profiles too once they accept). */
  collaborators?: string[];
  /** Name of the Reel's original audio (can be renamed once). */
  audioName?: string;
}

const COLLABORATORS_MAX = 3;
const MENTIONS_MAX = 20;
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

/** Collaborators as a list, also when given as "alice, bob" (MCP, watch-folder JSON). */
function collaboratorsOf(o: InstagramOptions): string[] {
  const raw = o.collaborators as unknown;
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : [];
  return list.map((u) => u.trim().replace(/^@/, '')).filter(Boolean);
}

const CAPTION_MAX = 2200;
const HASHTAG_MAX = 30;

interface ContainerStatus {
  status_code?: 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';
  status?: string;
}

export async function publishingLimit(ctx: ProviderContext, account: Account): Promise<{ used: number; total: number } | undefined> {
  const c = pageCreds(account);
  const res = await graph<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(
    ctx,
    'GET',
    `/${c.igUserId}/content_publishing_limit`,
    { fields: 'quota_usage,config', access_token: c.pageToken },
  );
  const row = res.data?.[0];
  if (row?.quota_usage === undefined || row.config?.quota_total === undefined) return undefined;
  return { used: row.quota_usage, total: row.config.quota_total };
}

export const instagram: Provider = {
  id: 'instagram',
  displayName: 'Instagram Reels',
  appKey: 'meta',
  capabilities: { nativeSchedule: false, thumbnail: false, captions: false, syntheticMediaFlag: true },
  spec: {
    maxBytes: 300 * 1024 * 1024,
    minDurationSec: 3,
    maxDurationSec: 15 * 60,
    containers: ['mp4', 'mov'],
    videoCodecs: ['h264', 'hevc'],
    audioCodecs: ['aac'],
    maxAudioSampleRate: 48_000,
    minFps: 23,
    maxFps: 60,
    maxLongEdge: 1920,
    maxBitrate: 25_000_000,
    aspect: { min: 0.01, max: 10 },
  },
  appFields: META_APP_FIELDS,
  setupGuide: () => META_SETUP_GUIDE,

  connectMethod: 'token',
  connect: (ctx, name, flags) => connectPage(ctx, 'instagram', name, flags),

  // Page tokens from a long-lived user token don't expire; a revoked one surfaces as Graph error 190.
  refresh: async (_ctx, account) => account,

  validate(post, target, media) {
    const issues: Issue[] = [];
    const o = target.options as InstagramOptions;
    const caption = metaCaption(post, o.caption);
    if ([...caption].length > CAPTION_MAX) issues.push({ severity: 'error', code: 'caption', message: msg('Instagram 캡션은 {CAPTION_MAX}자 이하', { CAPTION_MAX }) });
    const hashtags = caption.match(/#[^\s#]+/g)?.length ?? 0;
    if (hashtags > HASHTAG_MAX) issues.push({ severity: 'error', code: 'hashtags', message: msg('Instagram 해시태그는 {HASHTAG_MAX}개 이하 (현재 {hashtags})', { HASHTAG_MAX, hashtags }) });
    const mentions = caption.match(/(^|[^\w@])@[A-Za-z0-9._]+/g)?.length ?? 0;
    if (mentions > MENTIONS_MAX) issues.push({ severity: 'error', code: 'mentions', message: msg('Instagram 캡션의 @멘션은 {MENTIONS_MAX}개 이하 (현재 {mentions})', { MENTIONS_MAX, mentions }) });
    if (o.thumbOffsetMs !== undefined && (!(o.thumbOffsetMs >= 0) || o.thumbOffsetMs > media.durationSec * 1000)) {
      issues.push({ severity: 'error', code: 'cover', message: msg('커버 장면은 0초~영상 길이({length}초) 사이여야 합니다', { length: media.durationSec.toFixed(1) }) });
    }
    const collaborators = collaboratorsOf(o);
    if (collaborators.length > COLLABORATORS_MAX) issues.push({ severity: 'error', code: 'collaborators', message: msg('Instagram 공동 작업자는 {COLLABORATORS_MAX}명까지', { COLLABORATORS_MAX }) });
    const bad = collaborators.filter((u) => !USERNAME.test(u));
    if (bad.length) issues.push({ severity: 'error', code: 'collaborators', message: msg('Instagram 사용자 이름이 아닙니다: {names}', { names: bad.join(', ') }) });
    const ratio = media.video.width / media.video.height;
    if (Math.abs(ratio - 9 / 16) > 0.02) {
      issues.push({ severity: 'warning', code: 'aspect', message: msg('Instagram Reels 권장 화면비는 9:16 (현재 {width}x{height}) — 잘리거나 여백이 생길 수 있습니다', { width: media.video.width, height: media.video.height }) });
    }
    if (post.thumbnailPath) issues.push({ severity: 'warning', code: 'thumbnail', message: msg('Instagram은 로컬 썸네일 파일을 받지 않습니다 — thumbOffsetMs로 커버 프레임을 고르세요') });
    if (post.scheduledAt) issues.push({ severity: 'warning', code: 'schedule', message: msg('Instagram은 API 예약 게시가 없어 fanout이 예약 시각에 게시합니다 (fanout worker 필요)') });
    return issues;
  },

  async publish({ ctx, post, target, account, mediaPath, saveResume }): Promise<PublishOutcome> {
    const c = pageCreds(account);
    const resume = (target.resume ?? {}) as { containerId?: string; uploaded?: boolean };
    if (resume.containerId && resume.uploaded) return { state: 'processing', remoteId: resume.containerId };

    const limit = await publishingLimit(ctx, account);
    if (limit && limit.used >= limit.total) {
      // A rolling 24-hour window: room comes back as older posts age out, so look again in an hour.
      throw new ProviderError('rejected', 'instagram.publishing_limit', msg('Instagram 24시간 게시 한도 {used}/{total}에 도달했습니다', { used: limit.used, total: limit.total }), undefined, {
        retryAt: new Date(ctx.now().getTime() + 3600_000),
      });
    }

    const o = target.options as InstagramOptions;
    const container = await graph<{ id: string; uri?: string }>(ctx, 'POST', `/${c.igUserId}/media`, {
      media_type: 'REELS',
      upload_type: 'resumable',
      caption: metaCaption(post, o.caption),
      share_to_feed: o.shareToFeed,
      thumb_offset: o.thumbOffsetMs,
      collaborators: collaboratorsOf(o).length ? JSON.stringify(collaboratorsOf(o)) : undefined,
      audio_name: o.audioName,
      // Self-disclosure of AI-generated or altered content, as --ai does on YouTube and TikTok.
      is_ai_generated: post.containsSyntheticMedia ? true : undefined,
      access_token: c.pageToken,
    });
    saveResume({ containerId: container.id, uploaded: false });
    const version = metaApp(ctx).graphVersion ?? 'v24.0';
    await rupload(ctx, container.uri ?? `https://rupload.facebook.com/ig-api-upload/${version}/${container.id}`, c.pageToken, mediaPath);
    saveResume({ containerId: container.id, uploaded: true });
    const warnings = limit ? [msg('Instagram 24시간 게시 {limit}/{total}', { limit: limit.used + 1, total: limit.total })] : [];
    return { state: 'processing', remoteId: container.id, warnings };
  },

  async poll({ ctx, target, account }): Promise<PollOutcome> {
    const c = pageCreds(account);
    const resume = (target.resume ?? {}) as { containerId?: string; mediaId?: string; permalink?: string };
    if (resume.mediaId) return { state: 'published', remoteId: resume.mediaId, remoteUrl: resume.permalink };

    const containerId = resume.containerId ?? target.remoteId;
    const status = await graph<ContainerStatus>(ctx, 'GET', `/${containerId}`, { fields: 'status_code,status', access_token: c.pageToken });
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new ProviderError('rejected', `instagram.container_${status.status_code.toLowerCase()}`, msg('Instagram 컨테이너 {status_code}: {status}', { status_code: status.status_code, status: status.status ?? '' }), status.status);
    }
    if (status.status_code === 'PUBLISHED') {
      // Published earlier but the media id was never saved (e.g. crash right after media_publish).
      return { state: 'published', remoteId: containerId, warnings: [msg('이미 게시된 컨테이너입니다. 게시물 링크는 Instagram 앱에서 확인하세요')] };
    }
    if (status.status_code !== 'FINISHED') return { state: 'processing', remoteId: containerId };

    const published = await graph<{ id: string }>(ctx, 'POST', `/${c.igUserId}/media_publish`, { creation_id: containerId, access_token: c.pageToken });
    const media = await graph<{ permalink?: string }>(ctx, 'GET', `/${published.id}`, { fields: 'permalink', access_token: c.pageToken }).catch(
      () => ({}) as { permalink?: string },
    );
    ctx.store.updateTarget(target.id, { resume: { ...resume, mediaId: published.id, permalink: media.permalink } });
    return { state: 'published', remoteId: published.id, remoteUrl: media.permalink };
  },

  async limits({ ctx, account }) {
    const limit = await publishingLimit(ctx, account);
    if (!limit) return [{ what: msg('24시간 게시'), unit: 'posts', note: msg('응답에 quota 값이 없습니다') }];
    return [{ what: msg('24시간 게시'), unit: 'posts', used: limit.used, total: limit.total, remaining: Math.max(0, limit.total - limit.used) }];
  },

  async doctor({ ctx, account }): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    try {
      metaApp(ctx);
      checks.push({ name: msg('BYO 앱'), status: 'ok', detail: msg('Meta 앱 등록됨') });
    } catch (err) {
      checks.push({ name: msg('BYO 앱'), status: 'fail', detail: (err as Error).message });
      return checks;
    }
    const c = pageCreds(account);
    try {
      const me = await graph<{ username?: string; account_type?: string }>(ctx, 'GET', `/${c.igUserId}`, { fields: 'username', access_token: c.pageToken });
      checks.push({ name: msg('계정'), status: 'ok', detail: `@${me.username}` });
    } catch (err) {
      checks.push({ name: msg('계정'), status: 'fail', detail: (err as Error).message });
      return checks;
    }
    // Open question from the research: the docs give both 100 and 50 posts/24h. Ask the API.
    try {
      const limit = await publishingLimit(ctx, account);
      checks.push(
        limit
          ? { name: msg('24시간 게시 한도 (실측)'), status: limit.used >= limit.total ? 'fail' : 'ok', detail: `${limit.used}/${limit.total}` }
          : { name: msg('24시간 게시 한도 (실측)'), status: 'warn', detail: msg('응답에 quota 값이 없습니다') },
      );
    } catch (err) {
      checks.push({ name: msg('24시간 게시 한도 (실측)'), status: 'fail', detail: (err as Error).message });
    }
    return checks;
  },

  async stats({ ctx, account, target }) {
    const c = pageCreds(account);
    const m = await graph<{ like_count?: number; comments_count?: number }>(ctx, 'GET', `/${target.remoteId}`, {
      fields: 'like_count,comments_count',
      access_token: c.pageToken,
    });
    // Views and shares come from media insights (instagram_manage_insights; up to 48 hours late).
    const ins = await readInsights(ctx, `/${target.remoteId}/insights`, { metric: 'views,shares', access_token: c.pageToken }, 'instagram_manage_insights');
    const last = ins.transient ? target.stats : undefined;
    // Deeper Reels metrics in a call of their own: one the media doesn't have can't cost the views.
    const more = ins.note ? undefined : await readInsights(ctx, `/${target.remoteId}/insights`, { metric: 'reach,saved,ig_reels_avg_watch_time,ig_reels_video_view_total_time', access_token: c.pageToken }, 'instagram_manage_insights');
    const ms = (v?: number) => (v === undefined ? undefined : Math.round(v / 100) / 10);
    // A passing failure of either call keeps that call's last numbers rather than dropping them.
    const keep = ins.transient || more?.transient ? target.stats : undefined;
    return definedOnly({
      views: ins.values.views ?? last?.views,
      likes: m.like_count,
      comments: m.comments_count,
      shares: ins.values.shares ?? last?.shares,
      reach: more?.values.reach ?? keep?.reach,
      saves: more?.values.saved ?? keep?.saves,
      avgWatchSec: ms(more?.values.ig_reels_avg_watch_time) ?? keep?.avgWatchSec,
      watchTimeSec: ms(more?.values.ig_reels_video_view_total_time) ?? keep?.watchTimeSec,
      ...(ins.note ? { note: ins.note } : {}),
    });
  },

  // instagram_manage_comments; reversible with hide=false.
  async hideComment({ ctx, account, commentId, hidden }) {
    await graph(ctx, 'POST', `/${commentId}`, { hide: hidden, access_token: pageCreds(account).pageToken });
  },

  // Needs the instagram_manage_comments permission on the token (see the Meta setup guide).
  async comments({ ctx, account, target, limit }) {
    const c = pageCreds(account);
    const res = await graph<{ data?: Array<{ id: string; text?: string; username?: string; timestamp: string; like_count?: number }> }>(
      ctx,
      'GET',
      `/${target.remoteId}/comments`,
      { fields: 'id,text,username,timestamp,like_count', limit: Math.min(limit, 50), access_token: c.pageToken },
    );
    return (res.data ?? []).map((m) => ({ id: m.id, author: m.username ? `@${m.username}` : '', text: m.text ?? '', at: m.timestamp, likes: m.like_count }));
  },

  async reply({ ctx, account, comment, text, sending }) {
    const c = pageCreds(account);
    sending();
    const res = await graph<{ id: string }>(ctx, 'POST', `/${comment.id}/replies`, { message: text, access_token: c.pageToken }).catch((err: unknown) => {
      throw missingScope(err, 'instagram_manage_comments');
    });
    return { id: res.id };
  },
};
