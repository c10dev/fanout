import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

/**
 * Encrypts secrets (OAuth tokens, app secrets) at rest with AES-256-GCM.
 * Output format: `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('secret key must be 32 bytes');
    this.#key = key;
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, tag, body].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  open(sealed: string): string {
    const [version, iv, tag, body] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || body === undefined) throw new Error('unrecognised sealed secret');
    const decipher = createDecipheriv(ALGORITHM, this.#key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  }
}

/**
 * Key source, in order: FANOUT_SECRET_KEY (base64, 32 bytes), else `<home>/secret.key`,
 * generated with mode 0600 on first use.
 */
export function loadSecretKey(home: string): Buffer {
  const fromEnv = process.env.FANOUT_SECRET_KEY;
  if (fromEnv) return Buffer.from(fromEnv, 'base64');
  const path = join(home, 'secret.key');
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
}
