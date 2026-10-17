import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SecretBox, loadSecretKey } from './crypto.ts';
import type { Logger, ProviderContext } from './provider.ts';
import { Store } from './store.ts';

export function fanoutHome(): string {
  return process.env.FANOUT_HOME ?? join(homedir(), '.fanout');
}

export const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(`⚠ ${msg}`),
};

export function openContext(home = fanoutHome(), log: Logger = consoleLogger): ProviderContext {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const box = new SecretBox(loadSecretKey(home));
  return { store: new Store(join(home, 'fanout.db'), box), log, fetch: globalThis.fetch, now: () => new Date(), home };
}
