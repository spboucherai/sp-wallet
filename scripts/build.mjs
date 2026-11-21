/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/build.mjs
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-15
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

// Bundle each service into a single ESM file (no node_modules needed at runtime).
import { execSync } from 'node:child_process';
import { build } from 'esbuild';
// v6-alerts: the commit shown on the monitoring screen (SPW_COMMIT wins; empty when the build is not made from a git checkout)
let commit = process.env.SPW_COMMIT ?? '';
if (!commit) { try { commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a checkout */ } }
const define = { __SPW_COMMIT__: JSON.stringify(commit) };
const banner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };
for (const [entry, out] of [['services/api/src/main.ts', 'dist/api.mjs'], ['services/isolated-signer/src/main.ts', 'dist/signer.mjs'],
  ['services/research-runner/src/main.ts', 'dist/research-runner.mjs'], // v7: the research runner, a standalone bundle for a research node
  ['services/api/src/agent-worker-main.ts', 'dist/agents.mjs']]) // v11: the agent workers as their own process (optional: SPW_WORKERS=agents)
  await build({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', target: 'node24', format: 'esm', banner, define, legalComments: 'none', logLevel: 'info' });
