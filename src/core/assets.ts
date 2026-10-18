// Thumbnail and caption files: one set of rules for every way they come in (dashboard upload, MCP,
// watch folder). Only small files of the expected type are ever read and sent to a platform, so a
// path that points elsewhere (a key, a device) is refused rather than uploaded.

import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { msg } from './i18n.ts';

/** YouTube accepts JPEG/PNG thumbnails up to 2MB and these caption formats. */
export const ASSET_RULES = {
  thumbnail: { exts: ['.jpg', '.jpeg', '.png'], maxBytes: 2 * 1024 * 1024 },
  caption: { exts: ['.srt', '.vtt', '.sbv', '.scc', '.ttml', '.dfxp'], maxBytes: 5 * 1024 * 1024 },
} as const;
export type AssetKind = keyof typeof ASSET_RULES;

/** Why `path` can't be used as a thumbnail or caption, or undefined when it can. */
export function assetProblem(kind: AssetKind, path: string): string | undefined {
  const rule = ASSET_RULES[kind];
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return msg('일반 파일이 아닙니다: {path}', { path });
    size = st.size;
  } catch {
    return msg('파일이 없습니다: {path}', { path });
  }
  if (!(rule.exts as readonly string[]).includes(extname(path).toLowerCase())) return msg('{exts} 파일만 받습니다', { exts: rule.exts.join(', ') });
  if (size > rule.maxBytes) return msg('{max}MB 이하여야 합니다', { max: rule.maxBytes / 1024 / 1024 });
  return undefined;
}

/**
 * Copy a thumbnail or caption into fanout's own media folder and return the copy's path, checking
 * the bytes actually read: opened without following a symlink, a regular file with no other hard
 * link, of the right type and size. Uploads later read the copy, so the original can't be swapped
 * for something else in between (a watch folder others can write to). Throws with the reason.
 */
export function importAsset(kind: AssetKind, path: string, mediaDir: string): string {
  const rule = ASSET_RULES[kind];
  const ext = extname(path).toLowerCase();
  if (!(rule.exts as readonly string[]).includes(ext)) throw new Error(msg('{exts} 파일만 받습니다', { exts: rule.exts.join(', ') }));
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    throw new Error((err as NodeJS.ErrnoException).code === 'ELOOP' ? msg('심볼릭 링크는 쓸 수 없습니다: {path}', { path }) : msg('파일이 없습니다: {path}', { path }));
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(msg('일반 파일이 아닙니다: {path}', { path }));
    if (st.nlink > 1) throw new Error(msg('다른 곳에 하드 링크된 파일은 쓸 수 없습니다: {path}', { path }));
    if (st.size > rule.maxBytes) throw new Error(msg('{max}MB 이하여야 합니다', { max: rule.maxBytes / 1024 / 1024 }));
    const data = readFileSync(fd);
    if (data.length > rule.maxBytes) throw new Error(msg('{max}MB 이하여야 합니다', { max: rule.maxBytes / 1024 / 1024 }));
    mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    // The original name stays readable (platform file names, warnings); the prefix keeps it unique.
    const copy = join(mediaDir, `${randomUUID().slice(0, 8)}-${basename(path, extname(path))}${ext}`);
    writeFileSync(copy, data, { mode: 0o600 });
    return copy;
  } finally {
    closeSync(fd);
  }
}
