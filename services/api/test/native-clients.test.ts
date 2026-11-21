/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/native-clients.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-18
 * Last Modified    : 2026-11-18
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

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { appleAppIds, appleAppSiteAssociation, nativeClientRoutes } from '../src/native-clients.ts';

const MAC = '3YM54G49SN.ai.spboucher.spwallet', IOS = '3YM54G49SN.ai.spboucher.spwallet.ios';

describe('native clients — the passkey association file', () => {
  it('names only well-formed app identifiers, once each', () => {
    expect(appleAppIds({})).toEqual([]);
    expect(appleAppIds({ SPW_APPLE_APP_IDS: ` ${MAC}, ${IOS} ,${MAC},,` })).toEqual([MAC, IOS]);
    // a wildcard, a bare bundle id, a short team id or a path are not app identifiers
    expect(appleAppIds({ SPW_APPLE_APP_IDS: '*,ai.spboucher.spwallet,3YM54G49SN.*,ABC.ai.spboucher.x,3YM54G49SN.ai.spboucher/x' })).toEqual([]);
    expect(appleAppSiteAssociation({})).toBeNull();
    expect(appleAppSiteAssociation({ SPW_APPLE_APP_IDS: MAC })).toEqual({ webcredentials: { apps: [MAC] } });
  });

  it('is JSON when configured and a JSON 404 otherwise — never an HTML page', async () => {
    const on = Fastify(); nativeClientRoutes(on, { SPW_APPLE_APP_IDS: `${MAC},${IOS}` });
    const r = await on.inject({ method: 'GET', url: '/.well-known/apple-app-site-association' });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toContain('application/json');
    expect(r.json()).toEqual({ webcredentials: { apps: [MAC, IOS] } });
    expect(Object.keys(r.json())).toEqual(['webcredentials']); // no universal link, no app clip
    const off = Fastify(); nativeClientRoutes(off, {});
    const n = await off.inject({ method: 'GET', url: '/.well-known/apple-app-site-association' });
    expect(n.statusCode).toBe(404);
    expect(String(n.headers['content-type'])).toContain('application/json');
    await on.close(); await off.close();
  });
});
