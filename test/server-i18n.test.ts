import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { catalogue, msg, translate, translateDeep } from '../src/core/i18n.ts';

const ROOT = join(import.meta.dirname, '..');
const HANGUL = /[가-힣]/;
/** Files whose user-facing messages go through msg(); more join as they are converted. */
const CONVERTED = [
  'src/server/server.ts',
  'src/core/posting.ts',
  'src/core/media.ts',
  'src/core/runner.ts',
  'src/core/livecheck.ts',
  'src/core/notify.ts',
  'src/core/http.ts',
  'src/providers/youtube.ts',
  'src/providers/tiktok.ts',
  'src/providers/meta.ts',
  'src/providers/instagram.ts',
  'src/providers/facebook.ts',
  'src/providers/x.ts',
  'src/providers/bluesky.ts',
  'src/providers/mastodon.ts',
  'src/providers/peertube.ts',
  'src/cli.ts',
  'src/mcp/server.ts',
  'src/core/inbox.ts',
  'src/core/restore.ts',
];
const LITERAL = /'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

function unquote(lit: string): string {
  const body = lit.slice(1, -1);
  return lit[0] === "'" ? body.replace(/\\'/g, "'").replace(/\\n/g, '\n') : body;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('server message catalogue', () => {
  const en = catalogue();

  it('every msg() key in the converted files has English with the same placeholders', () => {
    for (const file of CONVERTED) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      for (const m of src.matchAll(/msg\(('(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/g)) {
        const key = unquote(m[1]!);
        if (!HANGUL.test(key)) continue;
        assert.ok(en[key], `${file}: no English for ${JSON.stringify(key)}`);
        assert.deepEqual(placeholders(en[key]!), placeholders(key), `${file}: placeholders differ for ${JSON.stringify(key)}`);
      }
    }
  });

  it('no Korean text in the converted files outside msg()', () => {
    const stray: string[] = [];
    for (const file of CONVERTED) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      const lines = src.split('\n');
      for (const m of src.matchAll(LITERAL)) {
        if (!HANGUL.test(m[0]) || src.slice(Math.max(0, m.index! - 4), m.index) === 'msg(') continue;
        const line = lines[src.slice(0, m.index).split('\n').length - 1]!;
        if (/^\s*(\/\/|\*)/.test(line) || line.includes('i18n-ignore')) continue;
        stray.push(`${file}: ${m[0].slice(0, 60)}`);
      }
    }
    assert.deepEqual(stray, []);
  });

  it('every rendered message reads back as its English, whatever the values', () => {
    for (const [key, english] of Object.entries(en)) {
      const vars = Object.fromEntries(placeholders(key).map((name, i) => [name, `X${i}`]));
      assert.equal(translate(msg(key, vars), 'en'), msg(english, vars), `round trip: ${JSON.stringify(key)}`);
    }
  });
});

describe('translating messages', () => {
  const sample = Object.entries(catalogue()).map(([key, english]) => {
    const vars = Object.fromEntries(placeholders(key).map((name, i) => [name, `X${i}`]));
    return { key, ko: msg(key, vars), en: msg(english, vars) };
  });

  it('reads messages joined with " / " or line breaks back one by one', () => {
    const bad: string[] = [];
    // Messages that are joined in practice: one-line ones with " / ", any of them line by line,
    // leaving out the setup guides and CLI paragraphs, which are never followed by another message.
    const joinable = sample.filter((m) => !(m.ko.includes('\n') && (m.ko.length > 300 || m.ko.startsWith('\n'))));
    joinable.forEach((a, i) =>
      joinable.forEach((b, j) => {
        if ((i * 31 + j) % 7) return;
        for (const sep of [' / ', '\n']) {
          if (sep === ' / ' && [a, b].some((m) => m.ko.includes(' / ') || m.ko.includes('\n'))) continue;
          if (translate(a.ko + sep + b.ko, 'en') !== a.en + sep + b.en) bad.push(`${a.key} ${JSON.stringify(sep)} ${b.key}`);
        }
      }),
    );
    assert.deepEqual(bad, []);
  });

  it('reads values holding Korean and punctuation back unchanged', () => {
    const bad: string[] = [];
    for (const value of ['새 영상 (1편)', '오류 — 다시', '가, 나', '끝. 다음']) {
      for (const [key, english] of Object.entries(catalogue())) {
        const names = [...new Set(placeholders(key))];
        for (const target of names) {
          const vars = Object.fromEntries(names.map((name, i) => [name, name === target ? value : `X${i}`]));
          if (translate(msg(key, vars), 'en') !== msg(english, vars)) bad.push(`${target} = ${value} in ${key}`);
        }
      }
    }
    // Only the last value of these can be misread, and a time or link there never holds this punctuation.
    assert.deepEqual(bad.sort(), [
      'notBefore = 오류 — 다시 in {platform}: {message} — {notBefore}에 재시도',
      'time = 가, 나 in {visibility}, {time}에 게시',
      'url = 끝. 다음 in PeerTube {failure}. {url} 에서 확인하세요',
    ]);
  });

  it('stays fast on long text that almost matches', () => {
    const near = 'youtube/main: 가. 나/다: 라. '.repeat(600) + '이미 게시됐거나 나중에 게시될 수 있습니다';
    const started = performance.now();
    translate(near, 'en');
    translate('가'.repeat(1_000_000), 'en');
    assert.ok(performance.now() - started < 200, `${performance.now() - started} ms`);
  });

  it('translates a message that carries another message', () => {
    const inner = msg('연결된 계정이 없습니다: {platform}/{account}', { platform: 'youtube', account: 'main' });
    assert.equal(translate(msg('가져오지 못함: {err}', { err: inner }), 'en'), "Couldn't fetch: No connected account: youtube/main");
  });

  it('translates joined messages line by line and part by part', () => {
    const a = msg('제목을 입력하세요');
    const b = msg('파일이 너무 큽니다');
    assert.equal(translate(`${a}\n${b}`, 'en'), 'Enter a title\nThe file is too large');
    assert.equal(translate(`${a} / ${b}`, 'en'), 'Enter a title / The file is too large');
  });

  it('leaves Korean, unknown text and user content alone', () => {
    assert.equal(translate(msg('제목을 입력하세요'), 'ko'), '제목을 입력하세요');
    assert.equal(translate('플랫폼이 보낸 처음 보는 오류', 'en'), '플랫폼이 보낸 처음 보는 오류');
    const out = translateDeep({ post: { title: '제목을 입력하세요' }, error: '제목을 입력하세요', tags: ['썸네일'] }, 'en');
    assert.deepEqual(out, { post: { title: '제목을 입력하세요' }, error: 'Enter a title', tags: ['썸네일'] });
  });

  it('keeps names, labels, options and profiles as written, except check names and field labels', () => {
    const user = { name: '전체', label: '채널', options: { caption: '썸네일', alt: '실패' }, profile: { handle: '계정' } };
    assert.deepEqual(translateDeep({ preset: user, accounts: [user] }, 'en'), { preset: user, accounts: [user] });
    const out = translateDeep({ checks: [{ name: msg('채널'), status: 'ok', detail: msg('실패') }], appFields: [{ key: 'token', label: msg('액세스 토큰'), secret: true }] }, 'en');
    assert.deepEqual(out, { checks: [{ name: 'Channel', status: 'ok', detail: 'failed' }], appFields: [{ key: 'token', label: 'Access token', secret: true }] });
  });

  it('reads a message whose last value is empty', () => {
    assert.equal(translate(msg('알림 켜짐: {host} ({format}, {events}){source}', { host: 'h', format: 'json', events: 'failed', source: '' }), 'en'), 'Notifications on: h (json, failed)');
    assert.equal(translate('상태는 다시 시도할 수 없습니다', 'en'), '상태는 다시 시도할 수 없습니다', 'a leading value is never empty');
  });

  it('keeps account, channel and tag names as written', () => {
    assert.equal(translate(msg('{platform}/{account} (연결 안 됨)', { platform: 'mastodon', account: '실패' }), 'en'), 'mastodon/실패 (not connected)');
    const tags = msg('PeerTube 태그는 {TAGS_MAX}개까지, 각 {TAG_MIN}~{TAG_MAX}자만 올라갑니다: {kept}', { TAGS_MAX: 8, TAG_MIN: 2, TAG_MAX: 30, kept: '실패, 전체' });
    assert.match(translate(tags, 'en'), /: 실패, 전체$/);
    const preview = { platform: 'youtube', account: '실패', accountLabel: '예약 상담소', visibility: msg('(미지정)') };
    assert.deepEqual(translateDeep(preview, 'en'), { ...preview, visibility: '(not set)' });
  });

  it('gives up on labels nested too deep instead of overflowing the stack', () => {
    const deep = 'a: '.repeat(2000) + '전체';
    assert.equal(translate(deep, 'en'), deep);
  });

  it('keeps user content inside a message as written', () => {
    assert.equal(translate(msg('{platform}/{account} 댓글 {commentId}에 답글:\n  {text}', { platform: 'x', account: 'main', commentId: '1', text: '실패' }), 'en'), 'x/main reply to comment 1:\n  실패');
  });
});
