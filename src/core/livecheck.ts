import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretBox } from './crypto.ts';
import { sleep } from './http.ts';
import { makeTestClip, probe } from './media.ts';
import type { DoctorCheck, Provider, ProviderContext, PublishOutcome } from './provider.ts';
import { Store, type Account } from './store.ts';

export interface LiveCheckOptions {
  /** Target options for a post nobody else can see (private, direct, …). */
  options: Record<string, unknown>;
  /** How long to wait for the platform to finish processing. */
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * `doctor --live` for providers without a special probe: post a 4-second test clip through the
 * provider's own publish → poll → remove path, as the user's account, then delete it. The post lives
 * in a throwaway in-memory database so it never shows up in fanout's history; tokens the provider
 * refreshes on the way are copied back to the real store.
 */
export async function liveRoundTrip(ctx: ProviderContext, provider: Provider, account: Account, opts: LiveCheckOptions): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const clip = join(tmpdir(), `fanout-doctor-${provider.id}-${Date.now()}.mp4`);
  const scratch = new Store(':memory:', new SecretBox(randomBytes(32)), ctx.now);
  const sctx: ProviderContext = { ...ctx, store: scratch };
  scratch.saveAccount(account);
  let remoteId: string | undefined;
  let removed = false;
  let url: string | undefined;
  try {
    await makeTestClip(clip);
    const media = await probe(clip);
    const { post, targets } = scratch.createPost(
      {
        mediaPath: clip,
        title: 'fanout doctor test (자동 삭제)',
        description: 'fanout doctor --live 가 업로드 동작을 확인하려고 올린 테스트 영상입니다.',
        tags: [],
        captions: [],
        containsSyntheticMedia: false,
      },
      [{ platform: provider.id, account: account.name, options: opts.options }],
    );
    const id = targets[0]!.id;
    const current = () => scratch.getTarget(id)!;
    const acct = () => scratch.getAccount(provider.id, account.name) ?? account;
    scratch.transition(id, 'uploading');
    let out: PublishOutcome = await provider.publish({ ctx: sctx, post, target: current(), account: acct(), mediaPath: clip, media, saveResume: (r) => scratch.updateTarget(id, { resume: r }) });
    remoteId = out.remoteId;
    url = out.remoteUrl;
    checks.push({ name: '테스트 업로드', status: 'ok', detail: `올림 (${out.remoteUrl ?? out.remoteId})` });
    scratch.transition(id, 'processing', { remoteId: out.remoteId, remoteUrl: out.remoteUrl });
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
    while (out.state === 'processing' && Date.now() < deadline) {
      await sleep(opts.pollMs ?? 5_000);
      const t = current();
      out = await provider.poll({ ctx: sctx, post, target: { ...t, remoteId: t.remoteId ?? out.remoteId }, account: acct() });
      remoteId = out.remoteId;
      url = out.remoteUrl ?? url;
      if (out.remoteId !== t.remoteId) scratch.updateTarget(id, { remoteId: out.remoteId, remoteUrl: out.remoteUrl });
    }
    checks.push(
      out.state === 'published'
        ? { name: '처리·게시', status: 'ok', detail: `게시됨 ${url ?? ''}`.trim() }
        : { name: '처리·게시', status: 'warn', detail: `제한 시간 안에 처리가 끝나지 않았습니다 (${out.state})` },
    );
    if (out.state === 'published' && provider.remove) {
      scratch.transition(id, 'published', { remoteId: out.remoteId, remoteUrl: out.remoteUrl });
      const t = current();
      await provider.remove({ ctx: sctx, account: acct(), target: { ...t, remoteId: out.remoteId } });
      removed = true;
      checks.push({ name: '테스트 게시물 삭제', status: 'ok', detail: '삭제함' });
    }
  } catch (err) {
    checks.push({ name: remoteId ? '처리·게시' : '테스트 업로드', status: 'fail', detail: err instanceof Error ? err.message : String(err) });
  } finally {
    if (remoteId && !removed) {
      checks.push({ name: '테스트 게시물 삭제', status: 'warn', detail: `지우지 못했습니다. 직접 지워 주세요: ${url ?? remoteId}` });
    }
    // A token refreshed (and the old one revoked) during the check must not be lost.
    const after = scratch.getAccount(provider.id, account.name);
    if (after && JSON.stringify(after.credentials) !== JSON.stringify(account.credentials)) ctx.store.saveAccount(after);
    scratch.close();
    rmSync(clip, { force: true });
  }
  return checks;
}
