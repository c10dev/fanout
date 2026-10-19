import { msg } from './i18n.ts';
import type { Target } from './types.ts';

/**
 * A target published without knowing its post's id on the platform: Instagram can publish a
 * container whose media id fanout never learned (a crash or a timeout right after media_publish)
 * and that couldn't be found among the account's posts. Its remoteId is the container's, which no
 * read or write accepts, so stats, comments and the first comment skip it.
 */
export function remoteIdUnknown(t: Target): boolean {
  return (t.resume as { mediaIdUnknown?: unknown } | undefined)?.mediaIdUnknown === true;
}

export const remoteIdUnknownNote = () => msg('플랫폼의 게시물 id를 몰라 건너뜁니다. 게시물은 앱에서 확인하세요');
