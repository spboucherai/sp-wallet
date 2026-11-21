/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/test/hardening-e.test.ts
 * Module           : services
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-17
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

// V8 hardening (E): the start-up summary of optional capabilities (variable NAMES only, never a value) and the heartbeat of
// the agent engines in loopStats. Pure / in-memory: no database.
import { describe, expect, it } from 'vitest';
import { capabilities, capabilitiesLine } from '../src/capabilities.ts';
import { engineLoop, enginePassFailure, loopStats } from '../src/loop-stats.ts';

const SECRET = 's3cr3t-value-that-must-never-be-printed-0123456789';
describe('optional capabilities', () => {
  it('says which are on and names the missing variable for the others — and never prints a value', () => {
    const none = capabilities({});
    const by = Object.fromEntries(none.map((c) => [c.id, c]));
    expect(by.deriv_live_mainnet).toMatchObject({ on: false, missing: ['SPW_DERIV_LIVE_MAINNET'] });
    expect(by.deriv_mandate_mainnet).toMatchObject({ on: false, missing: ['SPW_DERIV_LIVE_MAINNET', 'SPW_DERIV_MANDATE_MAINNET'] });
    expect(by.deriv_gmx_live).toMatchObject({ on: false, missing: ['SPW_DERIV_LIVE_MAINNET', 'SPW_DERIV_GMX_LIVE'] });
    // V11 market making: off unless four settings are on (mainnet) / two (testnet); the summary line says so
    expect(by.deriv_mm_mainnet).toMatchObject({ on: false, missing: ['SPW_DERIV_LIVE_MAINNET', 'SPW_DERIV_MANDATE_MAINNET', 'SPW_DERIV_MM_MAINNET', 'SPW_TRADING_API_EXECUTION'] });
    expect(by.deriv_mm_mainnet!.why).toMatch(/^market making: live on Hyperliquid, off unless .* a quoting mandate is approved/);
    expect(by.deriv_mm_testnet).toMatchObject({ on: false, missing: ['SPW_DERIV_MM_TESTNET', 'SPW_TRADING_API_EXECUTION'] });
    expect(capabilities({ SPW_DERIV_LIVE_MAINNET: 'on', SPW_DERIV_MANDATE_MAINNET: 'on', SPW_DERIV_MM_MAINNET: 'on', SPW_TRADING_API_EXECUTION: 'on' }).find((c) => c.id === 'deriv_mm_mainnet')!.on).toBe(true);
    expect(capabilities({ SPW_DERIV_LIVE_MAINNET: 'on', SPW_DERIV_MANDATE_MAINNET: 'on', SPW_DERIV_MM_MAINNET: 'on' }).find((c) => c.id === 'deriv_mm_mainnet')).toMatchObject({ on: false, missing: ['SPW_TRADING_API_EXECUTION'] });
    // V11 final validation: EVERY execution lock is in the line — the plain trading-API one too (it was on the Risk screen only)
    expect(by.trading_api_execution).toMatchObject({ on: false, missing: ['SPW_TRADING_API_EXECUTION'] });
    expect(by.trading_api_execution!.why).toMatch(/execution_disabled.*cancels and strictly reducing orders still pass/);
    expect(capabilities({ SPW_TRADING_API_EXECUTION: 'on' }).find((c) => c.id === 'trading_api_execution')).toMatchObject({ on: true, missing: [] });
    expect(capabilities({ SPW_TRADING_API_EXECUTION: 'true' }).find((c) => c.id === 'trading_api_execution')!.on).toBe(false);   // only "on", as orders/index.ts reads it
    expect(capabilitiesLine(capabilities({ SPW_TRADING_API_EXECUTION: 'on' }))).toContain(' trading_api_execution=on ');
    for (const lock of ['SPW_DERIV_LIVE_MAINNET', 'SPW_DERIV_MANDATE_MAINNET', 'SPW_DERIV_GMX_LIVE', 'SPW_TRADING_API_EXECUTION', 'SPW_DERIV_MM_MAINNET', 'SPW_DERIV_MM_TESTNET', 'SPW_BROADCAST']) expect(none.some((c) => c.missing.includes(lock)) || lock === 'SPW_BROADCAST', lock).toBe(true);
    expect(by.research_runner).toMatchObject({ on: false, missing: ['SPW_RESEARCH_RUNNER_SECRET'] });
    expect(by.research_readonly_db).toMatchObject({ on: false, missing: ['RESEARCH_DATABASE_URL'] });
    expect(by.broadcast!.on).toBe(true); expect(by.workers!.on).toBe(true); expect(by.strategy_sandbox_enforced!.on).toBe(true);
    const line = capabilitiesLine(none);
    expect(line).toMatch(/^capabilities: deriv_live_mainnet=OFF\(missing SPW_DERIV_LIVE_MAINNET\) deriv_mandate_mainnet=OFF\(missing SPW_DERIV_LIVE_MAINNET\+SPW_DERIV_MANDATE_MAINNET\) deriv_gmx_live=OFF\(missing SPW_DERIV_LIVE_MAINNET\+SPW_DERIV_GMX_LIVE\) trading_api_execution=OFF\(missing SPW_TRADING_API_EXECUTION\) deriv_mm_mainnet=OFF\(missing SPW_DERIV_LIVE_MAINNET\+SPW_DERIV_MANDATE_MAINNET\+SPW_DERIV_MM_MAINNET\+SPW_TRADING_API_EXECUTION\) deriv_mm_testnet=OFF\(missing SPW_DERIV_MM_TESTNET\+SPW_TRADING_API_EXECUTION\) research_runner=OFF\(missing SPW_RESEARCH_RUNNER_SECRET\) research_readonly_db=OFF\(missing RESEARCH_DATABASE_URL\) broadcast=on workers=on strategy_sandbox_enforced=on/);
    expect(line.split('\n')).toHaveLength(1);

    const env = { SPW_DERIV_LIVE_MAINNET: 'on', SPW_DERIV_MANDATE_MAINNET: 'on', SPW_DERIV_GMX_LIVE: 'on', SPW_RESEARCH_RUNNER_SECRET: SECRET, RESEARCH_DATABASE_URL: `postgres://reader:${SECRET}@db/sp_wallet`, SPW_BROADCAST: 'off', SPW_LAB_SANDBOX: 'off', SPW_WEB_DIR: '/srv/web' };
    const all = capabilities(env), text = JSON.stringify(all) + capabilitiesLine(all);
    expect(all.filter((c) => c.on).map((c) => c.id)).toEqual(['deriv_live_mainnet', 'deriv_mandate_mainnet', 'deriv_gmx_live', 'research_runner', 'research_readonly_db', 'workers', 'web_app', 'nft_inventory', 'nft_solana_das', 'nft_transfer']); // + the NFT rows (nft/config.ts): read-only inventory and DAS probing are on by default
    expect(text).not.toContain(SECRET); expect(text).not.toContain('reader'); expect(text).not.toContain('/srv/web');
    expect(capabilitiesLine(all)).toMatch(/broadcast=OFF\(set off by SPW_BROADCAST\).*strategy_sandbox_enforced=OFF\(set off by SPW_LAB_SANDBOX\)/);
  });
  it('a runner secret that is too short is off, and the reason says so without the secret', () => {
    const c = capabilities({ SPW_RESEARCH_RUNNER_SECRET: 'short-secret' }).find((x) => x.id === 'research_runner')!;
    expect(c.on).toBe(false); expect(c.why).toMatch(/shorter than 32/); expect(c.why).not.toContain('short-secret');
    // GMX needs BOTH server locks (main's gmx-exec reads the same two variables)
    expect(capabilities({ SPW_DERIV_GMX_LIVE: 'on' }).find((x) => x.id === 'deriv_gmx_live')).toMatchObject({ on: false, missing: ['SPW_DERIV_LIVE_MAINNET'] });
    expect(capabilities({ SPW_DERIV_LIVE_MAINNET: 'on' }).find((x) => x.id === 'deriv_gmx_live')).toMatchObject({ on: false, missing: ['SPW_DERIV_GMX_LIVE'] });
    expect(capabilities({ SPW_DERIV_LIVE_MAINNET: 'true' }).find((x) => x.id === 'deriv_live_mainnet')!.on).toBe(false);   // only "on" turns it on, as in the code that reads it
  });
});

describe('agent engines — heartbeat', () => {
  it('a pass fails when it throws or when every agent ended in an error; one healthy agent is enough', () => {
    expect(enginePassFailure({})).toBeNull();
    expect(enginePassFailure({ a: 'held', b: 'error: x' })).toBeNull();
    expect(enginePassFailure({ a: 'error: signal runner could not start', b: 'backing off after an error' })).toBe('error: signal runner could not start');
    expect(enginePassFailure({ a: 'backing off after an error' })).toBe('backing off after an error');
  });
  it('engineLoop registers in loopStats, counts failures in a row, resets on success, and unregisters on stop', async () => {
    let n = 0;
    const stop = engineLoop('test-engine', 10, async () => { n += 1; if (n === 2) throw new Error('boom'); return n <= 4 ? { a: 'error: cannot reach the signal runner' } : { a: 'no order: targets reached' }; });
    const st = loopStats.get('test-engine')!;
    expect(st).toMatchObject({ name: 'test-engine', everyMs: 10, runs: 0, failures: 0, lastOkAt: null });
    for (let i = 0; i < 200 && st.failures < 4; i++) await new Promise((r) => setTimeout(r, 5));
    expect(st.failures).toBe(4); expect(st.lastOkAt).toBeNull(); expect(st.lastError).toMatch(/cannot reach the signal runner|boom/);
    for (let i = 0; i < 200 && st.failures !== 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(st.failures).toBe(0); expect(st.lastOkAt).not.toBeNull(); expect(st.runs).toBeGreaterThanOrEqual(5);
    stop();
    expect(loopStats.has('test-engine')).toBe(false);
  });
  it('the real engines use it: both names are registered by their starters', async () => {
    const src = (f: string) => import('node:fs').then((fs) => fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
    expect(await src('../src/agents/live.ts')).toMatch(/engineLoop\('agent-engine', everyMs, \(\) => enginePass\(m\)\)/);
    expect(await src('../src/agents/perp-live.ts')).toMatch(/engineLoop\('perp-agent-engine', everyMs, \(\) => perpEnginePass\(\)\)/);
  });
});
