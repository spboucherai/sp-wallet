/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : tests/e2e/research-server.mts
 * Module           : tests
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

// Backend for research.spec.ts, in one process (scripts/lib/research-harness.mts): the real API on a scratch PostgreSQL
// database with synthetic candles, the BUILT web bundle, a stub signer that only answers GET /status, and the REAL research
// runner polling the API with its own secret and launching the deterministic FAKE agent under the OS sandbox. No model, no
// key, no network beyond loopback.
//
//   npx tsx tests/e2e/research-server.mts --port 8691 --db spw_v7_research_e2e_phone
import { resolve } from 'node:path';
import { ROOT, startResearchStack } from '../../scripts/lib/research-harness.mts';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1]! : d; };
const st = await startResearchStack({ port: Number(arg('port', '8691')), db: arg('db', 'spw_v7_research_e2e'), agent: 'fake', webDir: resolve(ROOT, 'dist/web'), bars: 1100,
  // test control (this harness only; behind the session and the CSRF check like every /api/ route): what the fake agent does next
  routes: (app, c) => { app.post('/api/v1/__e2e/fake-mode', async (req: { body: { mode: string } }) => { c.setFakeMode(String(req.body.mode)); return { ok: true }; }); } });
const agent = await st.addAgent('Momentum BTC/ETH', ['BTC', 'ETH']);
console.log(`READY ${st.origin} token ${st.token} agent ${agent}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void st.stop().finally(() => process.exit(0)); });
