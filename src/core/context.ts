import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SecretBox, loadSecretKey } from './crypto.ts';
import { capResponses } from './http.ts';
import { local } from './i18n.ts';
import type { Logger, ProviderContext } from './provider.ts';
import { attachNotifier } from './notify.ts';
import { Store } from './store.ts';

export function fanoutHome(): string {
  return process.env.FANOUT_HOME ?? join(homedir(), '.fanout');
}

export const consoleLogger: Logger = {
  info: (msg) => console.log(local(msg)),
  warn: (msg) => console.warn(`⚠ ${local(msg)}`),
};

/** For stdio servers (MCP), where stdout carries the protocol. */
export const stderrLogger: Logger = {
  info: (msg) => console.error(local(msg)),
  warn: (msg) => console.error(`⚠ ${local(msg)}`),
};

export function openContext(home = fanoutHome(), log: Logger = consoleLogger): ProviderContext {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const box = new SecretBox(loadSecretKey(home));
  const ctx: ProviderContext = { store: new Store(join(home, 'fanout.db'), box), log, fetch: capResponses(globalThis.fetch), now: () => new Date(), home };
  attachNotifier(ctx);
  return ctx;
}
