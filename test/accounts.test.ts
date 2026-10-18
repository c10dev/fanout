import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { disconnectAccount, FORGET_AFTER_MS, VERIFY_EVERY_MS, verifyDueAccounts } from '../src/core/accounts.ts';
import { providerMap } from '../src/providers/index.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const DAY = 86_400_000;

function setup() {
  let now = new Date('2026-10-17T03:00:00Z').getTime();
  const env = makeCtx(undefined, () => new Date(now));
  const { store } = env;
  store.setApp('youtube', { clientId: 'cid', clientSecret: 'cs' });
  const credentials = { accessToken: 'AT', refreshToken: 'RT', expiresAt: now + 3600_000 };
  store.saveAccount({ platform: 'youtube', name: 'main', credentials, profile: { channelId: 'UC1', channelTitle: 'Old title' } });
  const base = { mediaPath: '/x.mp4', title: 'T', description: '', tags: [], captions: [], containsSyntheticMedia: false };
  const { targets } = store.createPost(base, [
    { platform: 'youtube', account: 'main', options: {} },
    { platform: 'mastodon', account: 'main', options: {} },
  ]);
  for (const t of targets) {
    store.saveStats(t.id, { views: 5, fetchedAt: '2026-10-17T00:00:00Z' });
    store.recordStats(t.id, { views: 5, fetchedAt: '2026-10-17T00:00:00Z' });
  }
  const [yt, md] = targets;
  return { ...env, yt: yt!, md: md!, advance: (ms: number) => (now += ms) };
}

const statsOf = (store: ReturnType<typeof setup>['store'], id: string) => ({ latest: store.getTarget(id)!.stats, history: store.statsHistory(id).length });

describe('YouTube account upkeep (Developer Policies III.D.2, III.E.4)', () => {
  it('disconnect revokes the token and deletes the reactions read from YouTube, nothing else', async () => {
    const env = setup();
    const { fetch, calls } = mockFetch([['POST', 'oauth2.googleapis.com/revoke', () => new Response('{}', { status: 200 })]]);
    env.ctx.fetch = fetch;
    assert.deepEqual(await disconnectAccount(env.ctx, providerMap(), 'youtube', 'main'), { revoked: true, forgot: true });
    assert.equal(new URLSearchParams(String(calls[0]!.body)).get('token'), 'RT');
    assert.equal(env.store.getAccount('youtube', 'main'), undefined);
    assert.deepEqual(statsOf(env.store, env.yt.id), { latest: undefined, history: 0 });
    assert.equal(env.store.getTarget(env.yt.id)!.state, 'queued', 'the post record stays');
    assert.deepEqual(statsOf(env.store, env.md.id), { latest: { views: 5, fetchedAt: '2026-10-17T00:00:00Z' }, history: 1 }, 'other platforms keep theirs');
    assert.equal(await disconnectAccount(env.ctx, providerMap(), 'youtube', 'main'), undefined);
  });

  it('a failed revoke still deletes the data and the account; an already revoked token is fine', async () => {
    const env = setup();
    env.ctx.fetch = mockFetch([['POST', '/revoke', () => new Response('down', { status: 503 })]]).fetch;
    assert.deepEqual(await disconnectAccount(env.ctx, providerMap(), 'youtube', 'main'), { revoked: false, forgot: true });
    assert.equal(statsOf(env.store, env.yt.id).history, 0);
    assert.ok(env.logs.some((l) => l.startsWith('WARN youtube/main: 토큰을 철회하지 못했습니다')));

    const again = setup();
    again.ctx.fetch = mockFetch([['POST', '/revoke', () => json({ error: 'invalid_token' }, 400)]]).fetch;
    assert.deepEqual(await disconnectAccount(again.ctx, providerMap(), 'youtube', 'main'), { revoked: true, forgot: true });
    assert.ok(!again.logs.some((l) => l.startsWith('WARN')));
  });

  it('does not revoke a token another account of the same channel still uses', async () => {
    const env = setup();
    env.store.saveAccount({ platform: 'youtube', name: 'alt', credentials: { accessToken: 'A2', refreshToken: 'R2', expiresAt: 0 }, profile: { channelId: 'UC1' } });
    const { fetch, calls } = mockFetch([]);
    env.ctx.fetch = fetch;
    assert.deepEqual(await disconnectAccount(env.ctx, providerMap(), 'youtube', 'main'), { revoked: false, forgot: true });
    assert.equal(calls.length, 0);
    assert.ok(env.store.getAccount('youtube', 'alt'));
  });

  it('verifies each account daily, refreshing the channel title', async () => {
    const env = setup();
    const { fetch, calls } = mockFetch([['GET', '/channels?part=snippet&mine=true', () => json({ items: [{ id: 'UC1', snippet: { title: 'New title' } }] })]]);
    env.ctx.fetch = fetch;
    assert.equal(await verifyDueAccounts(env.ctx, providerMap()), 1);
    assert.deepEqual(env.store.getAccount('youtube', 'main')!.profile, { channelId: 'UC1', channelTitle: 'New title' });
    assert.equal(await verifyDueAccounts(env.ctx, providerMap()), 0, 'not again the same day');
    env.advance(VERIFY_EVERY_MS);
    // The access token has expired by now: verifying refreshes it first and keeps the upkeep marks.
    env.ctx.fetch = mockFetch([
      ['POST', 'oauth2.googleapis.com/token', () => json({ access_token: 'AT2', expires_in: 3600 })],
      ['GET', '/channels', () => json({ items: [{ id: 'UC1', snippet: { title: 'New title' } }] })],
    ]).fetch;
    assert.equal(await verifyDueAccounts(env.ctx, providerMap()), 1);
    const creds = env.store.getAccount('youtube', 'main')!.credentials as Record<string, unknown>;
    assert.equal(creds.accessToken, 'AT2');
    assert.equal(creds.refreshToken, 'RT');
    assert.equal(calls.length, 1);
  });

  it('deletes the data only after access has been refused for three weeks, and a reconnect resets it', async () => {
    const env = setup();
    env.advance(2 * 3600_000); // the access token has expired
    const refused = mockFetch([['POST', 'oauth2.googleapis.com/token', () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)]]).fetch;
    env.ctx.fetch = refused;
    await verifyDueAccounts(env.ctx, providerMap());
    assert.equal(statsOf(env.store, env.yt.id).history, 1, 'not on the first refusal (a Testing consent screen looks the same)');
    for (let day = 1; day * DAY < FORGET_AFTER_MS; day++) {
      env.advance(DAY);
      await verifyDueAccounts(env.ctx, providerMap());
    }
    assert.equal(statsOf(env.store, env.yt.id).history, 1);
    env.advance(DAY);
    await verifyDueAccounts(env.ctx, providerMap());
    assert.deepEqual(statsOf(env.store, env.yt.id), { latest: undefined, history: 0 });
    assert.deepEqual(env.store.getAccount('youtube', 'main')!.profile, {}, 'the channel title goes too; the account stays to reconnect');
    assert.equal(statsOf(env.store, env.md.id).history, 1);
    assert.ok(env.logs.some((l) => l.includes('21일 넘게 접근이 거부돼')));

    // Access comes back (reconnected with a fresh token): the refusal is cleared.
    env.advance(DAY);
    const acct = env.store.getAccount('youtube', 'main')!;
    env.store.saveAccount({ ...acct, credentials: { ...acct.credentials, accessToken: 'AT9', expiresAt: env.ctx.now().getTime() + 3600_000 } });
    env.ctx.fetch = mockFetch([['GET', '/channels', () => json({ items: [{ id: 'UC1', snippet: { title: 'Back' } }] })]]).fetch;
    await verifyDueAccounts(env.ctx, providerMap());
    const after = env.store.getAccount('youtube', 'main')!;
    assert.equal((after.credentials as Record<string, unknown>).authFailedAt, undefined);
    assert.equal(after.profile.channelTitle, 'Back');
  });

  it('leaves network and quota errors for the next round', async () => {
    const env = setup();
    env.ctx.fetch = mockFetch([['GET', '/channels', () => json({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, 403)]]).fetch;
    await verifyDueAccounts(env.ctx, providerMap());
    const creds = env.store.getAccount('youtube', 'main')!.credentials as Record<string, unknown>;
    assert.equal(creds.authFailedAt, undefined);
    assert.equal(creds.nextCheckAt, env.ctx.now().getTime() + 3 * 3600_000, 'tried again a few hours later, not every round');
    assert.equal(await verifyDueAccounts(env.ctx, providerMap()), 0);
  });

  it('never starts the deletion clock for fanout setup problems', async () => {
    const env = setup();
    env.advance(2 * 3600_000);
    env.ctx.fetch = mockFetch([['POST', 'oauth2.googleapis.com/token', () => json({ error: 'invalid_client', error_description: 'The OAuth client was not found.' }, 401)]]).fetch;
    await verifyDueAccounts(env.ctx, providerMap());
    env.store.setApp('youtube', {});
    env.advance(4 * 3600_000);
    await verifyDueAccounts(env.ctx, providerMap());
    const creds = env.store.getAccount('youtube', 'main')!.credentials as Record<string, unknown>;
    assert.equal(creds.authFailedAt, undefined);
    assert.equal(env.logs.filter((l) => l.startsWith('WARN verify(youtube/main)')).length, 2);
  });

  it('says so at the first refusal', async () => {
    const env = setup();
    env.advance(2 * 3600_000);
    env.ctx.fetch = mockFetch([['POST', 'oauth2.googleapis.com/token', () => json({ error: 'invalid_grant' }, 400)]]).fetch;
    await verifyDueAccounts(env.ctx, providerMap());
    assert.ok(env.logs.some((l) => l.startsWith('WARN youtube/main: 접근이 거부됐습니다') && l.includes('21일 안에')));
  });

  it('a check still running when the account is removed or reconnected changes nothing', async () => {
    for (const change of ['remove', 'reconnect'] as const) {
      const env = setup();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      env.ctx.fetch = mockFetch([['GET', '/channels', async () => (await gate, json({ items: [{ id: 'UC1', snippet: { title: 'Stale' } }] }))]]).fetch;
      const running = verifyDueAccounts(env.ctx, providerMap());
      await new Promise((r) => setImmediate(r));
      const fresh = { platform: 'youtube', name: 'main', credentials: { accessToken: 'NEW', refreshToken: 'RT_NEW', expiresAt: 0 }, profile: { channelId: 'UC2', channelTitle: 'Other' } };
      if (change === 'remove') env.store.removeAccount('youtube', 'main');
      else env.store.saveAccount(fresh);
      release();
      await running;
      assert.deepEqual(env.store.getAccount('youtube', 'main'), change === 'remove' ? undefined : fresh, change);
    }
  });
});
