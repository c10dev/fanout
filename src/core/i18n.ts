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
  /** The literal text around the placeholders: always one more than names, possibly empty. */
  pieces: string[];
  multiline: boolean;
}

let matchers: { single: Matcher[]; multi: Matcher[]; maxLines: number } | undefined;

/** Templates, most specific (longest literal text) first, split by whether they span lines. */
function compile(): { single: Matcher[]; multi: Matcher[]; maxLines: number } {
  if (matchers) return matchers;
  const all = Object.keys(MESSAGES_EN)
    // A template that is only placeholders and punctuation would swallow anything.
    .filter((key) => HANGUL.test(key))
    .map((key) => {
      const parts = key.split(/\{(\w+)\}/);
      return { key, names: parts.filter((_, i) => i % 2), pieces: parts.filter((_, i) => i % 2 === 0), multiline: key.includes('\n') };
    })
    .sort((a, b) => b.pieces.join('').length - a.pieces.join('').length || b.key.length - a.key.length);
  const multi = all.filter((m) => m.multiline);
  matchers = { single: all.filter((m) => !m.multiline), multi, maxLines: Math.max(...multi.map((m) => m.key.split('\n').length)) };
  return matchers;
}

/**
 * The placeholder values if `value` is the template rendered, else undefined. Each value takes at
 * least one character and stops at the first place the rest of the template can follow, like a lazy
 * regex, but by scanning for the literal pieces: no backtracking, so long input stays linear. Once
 * a piece is found at its first possible place, a later place could only leave less room for the
 * rest, so the first one is the answer, except for the last piece (see below).
 */
function match(m: Matcher, value: string): string[] | undefined {
  const { pieces } = m;
  const first = pieces[0]!;
  const last = pieces[pieces.length - 1]!;
  if (pieces.length === 1) return value === first ? [] : undefined;
  if (!value.startsWith(first) || !value.endsWith(last)) return undefined;
  const end = value.length - last.length;
  const values: string[] = [];
  let pos = first.length;
  for (let i = 1; i < pieces.length - 1; i++) {
    const lit = pieces[i]!;
    // Room the values after this piece need: one character each, except an empty trailing value.
    const room = i === pieces.length - 2 && !last ? 0 : 1;
    let at = lit ? value.indexOf(lit, pos + 1) : pos + 1;
    if (at < 0 || at + lit.length > end - room) return undefined;
    if (lit && i === pieces.length - 2) {
      // The last value is usually short (a time, a link, a hint) and the one before it a message that
      // may hold the same punctuation, so the last piece is the rightmost place that still fits.
      const right = value.lastIndexOf(lit, end - lit.length - 1);
      if (right > at && !value.slice(pos, right).includes('\n')) at = right;
    }
    // Only the last value may run over lines (a list, a reply); otherwise it is swallowing a neighbour.
    const v = value.slice(pos, at);
    if (v.includes('\n')) return undefined;
    values.push(v);
    pos = at + lit.length;
  }
  // The last value may be empty when nothing follows it ("…{source}" with no source); any other
  // value must hold something, or a template starting with "{state} …" would match anything.
  if (pos > end || (pos === end && last)) return undefined;
  values.push(value.slice(pos, end));
  return values;
}

const HANGUL = /[가-힣]/;
/** Longer strings are not messages (the longest, the CLI help, is about 4 KB). */
const MAX_LENGTH = 16_384;
/** Placeholders that carry user content, which is never translated even when it reads like a message. */
const VERBATIM = new Set([
  'title', 'text', 'path', 'url', 'file', 'dir', 'profile', 'username', 'nickname', 'handle', 'backup', 'home', 'savedTo', 'backupDir',
  'account', 'accounts', 'name', 'candidates', 'channel', 'channels', 'kept',
]);
/** Messages inside messages go a few levels deep at most; past that the text is not a message. */
const MAX_DEPTH = 8;

const cache = new Map<string, string>();
let depth = 0;

/** English for a rendered Korean message, or the message itself if no template matches. */
export function translate(value: string, lang: Lang): string {
  if (lang === 'ko' || value.length > MAX_LENGTH || depth >= MAX_DEPTH || !HANGUL.test(value)) return value;
  let english = cache.get(value);
  if (english !== undefined) return english;
  depth++;
  try {
    english = translateMessages(value);
  } finally {
    depth--;
  }
  // The dashboard re-sends the same board every few seconds; a bounded memo keeps that cheap. Only
  // whole strings are kept: an inner one may have been cut short by the depth limit.
  if (depth === 0) {
    if (cache.size >= 5000) cache.clear();
    cache.set(value, english);
  }
  return english;
}

/** The terminal's language: English only when asked for with FANOUT_LANG=en (the system locale is not a reliable signal). */
export function currentLang(): Lang {
  return process.env.FANOUT_LANG?.trim().toLowerCase().startsWith('en') ? 'en' : 'ko';
}

/** A message for the terminal (CLI output, logs, MCP results) in FANOUT_LANG. */
export function local(value: string): string {
  return translate(value, currentLang());
}

/**
 * One message, or several joined line by line or with " / ". Lines are grouped into the longest
 * known (multi-line) message from the top; " / " parts are tried first and kept when every part is
 * a known message, since a value holding " / " is rarer than messages joined with it.
 */
function translateMessages(value: string): string {
  if (value.includes('\n')) return translateOne(value) ?? translateLines(value.split('\n'));
  if (value.includes(' / ')) {
    const parts = value.split(' / ');
    const english = parts.map(translateOne);
    if (english.every((part) => part !== undefined)) return english.join(' / ');
    return translateOne(value) ?? parts.map((part, i) => english[i] ?? part).join(' / ');
  }
  return translateOne(value) ?? value;
}

function translateLines(lines: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let k = Math.min(lines.length - i, compile().maxLines);
    for (; k > 1; k--) {
      const english = translateOne(lines.slice(i, i + k).join('\n'));
      if (english !== undefined) {
        out.push(english);
        break;
      }
    }
    if (k <= 1) {
      out.push(translate(lines[i]!, 'en'));
      k = 1;
    }
    i += k;
  }
  return out.join('\n');
}

/** English for one message; text without Korean counts as understood. */
function translateOne(value: string): string | undefined {
  if (!HANGUL.test(value)) return value;
  return translateWhole(value) ?? translateLabelled(value);
}

function translateWhole(value: string): string | undefined {
  // A one-line message never holds a line break: two joined messages are not one message.
  const { single, multi } = compile();
  for (const m of value.includes('\n') ? multi : single) {
    const values = match(m, value);
    // User content kept as it is spans no lines here: more lines would be other messages after it.
    if (!values || m.names.some((name, i) => VERBATIM.has(name) && values[i]!.includes('\n'))) continue;
    const vars: Record<string, string> = {};
    m.names.forEach((name, i) => {
      // A value can itself be a message (e.g. "가져오지 못함: {error}").
      vars[name] = VERBATIM.has(name) ? values[i]! : translate(values[i]!, 'en');
    });
    return render(MESSAGES_EN[m.key]!, vars);
  }
  return undefined;
}

/** A message behind a platform or account label: "youtube/main: …", "- tiktok — …", "x (…)". */
const LABELLED = /^(\s*(?:- )?[\w.@/-]+)(: | — | \()([\s\S]+)$/;

function translateLabelled(value: string): string | undefined {
  if (value.includes('\n')) return undefined;
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

/**
 * Keys whose values are user content (titles, captions and other target options, account names,
 * profiles and labels, preset names), never translated even if they read like a message. Two shapes reuse
 * those keys for messages and are translated: a check's name ({ name, status, detail }) and an app
 * field's label ({ key, label, secret }).
 */
const USER_FIELDS = new Set([
  'title', 'description', 'tags', 'text', 'author', 'remoteUrl', 'url', 'mediaName', 'username', 'displayName', 'pageName', 'channelTitle',
  'name', 'label', 'options', 'profile', 'account', 'accountLabel',
]);

function isMessageField(obj: object, key: string): boolean {
  if (key === 'name') return 'status' in obj && 'detail' in obj;
  if (key === 'label') return 'key' in obj && 'secret' in obj;
  return false;
}

/** Translate every message string inside an API response. */
export function translateDeep<T>(value: T, lang: Lang): T {
  if (lang === 'ko') return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return translate(v, lang);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, USER_FIELDS.has(k) && !isMessageField(v, k) ? x : walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** The English catalogue's keys, for tests. */
export function catalogue(): Record<string, string> {
  return MESSAGES_EN;
}
