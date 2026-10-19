import { existsSync } from 'node:fs';
import { ProviderError } from '../core/errors.ts';
import { imageMime } from '../core/http.ts';
import type { DoctorCheck, PollOutcome, Provider, PublishOutcome } from '../core/provider.ts';
import type { ProviderContext } from '../core/provider.ts';
import type { Issue, Post } from '../core/types.ts';
import { connectPage, copyrightCheck, definedOnly, graph, graphUpload, META_APP_FIELDS, META_SETUP_GUIDE, metaApp, metaCaption, missingScope, pageCreds, readInsights, rupload } from './meta.ts';
import { msg } from '../core/i18n.ts';

export interface FacebookOptions {
  caption?: string;
  /** Title shown with the Reel (none unless given). */
  title?: string;
  /** Upload as a draft in the Page's content library instead of publishing; finish it in Meta Business Suite. */
  draft?: boolean;
  /** Pages invited as collaborators (Page IDs); the reel shows on theirs too once they accept. */
  collaborators?: string[];
  /** Location tag: the ID of a Page that has a location (place). */
  placeId?: string;
}

const COLLAB_MAX = 10;

/** Page IDs as a list, also when given as "123, 456" (MCP, watch-folder JSON). */
function collaboratorPages(o: FacebookOptions): string[] {
  const raw = o.collaborators as unknown;
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : [];
  return list.map((v) => v.trim()).filter(Boolean);
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
    title: o.title,
    place: o.placeId,
    video_state: o.draft ? 'DRAFT' : post.scheduledAt ? 'SCHEDULED' : 'PUBLISHED',
    scheduled_publish_time: post.scheduledAt && !o.draft ? Math.floor(new Date(post.scheduledAt).getTime() / 1000) : undefined,
    access_token: pageToken,
  });
}

export function reelOutcome(videoId: string, s: ReelStatus, draft = false): PollOutcome {
  const st = s.status ?? {};
  const err = st.uploading_phase?.errors?.[0]?.message ?? st.processing_phase?.errors?.[0]?.message ?? st.publishing_phase?.errors?.[0]?.message;
  if (
    st.video_status === 'error' ||
    st.video_status === 'expired' ||
    st.uploading_phase?.status === 'error' ||
    st.processing_phase?.status === 'error' ||
    st.publishing_phase?.status === 'error'
  ) {
    throw new ProviderError('rejected', 'facebook.reel_error', msg('Facebook Reels 처리 실패: {err}', { err: err ?? st.video_status }));
  }
  const url = `https://www.facebook.com/reel/${videoId}`;
  // A draft is done once processed: it waits in the Page's content library for the user to post it.
  if (draft && st.processing_phase?.status === 'complete') {
    return { state: 'handed_off', remoteId: videoId, warnings: [msg('Facebook 초안으로 저장했습니다. Meta Business Suite의 콘텐츠에서 게시하세요')] };
  }
  if (st.publishing_phase?.status === 'complete') {
    if (st.publishing_phase.publish_status === 'scheduled') {
      const when = st.publishing_phase.publish_time ? new Date(st.publishing_phase.publish_time * 1000).toISOString() : '?';
      return { state: 'published', remoteId: videoId, remoteUrl: url, warnings: [msg('예약 게시: {when}', { when })] };
    }
    return { state: 'published', remoteId: videoId, remoteUrl: url };
  }
  // A draft has no public page: no link while it processes either (it would carry over to handed_off).
  return { state: 'processing', remoteId: videoId, remoteUrl: draft ? undefined : url };
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
  capabilities: { nativeSchedule: true, thumbnail: true, captions: false, syntheticMediaFlag: false },
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

  validate(post, target, _media) {
    const issues: Issue[] = [];
    const o = target.options as FacebookOptions;
    if (o.placeId !== undefined && !/^\d+$/.test(String(o.placeId))) issues.push({ severity: 'error', code: 'place', message: msg('장소는 위치가 있는 페이지의 ID(숫자)로 적으세요') });
    const pages = collaboratorPages(o);
    if (pages.some((p) => !/^\d+$/.test(p))) issues.push({ severity: 'error', code: 'collaborators', message: msg('Facebook 공동 작업자는 페이지 ID(숫자)로 적으세요') });
    if (pages.length > COLLAB_MAX) issues.push({ severity: 'error', code: 'collaborators', message: msg('Facebook 공동 작업자 초대는 페이지마다 하루 {max}건까지입니다', { max: COLLAB_MAX }) });
    if (pages.length && o.draft) issues.push({ severity: 'warning', code: 'collaborators', message: msg('초안에는 공동 작업자를 초대하지 않습니다 — 게시한 뒤 앱에서 초대하세요') });
    // Meta's docs only describe invitations to a published reel; a natively scheduled one is invited
    // at upload, weeks before it goes live, which is not confirmed to work.
    else if (pages.length && post.scheduledAt) issues.push({ severity: 'warning', code: 'collaborators', message: msg('예약한 릴스는 올릴 때 공동 작업자를 초대합니다 (게시 전 초대가 적용되는지 아직 확인 전)') });
    if (o.draft && post.scheduledAt) {
      issues.push({ severity: 'warning', code: 'draft_schedule', message: msg('Facebook 초안은 예약하지 않습니다. 예약 시각은 무시되고 Meta Business Suite에서 직접 게시합니다') });
    } else if (post.scheduledAt) {
      const delta = new Date(post.scheduledAt).getTime() - Date.now();
      if (delta < SCHEDULE_MIN_MS) {
        issues.push({ severity: 'error', code: 'schedule_window', message: msg('Facebook Reels 예약은 10분 뒤부터 가능합니다') });
      } else if (delta > SCHEDULE_MAX_MS) {
        // createScheduledPost holds the target until the time is within reach (scheduleMaxAheadMs).
        issues.push({ severity: 'warning', code: 'schedule_window', message: msg('Facebook은 29일 안쪽만 예약할 수 있어, 예약 28일 전에 올립니다 (그때 fanout이 켜져 있어야 합니다)') });
      }
    }
    // The thumbnails edge is documented for Page videos; for Reels it is still to be confirmed live.
    if (post.thumbnailPath) issues.push({ severity: 'warning', code: 'thumbnail', message: msg('Facebook 릴스 커버는 처리가 끝난 뒤 썸네일로 바꿉니다 (릴스에서 되는지 아직 확인 전, 안 되면 경고만 남김)') });
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
      // Only a definite "no such video" means it never published: anything else (a 5xx, a rate
      // limit, a dropped connection) is a question unanswered, and starting over could post twice.
      const st = await graph<ReelStatus>(ctx, 'GET', `/${resume.videoId}`, { fields: 'status', access_token: c.pageToken }).catch((err: unknown) => {
        if (err instanceof ProviderError && err.platformCode?.startsWith('100')) return undefined;
        throw err;
      });
      const phases = st?.status;
      const published = phases?.publishing_phase?.status && phases.publishing_phase.status !== 'not_started';
      if (published || (phases?.processing_phase?.status && phases.processing_phase.status !== 'not_started')) {
        saveResume({ videoId: resume.videoId, finished: true, pageId: c.pageId });
        return { state: 'processing', remoteId: resume.videoId, remoteUrl: o.draft ? undefined : `https://www.facebook.com/reel/${resume.videoId}` };
      }
      if (phases?.uploading_phase?.status === 'complete') {
        // Bytes arrived but finish never registered: finish the same video instead of re-uploading.
        await finishReel(ctx, c.pageId, c.pageToken, resume.videoId, post, o);
        saveResume({ videoId: resume.videoId, finished: true, pageId: c.pageId });
        return { state: 'processing', remoteId: resume.videoId, remoteUrl: o.draft ? undefined : `https://www.facebook.com/reel/${resume.videoId}` };
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
    // A draft has no public page yet: no link until someone posts it.
    return { state: 'processing', remoteId: start.video_id, remoteUrl: o.draft ? undefined : `https://www.facebook.com/reel/${start.video_id}` };
  },

  async poll({ ctx, post, target, account }) {
    const c = pageCreds(account);
    const s = await graph<ReelStatus>(ctx, 'GET', `/${target.remoteId}`, { fields: 'status', access_token: c.pageToken });
    const o = target.options as FacebookOptions;
    const out = reelOutcome(target.remoteId, s, o.draft === true);
    const warnings: string[] = [];
    let resume = (target.resume ?? {}) as { coverSent?: boolean; collabSent?: boolean; collabPages?: string[] };
    const mark = (patch: typeof resume) => {
      resume = { ...resume, ...patch };
      ctx.store.updateTarget(target.id, { resume: { ...target.resume, ...resume } });
    };
    // The post's thumbnail as the reel's cover, once it has processed: tried once, a failure only warns.
    if (post.thumbnailPath && !resume.coverSent && s.status?.processing_phase?.status === 'complete' && existsSync(post.thumbnailPath)) {
      mark({ coverSent: true });
      const path = post.thumbnailPath;
      await graphUpload(ctx, `/${target.remoteId}/thumbnails`, { field: 'source', path, type: imageMime(path) }, { is_preferred: 'true', access_token: c.pageToken }).catch((err: unknown) => {
        // A passing failure: try again at the next status check (setting the cover twice is harmless).
        if (err instanceof ProviderError && err.kind === 'retryable') mark({ coverSent: false });
        else warnings.push(msg('Facebook 커버 이미지를 바꾸지 못했습니다: {err} — 페이지에서 직접 바꾸세요', { err: (err as Error).message }));
      });
    }
    // Collaborator invitations once it is live (sent once each; a refusal only warns).
    const pages = collaboratorPages(o);
    const sentTo = new Set(resume.collabPages ?? []);
    if (pages.length && out.state === 'published' && !resume.collabSent) {
      for (const page of pages.filter((p) => !sentTo.has(p))) {
        // Each Page is marked before its invitation, so a crash can't send it twice.
        sentTo.add(page);
        mark({ collabPages: [...sentTo] });
        await graph(ctx, 'POST', `/${target.remoteId}/collaborators`, { target_id: page, access_token: c.pageToken }).catch((err: unknown) => {
          // A passing failure is tried again at the next status check, if there is one.
          if (err instanceof ProviderError && err.kind === 'retryable') {
            sentTo.delete(page);
            mark({ collabPages: [...sentTo] });
          } else warnings.push(msg('Facebook 공동 작업자 {page} 초대 실패: {err}', { page, err: (err as Error).message }));
        });
      }
      if (pages.every((p) => sentTo.has(p))) mark({ collabSent: true });
    }
    return warnings.length ? { ...out, warnings: [...(out.warnings ?? []), ...warnings] } : out;
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
      const page = await graph<{ name?: string }>(ctx, 'GET', `/${c.pageId}`, { fields: 'name', access_token: c.pageToken });
      checks.push({ name: msg('페이지'), status: 'ok', detail: `${page.name} (${c.pageId})` });
    } catch (err) {
      checks.push({ name: msg('페이지'), status: 'fail', detail: (err as Error).message });
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
    const last = ins.transient ? target.stats : undefined;
    // Reach and watch time in a call of their own: a metric this reel lacks can't cost the plays.
    const more = ins.note
      ? undefined
      : await readInsights(ctx, `/${target.remoteId}/video_insights`, { metric: 'post_impressions_unique,post_video_avg_time_watched,post_video_view_time', period: 'lifetime', access_token: c.pageToken }, 'read_insights·pages_manage_engagement');
    const ms = (n?: number) => (n === undefined ? undefined : Math.round(n / 100) / 10);
    // A passing failure of either call keeps that call's last numbers rather than dropping them.
    const keep = ins.transient || more?.transient ? target.stats : undefined;
    // Read until the check has finished; its result is kept after that.
    const copyright = target.stats?.copyright ? { copyright: target.stats.copyright, alerts: target.stats.alerts } : await copyrightCheck(ctx, target.remoteId, c.pageToken);
    return definedOnly({
      views: ins.values.fb_reels_total_plays ?? last?.views,
      likes: v.likes?.summary?.total_count,
      comments: v.comments?.summary?.total_count,
      reach: more?.values.post_impressions_unique ?? keep?.reach,
      avgWatchSec: ms(more?.values.post_video_avg_time_watched) ?? keep?.avgWatchSec,
      watchTimeSec: ms(more?.values.post_video_view_time) ?? keep?.watchTimeSec,
      ...(ins.note ? { note: ins.note } : {}),
      ...copyright,
    });
  },

  // pages_manage_engagement on the Page token; reversible with is_hidden=false.
  async hideComment({ ctx, account, commentId, hidden }) {
    await graph(ctx, 'POST', `/${commentId}`, { is_hidden: hidden, access_token: pageCreds(account).pageToken }).catch((err: unknown) => {
      throw missingScope(err, 'pages_manage_engagement');
    });
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
        throw new ProviderError('rejected', 'facebook.not_found', msg('지우지 못했습니다: 이 페이지 토큰으로는 영상을 찾을 수 없습니다. 페이지에서 직접 확인해 주세요 ({platformCode})', { platformCode: err.platformCode }), err.platformCode);
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

  commentsKnowAnswers: true,

  async comments({ ctx, account, target, limit }) {
    const c = pageCreds(account);
    type Reply = { from?: { id?: string } };
    const res = await graph<{
      data?: Array<{ id: string; message?: string; created_time: string; like_count?: number; comment_count?: number; is_hidden?: boolean; from?: { id?: string; name?: string }; comments?: { data?: Reply[] } }>;
    }>(ctx, 'GET', `/${target.remoteId}/comments`, {
      fields: 'from{id,name},message,created_time,like_count,comment_count,is_hidden,comments.limit(25){from{id}}',
      order: 'reverse_chronological',
      limit: Math.min(limit, 100),
      access_token: c.pageToken,
    });
    return (res.data ?? []).map((m) => {
      const replies = m.comments?.data ?? [];
      const byPage = replies.some((r) => r.from?.id === c.pageId);
      // Up to 25 replies come along: past that, with none from the Page among them, it can't be told.
      const answered = byPage ? { answered: true } : (m.comment_count ?? replies.length) <= replies.length ? { answered: false } : {};
      return { id: m.id, author: m.from?.name ?? '', text: m.message ?? '', at: m.created_time, likes: m.like_count, replies: m.comment_count, hidden: m.is_hidden === true, mine: m.from?.id === c.pageId, ...answered };
    });
  },

  commentRules: { max: 8_000 },

  // As the Page, on the reel (its video id); needs pages_manage_engagement like replies.
  async postComment({ ctx, account, target, text, sending }) {
    const c = pageCreds(account);
    sending();
    const res = await graph<{ id: string }>(ctx, 'POST', `/${target.remoteId}/comments`, { message: text, access_token: c.pageToken }).catch((err: unknown) => {
      throw missingScope(err, 'pages_manage_engagement');
    });
    return { id: res.id };
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
