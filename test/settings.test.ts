import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { providerMap } from '../src/providers/index.ts';
import { Dashboard } from '../src/server/server.ts';
import { json, makeCtx, mockFetch } from './helpers.ts';

const TOKEN = 'settings-token';
const auth = { 'x-fanout-token': TOKEN, 'content-type': 'application/json' };

describe('dashboard settings', () => {
  // Platform calls go through ctx.fetch (mocked); the test talks to the dashboard with the real fetch.
  const platform = mockFetch([
    ['POST', 'oauth2.googleapis.com/token', () => json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })],
    ['GET', 'youtube/v3/channels', () => json({ items: [{ id: 'UC1', snippet: { title: '내 채널' }, status: {} }] })],
    ['GET', '/oauth/access_token', () => json({ access_token: 'LONG' })],
    ['POST', 'com.atproto.server.createSession', () => json({ did: 'did:plc:x', handle: 'me.bsky.social', accessJwt: 'A', refreshJwt: 'R' })],
    ['GET', '/me/accounts', () => json({ data: [{ id: 'PAGE1', name: '내 페이지', access_token: 'PAGE-TOKEN', instagram_business_account: { id: 'IG1', username: 'me.reels' } }] })],
  ]);
  const env = makeCtx(platform.fetch, () => new Date());
  const dashboard = new Dashboard({ ctx: env.ctx, providers: providerMap(), port: 0, token: TOKEN, workerIntervalMs: 60_000 });
  let base = '';

  before(async () => {
    base = (await dashboard.start()).replace(/\/$/, '');
  });
  after(async () => {
    await dashboard.stop();
    env.store.close();
  });

  const put = (key: string, body: unknown) => fetch(`${base}/api/apps/${key}`, { method: 'PUT', headers: auth, body: JSON.stringify(body) });

  it('saves app credentials without ever returning secrets', async () => {
    assert.equal((await put('youtube', { values: { clientId: 'cid' } })).status, 400, 'secret still missing');
    assert.equal((await put('youtube', { values: { clientId: 'cid', clientSecret: 'TOP-SECRET' } })).status, 200);
    // An empty secret keeps the stored one.
    assert.equal((await put('youtube', { values: { clientId: 'cid2', clientSecret: '' } })).status, 200);
    assert.deepEqual(env.store.getApp('youtube'), { clientId: 'cid2', clientSecret: 'TOP-SECRET' });

    const res = await fetch(`${base}/api/settings`, { headers: auth });
    const text = await res.text();
    assert.ok(!text.includes('TOP-SECRET'));
    const body = JSON.parse(text) as { apps: Array<{ key: string; platforms: string[]; fields: Array<{ key: string; set: boolean; value?: string }> }> };
    const yt = body.apps.find((a) => a.key === 'youtube')!;
    assert.deepEqual(
      yt.fields.map((f) => [f.key, f.set, f.value]),
      [
        ['clientId', true, 'cid2'],
        ['clientSecret', true, undefined],
      ],
    );
    assert.deepEqual(body.apps.find((a) => a.key === 'meta')?.platforms, ['instagram', 'facebook']);
  });

  it('accepts a Google desktop-client JSON file and rejects a web client', async () => {
    const web = JSON.stringify({ web: { client_id: 'w', client_secret: 's' } });
    assert.equal((await put('youtube', { clientJson: web })).status, 400);
    const installed = JSON.stringify({ installed: { client_id: 'desk-id', client_secret: 'desk-secret' } });
    assert.equal((await put('youtube', { clientJson: installed })).status, 200);
    assert.equal(env.store.getApp<{ clientId: string }>('youtube')?.clientId, 'desk-id');
  });

  it('connects YouTube through the dashboard OAuth callback', async () => {
    const start = (await (await fetch(`${base}/api/connect/youtube`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'main' }) })).json()) as {
      authorizeUrl: string;
    };
    const authorize = new URL(start.authorizeUrl);
    assert.equal(authorize.searchParams.get('redirect_uri'), `${base}/oauth/youtube/callback`);
    const state = authorize.searchParams.get('state')!;

    const bad = await fetch(`${base}/oauth/youtube/callback?state=forged&code=x`, { redirect: 'manual', headers: { 'accept-language': 'ko-KR,ko' } });
    assert.equal(bad.status, 303);
    assert.match(new URL(bad.headers.get('location')!, base).searchParams.get('oauthError')!, /연결 요청이 만료됐거나/);
    // Without a pending request to say which language the connect started in, the browser's decides.
    const badEn = await fetch(`${base}/oauth/youtube/callback?state=forged&code=x`, { redirect: 'manual', headers: { 'accept-language': 'en-US,en' } });
    assert.match(new URL(badEn.headers.get('location')!, base).searchParams.get('oauthError')!, /^The connection request expired or is invalid/);

    const ok = await fetch(`${base}/oauth/youtube/callback?state=${state}&code=CODE`, { redirect: 'manual' });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/?view=settings&connected=youtube%2Fmain');
    assert.equal(env.store.getAccount('youtube', 'main')?.profile.channelTitle, '내 채널');
    const tokenCall = platform.calls.find((c) => c.url.includes('oauth2.googleapis.com/token'))!;
    assert.equal(new URLSearchParams(String(tokenCall.body)).get('redirect_uri'), `${base}/oauth/youtube/callback`);

    const replay = await fetch(`${base}/oauth/youtube/callback?state=${state}&code=CODE`, { redirect: 'manual' });
    assert.match(replay.headers.get('location')!, /oauthError=/, 'state is single-use');
  });

  it('connects Instagram with a pasted token and disconnects it', async () => {
    assert.equal((await put('meta', { values: { appId: 'app', appSecret: 'sec' } })).status, 200);
    const res = await fetch(`${base}/api/connect/instagram`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'main', token: 'SHORT' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { account: unknown }).account, { name: 'main', label: '@me.reels' });
    assert.equal(env.store.getAccount<{ pageToken: string }>('instagram', 'main')?.credentials.pageToken, 'PAGE-TOKEN');

    assert.equal((await fetch(`${base}/api/accounts/instagram/main`, { method: 'DELETE', headers: auth })).status, 200);
    assert.equal(env.store.getAccount('instagram', 'main'), undefined);
  });

  it('connects Bluesky with its own fields and no developer app', async () => {
    const settings = (await (await fetch(`${base}/api/settings`, { headers: auth })).json()) as {
      platforms: Array<{ id: string; appConfigured: boolean; connectFields?: Array<{ key: string }> }>;
    };
    const bsky = settings.platforms.find((p) => p.id === 'bluesky')!;
    assert.equal(bsky.appConfigured, true);
    assert.deepEqual(bsky.connectFields?.map((f) => f.key), ['handle', 'token', 'service']);
    const missing = await fetch(`${base}/api/connect/bluesky`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'main', token: 'pw' }) });
    assert.equal(missing.status, 400);
    const res = await fetch(`${base}/api/connect/bluesky`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'main', handle: 'me.bsky.social', token: 'pw' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { account: unknown }).account, { name: 'main', label: '@me.bsky.social' });
  });

  it('manages the webhook without ever returning its URL', async () => {
    const get = async () => (await (await fetch(`${base}/api/notify`, { headers: auth })).json()) as { configured: boolean; host?: string; format?: string; events: string[] };
    assert.equal((await get()).configured, false);
    const put = (body: unknown) => fetch(`${base}/api/notify`, { method: 'PUT', headers: auth, body: JSON.stringify(body) });
    assert.equal((await put({ url: 'http://insecure.example/x', events: ['failed'] })).status, 400);
    assert.equal((await put({ url: 'https://hooks.slack.com/services/T/B/SECRET', events: [] })).status, 400);
    assert.equal((await put({ url: 'https://hooks.slack.com/services/T/B/SECRET', events: ['failed', 'bogus'] })).status, 200);
    const text = await (await fetch(`${base}/api/notify`, { headers: auth })).text();
    assert.ok(!text.includes('SECRET'));
    assert.deepEqual(JSON.parse(text), { configured: true, host: 'hooks.slack.com', detectedFormat: 'slack', events: ['failed'], fromEnv: false });
    assert.equal((await put({ url: 'https://hooks example.com/x', events: ['failed'] })).status, 400, 'unparseable URL refused');
    // Keeping the saved URL while changing events.
    assert.equal((await put({ events: ['published', 'failed'] })).status, 200);
    assert.deepEqual((await get()).events, ['published', 'failed']);
    assert.equal((await fetch(`${base}/api/notify`, { method: 'DELETE', headers: auth })).status, 200);
    assert.equal((await get()).configured, false);
  });

  it('validates account names and pasted tokens', async () => {
    const post = (platform: string, body: unknown) => fetch(`${base}/api/connect/${platform}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    assert.equal((await post('instagram', { name: '../x', token: 't' })).status, 400);
    assert.equal((await post('facebook', { name: 'main' })).status, 400);
  });

  it('runs doctor for a connected account', async () => {
    const res = await fetch(`${base}/api/doctor/youtube`, { method: 'POST', headers: auth, body: JSON.stringify({ account: 'main', live: false }) });
    const { checks } = (await res.json()) as { checks: Array<{ name: string; status: string }> };
    assert.ok(checks.some((c) => c.name === '채널' && c.status === 'ok'));
    assert.ok(checks.some((c) => c.name === '미검증 프로젝트 공개 업로드' && c.status === 'info'));
  });
});

describe('dashboard settings on a non-local dashboard', () => {
  it('treats an assumed-local container bind as local', async () => {
    const env = makeCtx();
    const d = new Dashboard({ ctx: env.ctx, providers: providerMap(), host: '0.0.0.0', assumeLocal: true, port: 0, workerIntervalMs: 60_000, pruneDays: null });
    const url = await d.start();
    const port = new URL(url).port;
    try {
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      assert.ok(html.includes(`content="${d.token}"`));
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/settings`, { headers: { 'x-fanout-token': d.token } })).status, 200);
    } finally {
      await d.stop();
      env.store.close();
    }
  });

  it('refuses settings when reachable through other hosts', async () => {
    const env = makeCtx();
    const d = new Dashboard({ ctx: env.ctx, providers: providerMap(), port: 0, token: TOKEN, allowedHosts: ['fanout.example:443'], workerIntervalMs: 60_000 });
    const base = (await d.start()).replace(/\/$/, '');
    try {
      assert.equal((await fetch(`${base}/api/settings`, { headers: auth })).status, 403);
      assert.equal((await fetch(`${base}/api/apps/youtube`, { method: 'PUT', headers: auth, body: '{}' })).status, 403);
      const overview = (await (await fetch(`${base}/api/overview`, { headers: auth })).json()) as { settingsEnabled: boolean };
      assert.equal(overview.settingsEnabled, false);
    } finally {
      await d.stop();
      env.store.close();
    }
  });
});
