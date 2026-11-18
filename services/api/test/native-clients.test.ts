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
