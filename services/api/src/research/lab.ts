/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/research/lab.ts
 * Module           : research
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

// V7 research runtime — how the API runs the laboratory on anything that comes from a research job.
//
// A submitted strategy is code written by an AI agent. Before the owner has approved it, the API executes it only through
// this module. Since v8 it is a thin layer over agents/lab.ts — the same OS sandbox as EVERY process that runs strategy code
// (signals, backtests): no network of any kind, no fork, read access limited to the laboratory and the listed data, write
// access to one scratch directory, no database URL. FAIL CLOSED: without a working sandbox nothing runs (`code: null`, the
// evaluation is refused) unless the explicit development switch SPW_LAB_SANDBOX=off is set, and the result then says
// `sandbox: 'none'` (the UI shows a warning).
import { dropScratch, labExec, labStatus, lastLine, scratchDir } from '../agents/lab.ts';

export interface LabResult { code: number | null; out: string; err: string; sandbox: 'sandbox-exec' | 'none' }
export const labSandboxAvailable = async (): Promise<boolean> => (await labStatus()).ok;

/** Run `python -m <args>` of the laboratory. `scratch` is the only writable directory (and the cwd); `readable` are extra
 *  read-only paths (the job's data, a staging directory); `strategyDir` the one strategy directory it may read. Never throws. */
export function labRun(args: string[], o: { timeoutMs: number; scratch: string; readable?: string[]; strategyDir?: string }): Promise<LabResult> {
  return labExec(args, o).then((r) => ({ code: r.killed ? null : r.code, out: r.out, err: r.killed ? `${r.err}\nkilled: ${r.killed}` : r.err, sandbox: r.sandbox }),
    (e: Error) => ({ code: null, out: '', err: `could not start: ${e.message}`, sandbox: process.env.SPW_LAB_SANDBOX === 'off' ? 'none' as const : 'sandbox-exec' as const }));
}

export { dropScratch, lastLine, scratchDir };
