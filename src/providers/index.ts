import type { Provider } from '../core/provider.ts';
import { bluesky } from './bluesky.ts';
import { facebook } from './facebook.ts';
import { instagram } from './instagram.ts';
import { tiktok } from './tiktok.ts';
import { youtube } from './youtube.ts';

/**
 * Built-in providers, all on official APIs. Browser-automation adapters (e.g. Naver Clip) are meant
 * to live in separate opt-in packages that register through the same Provider interface.
 */
export const BUILTIN_PROVIDERS: readonly Provider[] = [youtube, tiktok, instagram, facebook, bluesky];

export function providerMap(extra: readonly Provider[] = []): Map<string, Provider> {
  return new Map([...BUILTIN_PROVIDERS, ...extra].map((p) => [p.id, p]));
}
