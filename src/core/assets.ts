// Thumbnail and caption files: one set of rules for every way they come in (dashboard upload, MCP,
// watch folder). Only small files of the expected type are ever read and sent to a platform, so a
// path that points elsewhere (a key, a device) is refused rather than uploaded.

import { statSync } from 'node:fs';
import { extname } from 'node:path';
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
