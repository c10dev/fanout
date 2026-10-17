import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const dir = join(import.meta.dirname, '..', 'src', 'server', 'public');
const app = readFileSync(join(dir, 'app.js'), 'utf8');
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const KOREAN = /[가-힣]/;

/** Run i18n.js with a given browser language and saved choice; returns its globals. */
function load(language: string, saved?: string) {
  const sandbox: Record<string, unknown> = {
    navigator: { languages: [language], language },
    localStorage: { getItem: () => saved ?? null, setItem: () => {} },
  };
  vm.runInNewContext(`${readFileSync(join(dir, 'i18n.js'), 'utf8')}\nthis.out = { LANG, LOCALE, tr, MESSAGES_EN };`, sandbox);
  return sandbox.out as { LANG: string; LOCALE: string; tr: (k: string, v?: Record<string, unknown>) => string; MESSAGES_EN: Record<string, string> };
}

function keys(): string[] {
  const out = new Set<string>();
  for (const m of app.matchAll(/tr\('((?:[^'\\]|\\.)*)'/g)) out.add(m[1]!.replace(/\\n/g, '\n').replace(/\\'/g, "'"));
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]*)"/g)) out.add(m[1]!);
  return [...out];
}

describe('dashboard translations', () => {
  it('every string in the dashboard has an English version with the same placeholders', () => {
    const { MESSAGES_EN } = load('en');
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    for (const k of keys()) {
      assert.ok(MESSAGES_EN[k], `no English for: ${k}`);
      assert.equal(placeholders(MESSAGES_EN[k]!), placeholders(k), `placeholders differ: ${k}`);
    }
  });

  it('no Korean text in app.js outside tr() (comments and marked lines aside)', () => {
    const left = app
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, l]) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !l.includes('i18n-ignore'))
      .map(([n, l]) => [n, l.replace(/tr\('(?:[^'\\]|\\.)*'/g, 'tr(X').replace(/\s\/\/\s.*$/, '')] as const)
      .filter(([, l]) => KOREAN.test(l));
    assert.deepEqual(left, []);
  });

  it('every Korean line in index.html is marked for translation', () => {
    assert.deepEqual(html.split('\n').filter((l) => KOREAN.test(l) && !l.includes('data-i18n')), []);
  });

  it('picks the language from the browser, unless one was chosen', () => {
    assert.equal(load('ko-KR').LANG, 'ko');
    assert.equal(load('en-US').LANG, 'en');
    assert.equal(load('fr').LANG, 'en');
    assert.equal(load('en-US', 'ko').LANG, 'ko');
    assert.equal(load('ko', 'en').LOCALE, 'en-US');
    const { tr } = load('en');
    assert.equal(tr('시도 {n}회', { n: 3 }), '3 attempts');
    assert.equal(load('ko').tr('시도 {n}회', { n: 3 }), '시도 3회');
  });
});
