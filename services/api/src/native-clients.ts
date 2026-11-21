/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/native-clients.ts
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

// Native clients (SP Wallet for macOS / iOS). The only thing the server does for them here is to publish WHICH Apple apps may
// use the passkeys of this relying party: the `webcredentials` association file that the operating system fetches (through
// Apple's CDN) before it lets an app with the Associated Domains entitlement ask for a passkey of `SPW_RP_ID`.
//
// What it grants: an app signed by the named team with the named bundle identifier may present the system passkey sheet for
// this domain. It grants nothing server-side — no session, no route, no signature: the assertion such an app obtains is an
// ordinary WebAuthn assertion (origin https://<rpId>), verified exactly as before by the API and by the signer.
//
// SPW_APPLE_APP_IDS: comma-separated `<TEAMID>.<bundle.id>`. Absent or empty: the route answers 404 (JSON) — never the HTML
// shell: Apple's CDN caches a non-JSON 200 as a failure for an hour.
import type { FastifyInstance } from 'fastify';

type Env = Record<string, string | undefined>;
const APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** The app identifiers of the environment: well-formed ones only, without duplicates, in the order given. */
export function appleAppIds(env: Env = process.env): string[] {
  const out: string[] = [];
  for (const raw of (env.SPW_APPLE_APP_IDS ?? '').split(',')) { const id = raw.trim(); if (APP_ID.test(id) && !out.includes(id)) out.push(id); }
  return out;
}

/** The association document, or null when no app is named. Only `webcredentials`: no universal link, no app clip. */
export function appleAppSiteAssociation(env: Env = process.env): { webcredentials: { apps: string[] } } | null {
  const apps = appleAppIds(env);
  return apps.length ? { webcredentials: { apps } } : null;
}

export function nativeClientRoutes(app: FastifyInstance, env: Env = process.env): void {
  // outside /api/: no session, no CSRF check (a GET fetched by Apple's servers); short public cache so a change is seen within the hour
  app.get('/.well-known/apple-app-site-association', async (_req, reply) => {
    const doc = appleAppSiteAssociation(env);
    if (!doc) return reply.status(404).header('cache-control', 'no-store').send({ error: 'not_found', message: 'not found' });
    return reply.header('content-type', 'application/json').header('cache-control', 'public, max-age=3600').send(doc);
  });
}
