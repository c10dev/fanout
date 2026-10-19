import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import { parseArgs, targetOptions } from '../src/cli.ts';
import type { Account } from '../src/core/store.ts';
import type { Post, Target } from '../src/core/types.ts';
import { CHUNK_SIZE, DAILY_UNITS, buildMetadata, insertParts, nextOffset, pacificDay, postUnits, unitCost, youtube } from '../src/providers/youtube.ts';
import { fakeMedia, json, makeCtx, mockFetch, tempFile } from './helpers.ts';

const NOW = new Date('2026-10-17T03:00:00Z');

function post(overrides: Partial<Post> = {}): Post {
  return {
    id: 'p1',
    createdAt: NOW.toISOString(),
    mediaPath: '/v.mp4',
    title: '테스트 영상',
    description: '설명',
    tags: ['a', 'b'],
    captions: [],
    containsSyntheticMedia: true,
    ...overrides,
  };
}

function target(options: Record<string, unknown>, resume?: Record<string, unknown>): Target {
  return { id: 't1', postId: 'p1', platform: 'youtube', account: 'main', options, state: 'uploading', warnings: [], attempts: 1, updatedAt: NOW.toISOString(), resume };
}

const account: Account = {
  platform: 'youtube',
  name: 'main',
  credentials: { accessToken: 'AT', refreshToken: 'RT', expiresAt: NOW.getTime() + 3600_000 },
  profile: { channelTitle: 'Ch' },
};

describe('youtube quota units', () => {
  const A = 'https://www.googleapis.com/youtube/v3';
  const U = 'https://www.googleapis.com/upload/youtube/v3';
  it('prices each call as Google does', () => {
    assert.equal(unitCost('GET', `${A}/videos?part=status&id=V`), 1);
    assert.equal(unitCost('PUT', `${A}/videos?part=snippet`), 50);
    assert.equal(unitCost('DELETE', `${A}/videos?id=V`), 50);
    assert.equal(unitCost('POST', `${U}/videos?uploadType=resumable&part=snippet,status`), 1);
    assert.equal(unitCost('PUT', `${U}/videos?uploadType=resumable&upload_id=abc`), 0, 'upload chunks are free');
    assert.equal(unitCost('POST', `${U}/captions?uploadType=multipart&part=snippet`), 400);
    assert.equal(unitCost('POST', `${U}/thumbnails/set?videoId=V&uploadType=media`), 50);
    assert.equal(unitCost('POST', `${A}/playlistItems?part=snippet`), 50);
    assert.equal(unitCost('POST', 'https://oauth2.googleapis.com/token'), 0);
    assert.equal(postUnits({ captions: [{ language: 'ko', path: '/a' }, { language: 'en', path: '/b' }], thumbnailPath: '/t.jpg' }, { playlistId: 'PL' }), 1 + 800 + 50 + 50 + 10);
  });

  it('counts what fanout spends and warns before a post would run out', async () => {
    const { fetch } = mockFetch([['GET', '/playlists', () => json({ items: [] })]]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('youtube', { clientId: 'cid', clientSecret: 'cs' });
    const account = { platform: 'youtube', name: 'main', credentials: { accessToken: 'AT', refreshToken: 'RT', expiresAt: ctx.now().getTime() + 3600_000 }, profile: {} };
    await youtube.listPlaylists!({ ctx, account });
    const units = (await youtube.limits!({ ctx, account }))[1]!;
    assert.deepEqual([units.used, units.total], [1, DAILY_UNITS]);

    store.bumpUsage('youtube', 'units', pacificDay(ctx.now()), DAILY_UNITS - 500);
    const withCaption = post({ captions: [{ language: 'en', path: '/en.srt' }, { language: 'ja', path: '/ja.srt' }] });
    const issues = await youtube.previewChecks!({ ctx, account, post: withCaption, target: target({ privacy: 'public', madeForKids: false }), media: fakeMedia() });
    assert.deepEqual(issues.map((i) => i.code), ['quota_units']);
    assert.deepEqual(await youtube.previewChecks!({ ctx, account, post: post({}), target: target({ privacy: 'public', madeForKids: false }), media: fakeMedia() }), []);
  });
});

describe('youtube metadata', () => {
  it('lists the account\'s playlists to pick from', async () => {
    const { fetch, calls } = mockFetch([['GET', '/playlists?part=snippet&mine=true', () => json({ items: [{ id: 'PL1', snippet: { title: '가사 영상' } }, { id: 'PL2' }] })]]);
    const { ctx, store } = makeCtx(fetch);
    store.setApp('youtube', { clientId: 'cid', clientSecret: 'cs' });
    const account = { platform: 'youtube', name: 'main', credentials: { accessToken: 'AT', refreshToken: 'RT', expiresAt: ctx.now().getTime() + 3600_000 }, profile: {} };
    assert.deepEqual(await youtube.listPlaylists!({ ctx, account }), [{ id: 'PL1', title: '가사 영상' }, { id: 'PL2', title: 'PL2' }]);
    assert.equal(calls.length, 1);
  });

  it('sends license, embedding, stats visibility and other-language titles', () => {
    const opts = {
      privacy: 'public' as const,
      madeForKids: false,
      defaultLanguage: 'ko',
      license: 'creativeCommon' as const,
      embeddable: false,
      publicStatsViewable: false,
      localizations: { en: { title: 'Ditto lyrics', description: 'English' } },
    };
    const m = buildMetadata(post({}), opts) as Record<string, Record<string, unknown>>;
    assert.deepEqual([m.status!.license, m.status!.embeddable, m.status!.publicStatsViewable], ['creativeCommon', false, false]);
    assert.deepEqual(m.localizations, { en: { title: 'Ditto lyrics', description: 'English' } });
    assert.equal(insertParts(opts), 'snippet,status,localizations');
    // Defaults stay out of the request entirely.
    const plain = buildMetadata(post({}), { privacy: 'public', madeForKids: false }) as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(plain), ['snippet', 'status']);
    assert.equal(insertParts({ privacy: 'public', madeForKids: false }), 'snippet,status');
  });

  it('checks other-language titles need a default language and fit the limits', () => {
    const codes = (o: Record<string, unknown>) => youtube.validate(post({}), target({ privacy: 'public', madeForKids: false, ...o }), fakeMedia()).map((i) => i.code);
    assert.ok(codes({ localizations: { en: { title: 'Hi' } } }).includes('localizations'), 'no defaultLanguage');
    assert.ok(!codes({ defaultLanguage: 'ko', localizations: { en: { title: 'Hi' } } }).includes('localizations'));
    assert.ok(codes({ defaultLanguage: 'ko', localizations: { en: { title: 'x'.repeat(101) } } }).includes('localizations'));
    assert.ok(codes({ license: 'cc0' }).includes('license'));
    assert.ok(codes({ paidPromotion: true }).includes('unsettable'), 'options YouTube can\'t take are reported, not dropped quietly');
    // Malformed shapes (MCP, a watch-folder JSON) are issues, not crashes.
    for (const bad of [{ en: null }, { en: { title: 5 } }, { en: { title: 'x', description: 5 } }, 'en:Hi', ['x']]) {
      assert.ok(codes({ defaultLanguage: 'ko', localizations: bad }).includes('localizations'), JSON.stringify(bad));
    }
  });

  it('maps the post and discloses synthetic media', () => {
    const m = buildMetadata(post(), { privacy: 'unlisted', madeForKids: false });
    assert.deepEqual(m, {
      snippet: { title: '테스트 영상', description: '설명', tags: ['a', 'b'], categoryId: '22' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
    });
  });

  it('uploads scheduled posts as private with publishAt', () => {
    // buildMetadata compares with the real clock: the time must really be ahead.
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const m = buildMetadata(post({ scheduledAt: at }), { privacy: 'public', madeForKids: false }) as {
      status: Record<string, unknown>;
    };
    assert.equal(m.status.privacyStatus, 'private');
    assert.equal(m.status.publishAt, at);
  });

  it('parses resumable Range headers', () => {
    assert.equal(nextOffset('bytes=0-524287'), 524288);
    assert.equal(nextOffset(null), 0);
  });

  it('resets the quota day at Pacific midnight', () => {
    assert.equal(pacificDay(new Date('2026-10-17T06:59:00Z')), '2026-10-16');
    assert.equal(pacificDay(new Date('2026-10-17T07:01:00Z')), '2026-10-17');
  });
});

describe('youtube validate', () => {
  it('insists on explicit privacy and made-for-kids', () => {
    const codes = youtube.validate(post(), target({}), fakeMedia()).map((i) => i.code);
    assert.ok(codes.includes('privacy'));
    assert.ok(codes.includes('made_for_kids'));
  });

  it('flags Shorts classification and title limits', () => {
    const issues = youtube.validate(post({ title: 'x'.repeat(101) }), target({ privacy: 'public', madeForKids: false }), fakeMedia({ durationSec: 60 }));
    assert.ok(issues.some((i) => i.code === 'shorts' && i.severity === 'warning'));
    assert.ok(issues.some((i) => i.code === 'title' && i.severity === 'error'));
  });
});

describe('youtube resumable upload', () => {
  it('starts a session, uploads in chunks and records usage', async () => {
    const size = CHUNK_SIZE + 1000;
    const file = tempFile(size);
    const { fetch, calls } = mockFetch([
      ['POST', '/upload/youtube/v3/videos?', () => new Response(null, { status: 200, headers: { location: 'https://upload.example/session1' } })],
      [
        'PUT',
        'session1',
        (c) =>
          c.headers['content-range']!.startsWith('bytes 0-')
            ? new Response(null, { status: 308, headers: { range: `bytes=0-${CHUNK_SIZE - 1}` } })
            : json({ id: 'VID1', status: { uploadStatus: 'uploaded', privacyStatus: 'public' } }, 201),
      ],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('youtube', { clientId: 'cid', clientSecret: 'cs' });
    const saved: Array<Record<string, unknown>> = [];
    const out = await youtube.publish({
      ctx,
      post: post({ mediaPath: file }),
      target: target({ privacy: 'public', madeForKids: false }),
      account,
      mediaPath: file,
      media: fakeMedia({ durationSec: 600 }, { width: 1920, height: 1080 }),
      saveResume: (r) => saved.push(r),
    });

    assert.equal(out.state, 'processing');
    assert.equal(out.remoteId, 'VID1');
    assert.equal(out.remoteUrl, 'https://youtu.be/VID1');
    const init = calls[0]!;
    assert.equal(init.headers['x-upload-content-length'], String(size));
    assert.equal((JSON.parse(String(init.body)) as { status: { privacyStatus: string } }).status.privacyStatus, 'public');
    const puts = calls.filter((c) => c.method === 'PUT');
    assert.deepEqual(
      puts.map((c) => c.headers['content-range']),
      [`bytes 0-${CHUNK_SIZE - 1}/${size}`, `bytes ${CHUNK_SIZE}-${size - 1}/${size}`],
    );
    assert.equal(saved[0]!.sessionUri, 'https://upload.example/session1');
    assert.equal(store.getUsage('youtube', 'project', '2026-10-16'), 1);
  });

  it('resumes an interrupted session from the stored offset', async () => {
    const size = 5000;
    const file = tempFile(size);
    const { fetch, calls } = mockFetch([
      [
        'PUT',
        'session9',
        (c) =>
          c.headers['content-range'] === `bytes */${size}`
            ? new Response(null, { status: 308, headers: { range: 'bytes=0-1999' } })
            : json({ id: 'VID9', status: { uploadStatus: 'uploaded', privacyStatus: 'unlisted' } }, 200),
      ],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('youtube', { clientId: 'cid', clientSecret: 'cs' });
    const out = await youtube.publish({
      ctx,
      post: post({ mediaPath: file }),
      target: target({ privacy: 'unlisted', madeForKids: false }, { sessionUri: 'https://upload.example/session9', size }),
      account,
      mediaPath: file,
      media: fakeMedia(),
      saveResume: () => {},
    });
    assert.equal(out.remoteId, 'VID9');
    assert.equal(calls[1]!.headers['content-range'], `bytes 2000-4999/${size}`);
    assert.equal(calls.some((c) => c.method === 'POST'), false, 'must not start a new session');
    assert.equal(store.getUsage('youtube', 'project', '2026-10-16'), 0);
  });

  it('turns quotaExceeded into a non-retryable quota error', async () => {
    const file = tempFile(100);
    const { fetch } = mockFetch([
      ['POST', '/upload/youtube/v3/videos?', () => json({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, 403)],
    ]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('youtube', { clientId: 'cid', clientSecret: 'cs' });
    await assert.rejects(
      youtube.publish({ ctx, post: post(), target: target({ privacy: 'public', madeForKids: false }), account, mediaPath: file, media: fakeMedia(), saveResume: () => {} }),
      (err: ProviderError) => err.kind === 'rejected' && err.code === 'youtube.quota' && err.platformCode === 'quotaExceeded' && /T0[78]:05:00\.000Z$/.test(err.retryAt ?? ''),
    );
  });

  it('warns when a requested public upload comes back locked private', async () => {
    const { fetch } = mockFetch([
      ['GET', '/youtube/v3/videos?part=status', () => json({ items: [{ id: 'V', status: { uploadStatus: 'processed', privacyStatus: 'private' } }] })],
    ]);
    const { ctx } = makeCtx(fetch, () => NOW);
    const out = await youtube.poll({ ctx, post: post(), target: { ...target({ privacy: 'public', madeForKids: false }), remoteId: 'V' }, account });
    assert.equal(out.state, 'published');
    assert.ok(out.warnings?.some((w) => w.startsWith('forced_private')));
  });

  it('explains the 7-day Testing-mode trap on invalid_grant', async () => {
    const { fetch } = mockFetch([['POST', 'oauth2.googleapis.com/token', () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)]]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('youtube', { clientId: 'cid', clientSecret: 'cs' });
    const expired = { ...account, credentials: { ...account.credentials, expiresAt: 0 } };
    await assert.rejects(youtube.refresh(ctx, expired), (err: ProviderError) => err.kind === 'auth' && /Testing/.test(err.message));
  });

  it('records the granted scopes on refresh, and asks for Analytics when connecting', async () => {
    const { fetch } = mockFetch([['POST', 'oauth2.googleapis.com/token', () => json({ access_token: 'N', expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube.force-ssl' })]]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('youtube', { clientId: 'cid', clientSecret: 'cs' });
    const next = await youtube.refresh(ctx, { ...account, credentials: { ...account.credentials, expiresAt: 0 } });
    assert.equal((next.credentials as { scope?: string }).scope, 'https://www.googleapis.com/auth/youtube.force-ssl');
    const scope = new URL(youtube.oauthBegin!(ctx, 'http://127.0.0.1:1/cb').url).searchParams.get('scope')!;
    assert.deepEqual(scope.split(' '), ['https://www.googleapis.com/auth/youtube.force-ssl', 'https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly']);
  });

  it('refuses a connect where the manage scope was unticked', async () => {
    const { fetch } = mockFetch([['POST', 'oauth2.googleapis.com/token', () => json({ access_token: 'N', refresh_token: 'R', expires_in: 3600, scope: 'https://www.googleapis.com/auth/yt-analytics.readonly' })]]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('youtube', { clientId: 'cid', clientSecret: 'cs' });
    await assert.rejects(youtube.oauthFinish!(ctx, 'main', new URLSearchParams('code=C'), 'http://127.0.0.1:1/cb', 'v'), (e: ProviderError) => e.code === 'youtube.partial_grant');
  });
});

describe('youtube chapters and recording date', () => {
  it('says when description timestamps will not make chapters', async () => {
    const { chapterProblems } = await import('../src/providers/youtube.ts');
    assert.deepEqual(chapterProblems('no stamps here'), []);
    assert.deepEqual(chapterProblems('0:00 Intro\n0:45 Verse\n1:30 Chorus\n(12:05) Outro'), []);
    assert.equal(chapterProblems('0:10 Intro\n0:45 a\n1:30 b').length, 1, 'first not 0:00');
    assert.equal(chapterProblems('0:00 Intro\n0:45 a').length, 1, 'fewer than 3');
    assert.match(chapterProblems('0:00 a\n0:05 b\n1:00 c')[0]!, /10/);
    assert.match(chapterProblems('0:00 a\n1:00 b\n0:30 c')[0]!, /커져야/);
    assert.deepEqual(chapterProblems('0:00 a\n1:02:03 b\n1:05:00 c'), [], 'hours too');
    assert.deepEqual(chapterProblems('19:30 입장\n20:00 공연\n22:00 종료'), [], 'times of day are not chapters');
    assert.deepEqual(chapterProblems('Intro 0:00\nVerse - 0:45\nChorus (1:30)'), [], 'timestamps at the end of a line count');
    assert.deepEqual(chapterProblems('0:00 a\n0:99 b\n1:30 c\n2:00 d').length, 0, '0:99 is not a timestamp');
  });

  it('sends the recording date and asks for its part; refuses a bad date', async () => {
    const { buildMetadata, insertParts } = await import('../src/providers/youtube.ts');
    const opts = { privacy: 'public' as const, madeForKids: false, recordingDate: '2026-10-01' };
    assert.deepEqual((buildMetadata(post(), opts) as { recordingDetails: unknown }).recordingDetails, { recordingDate: '2026-10-01T00:00:00Z' });
    assert.equal(insertParts(opts), 'snippet,status,recordingDetails');
    const codes = (o: Record<string, unknown>) => youtube.validate(post(), target({ privacy: 'public', madeForKids: false, ...o }), fakeMedia()).map((i) => i.code);
    assert.ok(codes({ recordingDate: '10/01/2026' }).includes('recording_date'));
    assert.ok(codes({ recordingDate: '2026-02-30' }).includes('recording_date'), 'not a real day');
    assert.ok(!codes({ recordingDate: '2026-10-01' }).includes('recording_date'));
  });
});

describe('youtube paid product placement', () => {
  const URL_PART = '/youtube/v3/videos?part=paidProductPlacementDetails';
  function publish(options: Record<string, unknown>, route: Parameters<typeof mockFetch>[0][number], resume: Record<string, unknown> = { videoId: 'VID' }) {
    const { fetch, calls } = mockFetch([route]);
    const { ctx, store } = makeCtx(fetch, () => NOW);
    store.setApp('youtube', { clientId: 'c', clientSecret: 's' });
    const saved: Array<Record<string, unknown>> = [];
    const out = youtube.publish({
      ctx, post: post(), target: target({ privacy: 'unlisted', madeForKids: false, ...options }, resume), account,
      mediaPath: tempFile(100), media: fakeMedia(), saveResume: (r) => saved.push(r),
    });
    return { out, calls, saved, store };
  }

  it('sets the disclosure once after the upload with videos.update', async () => {
    const { out, calls, saved } = publish({ paidProductPlacement: true }, ['PUT', URL_PART, () => json({ id: 'VID', paidProductPlacementDetails: { hasPaidProductPlacement: false } })]);
    const result = await out;
    assert.equal(result.state, 'processing');
    assert.deepEqual(result.warnings, [], 'a lagging read-back in the response is not a failure');
    const puts = calls.filter((c) => c.url.includes(URL_PART));
    assert.equal(puts.length, 1);
    assert.equal(puts[0]!.headers.authorization, 'Bearer AT');
    assert.deepEqual(JSON.parse(String(puts[0]!.body)), { id: 'VID', paidProductPlacementDetails: { hasPaidProductPlacement: true } });
    assert.deepEqual(saved.at(-1), { videoId: 'VID', extras: ['paidPlacement'] }, 'marked done before it is sent');
  });

  it('turns a refusal or a network error into a warning, and never sends it twice', async () => {
    const refused = publish({ paidProductPlacement: true }, ['PUT', URL_PART, () => json({ error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } }, 403)]);
    const r = await refused.out;
    assert.equal(r.state, 'processing', 'the post itself still goes ahead');
    assert.deepEqual(r.warnings, ['유료 PPL 표시 실패 (forbidden): Forbidden — YouTube Studio에서 직접 표시하세요']);
    assert.deepEqual(refused.saved.at(-1), { videoId: 'VID', extras: ['paidPlacement'] });

    const offline = publish({ paidProductPlacement: true }, ['PUT', URL_PART, () => { throw new TypeError('fetch failed'); }]);
    assert.ok((await offline.out).warnings?.[0]?.startsWith('유료 PPL 표시 실패: fetch failed'));

    const again = publish({ paidProductPlacement: true }, ['PUT', URL_PART, () => json({})], { videoId: 'VID', extras: ['paidPlacement'] });
    await again.out;
    assert.equal(again.calls.length, 0, 'already attempted for this video');
  });

  it('sends nothing unless it is on, and counts its quota units', async () => {
    for (const options of [{}, { paidProductPlacement: false }]) {
      const { out, calls } = publish(options, ['PUT', URL_PART, () => json({})]);
      await out;
      assert.equal(calls.length, 0);
    }
    assert.equal(unitCost('PUT', `https://www.googleapis.com${URL_PART}`), 50);
    assert.equal(postUnits({ captions: [] }, { paidProductPlacement: true }) - postUnits({ captions: [] }, {}), 50);
    const codes = (o: Record<string, unknown>) => youtube.validate(post(), target({ privacy: 'public', madeForKids: false, ...o }), fakeMedia()).map((i) => i.code);
    assert.ok(codes({ paidProductPlacement: 'yes' }).includes('paid_placement'));
    assert.ok(!codes({ paidProductPlacement: true }).includes('paid_placement'));
  });

  it('takes --yt-paid-placement, and --paid-partnership for YouTube too', () => {
    const yt = (...flags: string[]) => targetOptions('youtube', parseArgs(['post', 'v.mp4', ...flags])).paidProductPlacement;
    assert.equal(yt('--yt-paid-placement', 'yes'), true);
    assert.equal(yt('--paid-partnership'), true);
    assert.equal(yt('--paid-partnership', '--yt-paid-placement', 'no'), false, 'the platform flag wins');
    assert.equal(yt(), undefined);
  });
});
