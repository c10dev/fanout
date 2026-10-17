// Server messages in Korean or English.
//
// Korean is the source text and the key, as in the dashboard (src/server/public/i18n.js): code
// builds messages with msg('… {name} …', { name }), which renders Korean. Many messages are stored
// that way (a target's errorMessage and warnings, stats notes) by a worker that has no idea who will
// read them, so English is produced on the way out instead: translate() recognises a rendered Korean
// message by matching it against the catalogue's templates and renders the English one with the
// same values. Strings with no matching template stay as they are, so an untranslated message is
// simply Korean. The CLI and the MCP server do the same with their output when FANOUT_LANG=en.

import { MESSAGES_EN } from './messages.en.ts';

export type Lang = 'ko' | 'en';

const PLACEHOLDER = /\{(\w+)\}/g;

function render(template: string, vars?: Record<string, unknown>): string {
  return vars ? template.replace(PLACEHOLDER, (m, name: string) => (name in vars ? String(vars[name]) : m)) : template;
}

/** A user-facing message from its Korean template. */
export function msg(key: string, vars?: Record<string, unknown>): string {
  return render(key, vars);
}

interface Matcher {
  key: string;
  names: string[];
  re: RegExp;
}

let matchers: Matcher[] | undefined;

/** Templates as anchored patterns, most specific (longest literal text) first. */
function compile(): Matcher[] {
  if (matchers) return matchers;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  matchers = Object.keys(MESSAGES_EN)
    .map((key) => {
      const names: string[] = [];
      const literal = key.replace(PLACEHOLDER, '');
      const source = key
        .split(/(\{\w+\})/)
        .map((part) => {
          const m = /^\{(\w+)\}$/.exec(part);
          if (!m) return escape(part);
          names.push(m[1]!);
          return '([\\s\\S]+?)';
        })
        .join('');
      return { key, names, re: new RegExp(`^${source}$`), literal: literal.length };
    })
    // A template that is only placeholders and punctuation would swallow anything.
    .filter((m) => /[가-힣]/.test(m.key))
    .sort((a, b) => b.literal - a.literal || b.key.length - a.key.length)
    .map(({ key, names, re }) => ({ key, names, re }));
  return matchers;
}

const HANGUL = /[가-힣]/;

/** English for a rendered Korean message, or the message itself if no template matches. */
export function translate(value: string, lang: Lang): string {
  if (lang === 'ko' || !HANGUL.test(value)) return value;
  return translateWhole(value) ?? translateLabelled(value) ?? translateParts(value);
}

/** The terminal's language: English only when asked for with FANOUT_LANG=en (the system locale is not a reliable signal). */
export function currentLang(): Lang {
  return process.env.FANOUT_LANG?.trim().toLowerCase().startsWith('en') ? 'en' : 'ko';
}

/** A message for the terminal (CLI output, logs, MCP results) in FANOUT_LANG. */
export function local(value: string): string {
  return translate(value, currentLang());
}

function translateWhole(value: string): string | undefined {
  for (const m of compile()) {
    const hit = m.re.exec(value);
    if (!hit) continue;
    const vars: Record<string, string> = {};
    m.names.forEach((name, i) => {
      // A value can itself be a message (e.g. "가져오지 못함: {error}").
      vars[name] = translate(hit[i + 1]!, 'en');
    });
    return render(MESSAGES_EN[m.key]!, vars);
  }
  return undefined;
}

/** A message behind a platform or account label: "youtube/main: …", "- tiktok — …", "x (…)". */
const LABELLED = /^(\s*(?:- )?[\w.@/-]+)(: | — | \()([\s\S]+)$/;

function translateLabelled(value: string): string | undefined {
  const m = LABELLED.exec(value);
  if (!m) return undefined;
  let rest = m[3]!;
  const close = m[2] === ' (' ? ')' : '';
  if (close) {
    if (!rest.endsWith(')')) return undefined;
    rest = rest.slice(0, -1);
  }
  const english = translate(rest, 'en');
  return english === rest ? undefined : `${m[1]}${m[2]}${english}${close}`;
}

/** Messages joined into one string: line by line, then " / "-separated parts. */
function translateParts(value: string): string {
  if (value.includes('\n')) return value.split('\n').map((line) => translateWhole(line) ?? translateLabelled(line) ?? (line.includes(' / ') ? splitSlash(line) : line)).join('\n');
  if (value.includes(' / ')) return splitSlash(value);
  return value;
}

function splitSlash(value: string): string {
  return value
    .split(' / ')
    .map((part) => translateWhole(part) ?? translateLabelled(part) ?? part)
    .join(' / ');
}

/** User content is never translated, even if it happens to read like a message. */
// (Account names and labels are left in: templates always carry Korean text of their own, so a name
// would have to spell out a whole message to be touched, and check names and field labels need them.)
const USER_FIELDS = new Set(['title', 'description', 'tags', 'text', 'author', 'remoteUrl', 'url', 'mediaName', 'username', 'displayName', 'pageName', 'channelTitle']);

/** Translate every message string inside an API response. */
export function translateDeep<T>(value: T, lang: Lang): T {
  if (lang === 'ko') return value;
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key && USER_FIELDS.has(key) ? v : translate(v, lang);
    if (Array.isArray(v)) return key && USER_FIELDS.has(key) ? v : v.map((x) => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}

/** The English catalogue's keys, for tests. */
export function catalogue(): Record<string, string> {
  return MESSAGES_EN;
}
