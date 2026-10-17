import type { Provider } from '../core/provider.ts';
import { bluesky } from './bluesky.ts';
import { facebook } from './facebook.ts';
import { instagram } from './instagram.ts';
import { mastodon } from './mastodon.ts';
import { peertube } from './peertube.ts';
import { tiktok } from './tiktok.ts';
import { x } from './x.ts';
import { youtube } from './youtube.ts';

/**
 * Built-in providers, all on official APIs. Browser-automation adapters (e.g. Naver Clip) are meant
 * to live in separate opt-in packages that register through the same Provider interface.
 */
export const BUILTIN_PROVIDERS: readonly Provider[] = [youtube, tiktok, instagram, facebook, x, bluesky, mastodon, peertube];

export function providerMap(extra: readonly Provider[] = []): Map<string, Provider> {
  return new Map([...BUILTIN_PROVIDERS, ...extra].map((p) => [p.id, p]));
}
