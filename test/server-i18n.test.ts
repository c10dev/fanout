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
});
