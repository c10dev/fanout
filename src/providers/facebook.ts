import { ProviderError } from '../core/errors.ts';
import type { DoctorCheck, PollOutcome, Provider, PublishOutcome } from '../core/provider.ts';
import type { ProviderContext } from '../core/provider.ts';
import type { Issue, Post } from '../core/types.ts';
import { META_APP_FIELDS, META_SETUP_GUIDE, connectPage, graph, metaApp, metaCaption, pageCreds, rupload } from './meta.ts';

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

export const facebook: Provider = {
  id: 'facebook',
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
      if (delta < SCHEDULE_MIN_MS || delta > SCHEDULE_MAX_MS) {
        issues.push({ severity: 'error', code: 'schedule_window', message: 'Facebook Reels 예약은 10분 뒤부터 29일 뒤까지만 가능합니다' });
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
        saveResume({ videoId: resume.videoId, finished: true });
        return { state: 'processing', remoteId: resume.videoId, remoteUrl: `https://www.facebook.com/reel/${resume.videoId}` };
      }
      if (phases?.uploading_phase?.status === 'complete') {
        // Bytes arrived but finish never registered: finish the same video instead of re-uploading.
        await finishReel(ctx, c.pageId, c.pageToken, resume.videoId, post, o);
        saveResume({ videoId: resume.videoId, finished: true });
        return { state: 'processing', remoteId: resume.videoId, remoteUrl: `https://www.facebook.com/reel/${resume.videoId}` };
      }
      // Otherwise the old video never got its bytes and can't publish; start a fresh one.
    }

    const start = await graph<{ video_id: string; upload_url: string }>(ctx, 'POST', `/${c.pageId}/video_reels`, {
      upload_phase: 'start',
      access_token: c.pageToken,
    });
    saveResume({ videoId: start.video_id, finished: false });
    await rupload(ctx, start.upload_url, c.pageToken, mediaPath);

    await finishReel(ctx, c.pageId, c.pageToken, start.video_id, post, o);
    saveResume({ videoId: start.video_id, finished: true });
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
};
