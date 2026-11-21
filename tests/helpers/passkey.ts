/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/helpers/passkey.ts
 * Module           : tests
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
 *
 * Author           : Simon-Pierre Boucher
 * Position         : Professor of Finance
 * Institution      : Université du Québec en Outaouais (UQO)
 * Organization     : SP Boucher
 * Website          : https://spboucher.ai
 * Git              : https://git.spboucher.ai
 *
 * Preferred Contact: support@spboucher.ai
 * Development      : dev@spboucher.ai
 * Support          : support@spboucher.ai
 * Security/Admin   : admin@spboucher.ai
 *
 * Copyright (c) 2026
 * Simon-Pierre Boucher
 * All rights reserved where applicable. This file is governed by the
 * applicable project license, copyright notices and relevant law.
 * Existing third-party rights and notices remain unaffected.
 *
 * License          : None specified (no license file in this repository)
 *
 * Do not embed credentials, private keys, access tokens,
 * certificates or confidential personal information.
 *
 * =============================================================================
 * END OF SP BOUCHER SOURCE HEADER
 * =============================================================================
 */

// Software passkey for tests: produces real WebAuthn assertions (ES256) that the production verifier checks.
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

export class TestPasskey {
  readonly id: string;
  private priv: KeyObject;
  readonly publicKey: string; // COSE, base64url
  counter = 0;
  constructor(public rpId: string, public origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x!, 'base64url'), y = Buffer.from(jwk.y!, 'base64url');
    this.publicKey = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), x, Buffer.from('225820', 'hex'), y]).toString('base64url');
    this.id = createHash('sha256').update(x).digest().subarray(0, 20).toString('base64url');
  }
  /** WebAuthn registration response with attestation "none" (as produced by platform passkeys). */
  register(challengeB64u: string): any {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: challengeB64u, origin: this.origin, crossOrigin: false }));
    const credId = Buffer.from(this.id, 'base64url'), cose = Buffer.from(this.publicKey, 'base64url');
    const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
    const authData = Buffer.concat([createHash('sha256').update(this.rpId).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, cose]);
    const att = Buffer.concat([Buffer.from('a363666d74646e6f6e656761747453746d74a0686175746844617461', 'hex'), Buffer.from([0x58, authData.length]), authData]);
    return { id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: clientDataJSON.toString('base64url'), attestationObject: att.toString('base64url'), transports: ['internal'] } };
  }
  credential() { return { id: this.id, publicKey: this.publicKey, counter: 0, transports: ['internal'] }; }
  assert(challenge: Uint8Array, opts: { origin?: string; uv?: boolean } = {}): AuthenticationResponseJSON {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: Buffer.from(challenge).toString('base64url'), origin: opts.origin ?? this.origin, crossOrigin: false }));
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([createHash('sha256').update(this.rpId).digest(), Buffer.from([opts.uv === false ? 0x01 : 0x05]), ctr]);
    const sig = createSign('SHA256').update(Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()])).sign(this.priv);
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: sig.toString('base64url') },
    };
  }
}
