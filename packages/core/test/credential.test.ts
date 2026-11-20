// NEXT — SPW-CRED-v2: the vectors the Swift clients reproduce (tests/native-vectors/SPW-CRED-v2.json, written by
// scripts/native-vectors.mts) are the bytes and hashes of the real functions. The rules of the object itself (field order,
// strictness, every field bound) are tested with the signer: services/isolated-signer/test/next-signer.test.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CRED_DOMAIN, CRED_MAX_TTL_SEC, credentialBytes, credentialHash, CredentialRequestSchema, toHex } from '../src/index.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../tests/native-vectors/SPW-CRED-v2.json', import.meta.url), 'utf8')) as { name: string; domain: string; object: unknown; canonicalHex: string; hashHex: string }[];

describe('SPW-CRED-v2 native vectors', () => {
  it('every vector is the output of the real canonical function, for both actions', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(5);
    expect(new Set(vectors.map((v) => (v.object as { action: string }).action))).toEqual(new Set(['add', 'revoke']));
    for (const v of vectors) {
      const r = CredentialRequestSchema.parse(v.object);
      expect(v.domain, v.name).toBe(CRED_DOMAIN);
      expect(toHex(credentialBytes(r)), v.name).toBe(v.canonicalHex);
      expect(toHex(credentialHash(r)), v.name).toBe(v.hashHex);
      expect(r.expiresAt - r.createdAt, v.name).toBeLessThanOrEqual(CRED_MAX_TTL_SEC);
    }
  });
  it('a revocation carries the public key field with an empty value: the layout never changes', () => {
    const rv = vectors.find((v) => v.name === 'revoke-no-public-key')!;
    expect(rv.object).not.toHaveProperty('publicKey');
    expect(rv.canonicalHex).toContain(`${Buffer.from([0, 9, 0, 0, 0, 0]).toString('hex')}${Buffer.from('publicKey').toString('hex')}${Buffer.from([0, 9]).toString('hex')}`); // name length 9, value length 0, then the next field
  });
});
