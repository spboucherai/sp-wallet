import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

interface KeystoreFile { v: 1; kdf: 'scrypt'; N: number; r: number; p: number; salt: string; iv: string; ct: string; tag: string }
const KDF = { N: 1 << 17, r: 8, p: 1 };

function kek(wrap: Buffer, salt: Buffer, k = KDF): Buffer {
  return scryptSync(wrap, salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: 512 * 1024 * 1024 });
}

function writePrivate(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600, flag: 'wx' }); // never overwrite existing key material
  chmodSync(path, 0o600);
}

/** Generate fresh 256-bit entropy on this machine and store it encrypted. Never returns or prints the secret. */
export function initKeystore(keystorePath: string, wrapKeyPath: string): void {
  if (existsSync(keystorePath) || existsSync(wrapKeyPath)) throw new Error('keystore or wrap key already exists — refusing to overwrite');
  const wrap = randomBytes(32), salt = randomBytes(16), iv = randomBytes(12);
  const entropy = randomBytes(32);
  const c = createCipheriv('aes-256-gcm', kek(wrap, salt), iv);
  const ct = Buffer.concat([c.update(entropy), c.final()]);
  const file: KeystoreFile = { v: 1, kdf: 'scrypt', ...KDF, salt: salt.toString('hex'), iv: iv.toString('hex'), ct: ct.toString('hex'), tag: c.getAuthTag().toString('hex') };
  writePrivate(wrapKeyPath, wrap.toString('hex') + '\n');
  writePrivate(keystorePath, JSON.stringify(file) + '\n');
  entropy.fill(0); wrap.fill(0);
}

/** Decrypt and return the mnemonic. Callers must keep it in memory only. */
export function loadMnemonic(keystorePath: string, wrapKeyPath: string): string {
  const f = JSON.parse(readFileSync(keystorePath, 'utf8')) as KeystoreFile;
  if (f.v !== 1 || f.kdf !== 'scrypt') throw new Error('unsupported keystore');
  const wrap = Buffer.from(readFileSync(wrapKeyPath, 'utf8').trim(), 'hex');
  if (wrap.length !== 32) throw new Error('bad wrap key');
  const d = createDecipheriv('aes-256-gcm', kek(wrap, Buffer.from(f.salt, 'hex'), f), Buffer.from(f.iv, 'hex'));
  d.setAuthTag(Buffer.from(f.tag, 'hex'));
  const entropy = Buffer.concat([d.update(Buffer.from(f.ct, 'hex')), d.final()]);
  const m = entropyToMnemonic(entropy, wordlist);
  entropy.fill(0);
  return m;
}

export const mnemonicIsValid = (m: string) => { try { mnemonicToEntropy(m, wordlist); return true; } catch { return false; } };
