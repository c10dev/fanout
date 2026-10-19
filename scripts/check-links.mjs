// Checks every relative link and #anchor in the Markdown docs: the file exists, and the anchor is a
// heading in it (GitHub's slugs). Usage: node scripts/check-links.mjs → prints problems, exits 1.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const files = [...readdirSync(root).filter((f) => /^(README.*|CHANGELOG)\.md$/.test(f)), ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens, repeats numbered. */
export function anchors(markdown) {
  const seen = new Map();
  const out = new Set();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const m = !fenced && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

export function problems() {
  const out = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, anchor] = target.split('#');
      const dest = path ? resolve(dirname(join(root, file)), decodeURIComponent(path)) : join(root, file);
      if (!existsSync(dest)) {
        out.push(`${file}: ${target} — no such file`);
        continue;
      }
      if (anchor && dest.endsWith('.md') && !anchors(readFileSync(dest, 'utf8')).has(decodeURIComponent(anchor))) out.push(`${file}: ${target} — no such heading`);
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const found = problems();
  for (const p of found) console.log(p);
  process.exit(found.length ? 1 : 0);
}
