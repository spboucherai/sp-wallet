/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/research-runner/src/main.ts
 * Module           : services
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

// SP Wallet research runner — a standalone service for a research node. It is NOT part of the wallet API and shares no
// secret with it except its own runner secret. See docs/v7/RESEARCH-RUNTIME.md and services/research-runner/README.md.
import { existsSync } from 'node:fs';
import { httpApi } from './api-client.ts';
import { configFromEnv } from './config.ts';
import { sandboxAvailable } from './job.ts';
import { startRunner } from './runner.ts';

const cfg = configFromEnv();
// refuse to start with anything of the wallet in the environment: the runner must not be able to hand it to a job by mistake
for (const k of Object.keys(process.env)) if (/^SPW_SIGNER|^DATABASE_URL$|^RESEARCH_DATABASE_URL$|^SPW_ORIGIN$|^SPW_RP_ID$/.test(k)) throw new Error(`${k} is set: the research runner must not run with the wallet's environment`);
if (!existsSync(cfg.python)) throw new Error(`no laboratory interpreter at ${cfg.python}: run "uv sync --frozen" in the laboratory checkout`);
if (cfg.sandbox === 'required' && !sandboxAvailable()) throw new Error('sandbox-exec is not available on this machine; the runner refuses to start (SPW_RUNNER_SANDBOX=off runs jobs WITHOUT OS isolation and says so in every result)');
const stop = startRunner(cfg, httpApi(cfg));
console.log(`sp-wallet research runner "${cfg.runnerId}" → ${cfg.apiUrl}; agent=${cfg.agent.kind}; sandbox=${sandboxAvailable() ? 'sandbox-exec' : 'NONE'}; lab=${cfg.labDir} (${cfg.labPin})`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stop(); process.exit(0); });
