import { ProviderError } from '../core/errors.ts';
import type { DoctorCheck, PollOutcome, Provider, PublishOutcome } from '../core/provider.ts';
import type { ProviderContext } from '../core/provider.ts';
import type { Issue, Post } from '../core/types.ts';
import { META_APP_FIELDS, META_SETUP_GUIDE, connectPage, graph, metaApp, metaCaption, missingScope, pageCreds, readInsights, rupload } from './meta.ts';

export interface FacebookOptions {
  caption?: string;
}

/** Native scheduling window for Page Reels. */
const SCHEDULE_MIN_MS = 10 * 60_000;
const SCHEDULE_MAX_MS = 29 * 86_400_000;

interface ReelStatus {
  status?: {
    video_status?: string;
    uploading_phase?: { status?: string; errors?: Array<{ message?: string }> };
    processing_phase?: { status?: string; errors?: Array<{ message?: string }> };
    publishing_phase?: { status?: string; publish_status?: string; publish_time?: number; errors?: Array<{ message?: string }> };
  };
}

async function finishReel(ctx: ProviderContext, pageId: string, pageToken: string, videoId: string, post: Post, o: FacebookOptions): Promise<void> {
  await graph<{ success: boolean }>(ctx, 'POST', `/${pageId}/video_reels`, {
    upload_phase: 'finish',
    video_id: videoId,
    description: metaCaption(post, o.caption),
    video_state: post.scheduledAt ? 'SCHEDULED' : 'PUBLISHED',
    scheduled_publish_time: post.scheduledAt ? Math.floor(new Date(post.scheduledAt).getTime() / 1000) : undefined,
    access_token: pageToken,
  });
}

export function reelOutcome(videoId: string, s: ReelStatus): PollOutcome {
  const st = s.status ?? {};
  const err = st.uploading_phase?.errors?.[0]?.message ?? st.processing_phase?.errors?.[0]?.message ?? st.publishing_phase?.errors?.[0]?.message;
  if (
    st.video_status === 'error' ||
    st.video_status === 'expired' ||
    st.uploading_phase?.status === 'error' ||
    st.processing_phase?.status === 'error' ||
    st.publishing_phase?.status === 'error'
  ) {
    throw new ProviderError('rejected', 'facebook.reel_error', `Facebook Reels 처리 실패: ${err ?? st.video_status}`);
  }
  const url = `https://www.facebook.com/reel/${videoId}`;
  if (st.publishing_phase?.status === 'complete') {
    if (st.publishing_phase.publish_status === 'scheduled') {
      const when = st.publishing_phase.publish_time ? new Date(st.publishing_phase.publish_time * 1000).toISOString() : '?';
      return { state: 'published', remoteId: videoId, remoteUrl: url, warnings: [`예약 게시: ${when}`] };
    }
    return { state: 'published', remoteId: videoId, remoteUrl: url };
  }
  return { state: 'processing', remoteId: videoId, remoteUrl: url };
}


async function reelGone(ctx: ProviderContext, pageId: string, pageToken: string, videoId: string): Promise<boolean> {
  const missing = (err: unknown) => err instanceof ProviderError && Boolean(err.platformCode?.startsWith('100'));
  try {
    await graph(ctx, 'GET', `/${videoId}`, { fields: 'id', access_token: pageToken });
    return false;
  } catch (err) {
    if (!missing(err)) throw err;
  }
  // Rule out a token that can't see anything any more.
  await graph(ctx, 'GET', `/${pageId}`, { fields: 'id', access_token: pageToken });
  return true;
}

export const facebook: Provider = {
  id: 'facebook',
  scheduleMaxAheadMs: SCHEDULE_MAX_MS,
  displayName: 'Facebook Reels (Page)',
  appKey: 'meta',
  capabilities: { nativeSchedule: true, thumbnail: false, captions: false, syntheticMediaFlag: false },
  spec: {
    minDurationSec: 3,
    maxDurationSec: 90,
    containers: ['mp4', 'mov'],
    videoCodecs: ['h264'],
    audioCodecs: ['aac'],
    maxAudioSampleRate: 48_000,
    minFps: 24,
    maxFps: 60,
    minShortEdge: 540,
    maxLongEdge: 1920,
    aspect: { min: 9 / 16, max: 9 / 16 },
  },
  appFields: META_APP_FIELDS,
  setupGuide: () => META_SETUP_GUIDE,

  connectMethod: 'token',
  connect: (ctx, name, flags) => connectPage(ctx, 'facebook', name, flags),
  refresh: async (_ctx, account) => account,

  validate(post, _target, _media) {
    const issues: Issue[] = [];
    if (post.scheduledAt) {
      const delta = new Date(post.scheduledAt).getTime() - Date.now();
      if (delta < SCHEDULE_MIN_MS) {
        issues.push({ severity: 'error', code: 'schedule_window', message: 'Facebook Reels 예약은 10분 뒤부터 가능합니다' });
      } else if (delta > SCHEDULE_MAX_MS) {
        // createScheduledPost holds the target until the time is within reach (scheduleMaxAheadMs).
        issues.push({ severity: 'warning', code: 'schedule_window', message: 'Facebook은 29일 안쪽만 예약할 수 있어, 예약 28일 전에 올립니다 (그때 fanout이 켜져 있어야 합니다)' });
      }
    }
    if (post.thumbnailPath) issues.push({ severity: 'warning', code: 'thumbnail', message: 'Facebook Reels API는 썸네일 업로드를 지원하지 않아 무시됩니다' });
    return issues;
  },

  async publish({ ctx, post, target, account, mediaPath, saveResume }): Promise<PublishOutcome> {
    const c = pageCreds(account);
    const resume = (target.resume ?? {}) as { videoId?: string; finished?: boolean };
    if (resume.videoId && resume.finished) return { state: 'processing', remoteId: resume.videoId };
    const o = target.options as FacebookOptions;

    // An earlier attempt got as far as creating the video. If its finish call went through (the
    // response may have been lost), starting over would publish a second Reel.
    if (resume.videoId) {
      const st = await graph<ReelStatus>(ctx, 'GET', `/${resume.videoId}`, { fields: 'status', access_token: c.pageToken }).catch(() => undefined);
      const phases = st?.status;
      const published = phases?.publishing_phase?.status && phases.publishing_phase.status !== 'not_started';
      if (published || (phases?.processing_phase?.status && phases.processing_phase.status !== 'not_started')) {
        saveResume({ videoId: resume.videoId, finished: true, pageId: c.pageId });
        return { state: 'processing', remoteId: resume.videoId, remoteUrl: `https://www.facebook.com/reel/${resume.videoId}` };
      }
      if (phases?.uploading_phase?.status === 'complete') {
        // Bytes arrived but finish never registered: finish the same video instead of re-uploading.
        await finishReel(ctx, c.pageId, c.pageToken, resume.videoId, post, o);
        saveResume({ videoId: resume.videoId, finished: true, pageId: c.pageId });
        return { state: 'processing', remoteId: resume.videoId, remoteUrl: `https://www.facebook.com/reel/${resume.videoId}` };
      }
      // Otherwise the old video never got its bytes and can't publish; start a fresh one.
    }

    const start = await graph<{ video_id: string; upload_url: string }>(ctx, 'POST', `/${c.pageId}/video_reels`, {
      upload_phase: 'start',
      access_token: c.pageToken,
    });
    saveResume({ videoId: start.video_id, finished: false, pageId: c.pageId });
    await rupload(ctx, start.upload_url, c.pageToken, mediaPath);

    await finishReel(ctx, c.pageId, c.pageToken, start.video_id, post, o);
    saveResume({ videoId: start.video_id, finished: true, pageId: c.pageId });
    return { state: 'processing', remoteId: start.video_id, remoteUrl: `https://www.facebook.com/reel/${start.video_id}` };
  },

  async poll({ ctx, target, account }) {
    const c = pageCreds(account);
    const s = await graph<ReelStatus>(ctx, 'GET', `/${target.remoteId}`, { fields: 'status', access_token: c.pageToken });
    return reelOutcome(target.remoteId, s);
  },

  async doctor({ ctx, account }): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    try {
      metaApp(ctx);
      checks.push({ name: 'BYO 앱', status: 'ok', detail: 'Meta 앱 등록됨' });
    } catch (err) {
      checks.push({ name: 'BYO 앱', status: 'fail', detail: (err as Error).message });
      return checks;
    }
    const c = pageCreds(account);
    try {
      const page = await graph<{ name?: string }>(ctx, 'GET', `/${c.pageId}`, { fields: 'name', access_token: c.pageToken });
      checks.push({ name: '페이지', status: 'ok', detail: `${page.name} (${c.pageId})` });
    } catch (err) {
      checks.push({ name: '페이지', status: 'fail', detail: (err as Error).message });
    }
    return checks;
  },

  async stats({ ctx, account, target }) {
    const c = pageCreds(account);
    const v = await graph<{ likes?: { summary?: { total_count?: number } }; comments?: { summary?: { total_count?: number } } }>(
      ctx,
      'GET',
      `/${target.remoteId}`,
      { fields: 'likes.summary(true).limit(0),comments.summary(true).limit(0)', access_token: c.pageToken },
    );
    // Plays come from video insights (read_insights on the Page token).
    const ins = await readInsights(ctx, `/${target.remoteId}/video_insights`, { metric: 'fb_reels_total_plays', period: 'lifetime', access_token: c.pageToken }, 'read_insights·pages_manage_engagement');
    return { views: ins.values.fb_reels_total_plays ?? (ins.transient ? target.stats?.views : undefined), likes: v.likes?.summary?.total_count, comments: v.comments?.summary?.total_count, ...(ins.note ? { note: ins.note } : {}) };
  },

  async remove({ ctx, account, target }) {
    const c = pageCreds(account);
    // Graph's "does not exist" (100/33) also covers "this token can't see it" (e.g. the account was
    // reconnected to another Page), so an error is never taken as "already deleted".
    await graph<{ success?: boolean }>(ctx, 'DELETE', `/${target.remoteId}`, { access_token: c.pageToken }).catch(async (err: unknown) => {
      if (err instanceof ProviderError && err.platformCode?.startsWith('100')) {
        // The same Page that posted it can always see its own reel, so if that token reads the Page
        // but not the reel, the reel is gone (deleted elsewhere, or our DELETE's response was lost).
        if ((target.resume as { pageId?: string } | undefined)?.pageId === c.pageId && (await reelGone(ctx, c.pageId, c.pageToken, target.remoteId))) return;
        throw new ProviderError('rejected', 'facebook.not_found', `지우지 못했습니다: 이 페이지 토큰으로는 영상을 찾을 수 없습니다. 페이지에서 직접 확인해 주세요 (${err.platformCode})`, err.platformCode);
      }
      throw err;
    });
  },

  async update({ ctx, account, target, post }) {
    const c = pageCreds(account);
    await graph<{ success?: boolean }>(ctx, 'POST', `/${target.remoteId}`, {
      description: metaCaption(post, (target.options as FacebookOptions).caption),
      access_token: c.pageToken,
    });
  },

  async comments({ ctx, account, target, limit }) {
    const c = pageCreds(account);
    const res = await graph<{ data?: Array<{ id: string; message?: string; created_time: string; like_count?: number; comment_count?: number; from?: { name?: string } }> }>(
      ctx,
      'GET',
      `/${target.remoteId}/comments`,
      { fields: 'from{name},message,created_time,like_count,comment_count', order: 'reverse_chronological', limit: Math.min(limit, 100), access_token: c.pageToken },
    );
    return (res.data ?? []).map((m) => ({ id: m.id, author: m.from?.name ?? '(이름 없음)', text: m.message ?? '', at: m.created_time, likes: m.like_count, replies: m.comment_count }));
  },

  // Replying as the Page needs pages_manage_engagement, which posting alone doesn't.
  async reply({ ctx, account, comment, text, sending }) {
    const c = pageCreds(account);
    sending();
    const res = await graph<{ id: string }>(ctx, 'POST', `/${comment.id}/comments`, { message: text, access_token: c.pageToken }).catch((err: unknown) => {
      throw missingScope(err, 'pages_manage_engagement');
    });
    return { id: res.id };
  },
};
