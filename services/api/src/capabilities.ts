// V8 hardening — which OPTIONAL capabilities of this server are on, and WHY the others are off (the names of the variables
// that are missing — never a value). The API is restarted by hand; three variables are easy to forget (SPW_DERIV_LIVE_MAINNET,
// RESEARCH_DATABASE_URL, SPW_RESEARCH_RUNNER_SECRET) and nothing used to say so: mainnet trading or research jobs simply
// answered "disabled". The same list is logged in one line at start-up and shown on the monitoring screen.
// V11: the three derivative locks close NEW risk only — a cancel or a reduce-only close of what already exists is never behind
// them (exec.ts `blocked`, gmx-exec.ts `gate`), so a lock forgotten at a restart cannot strand an open position.
// Pure: reads an environment object; prints and returns variable NAMES and states only.
export interface Capability {
  id: string; on: boolean;
  /** variable names whose absence (or value) turns it off — names only */
  missing: string[];
  /** one sentence, no secret, no value of a secret */
  why: string;
}
type Env = Record<string, string | undefined>;
const isOn = (v: string | undefined): boolean => v === 'on';

export function capabilities(env: Env = process.env): Capability[] {
  const live = isOn(env.SPW_DERIV_LIVE_MAINNET), mandate = isOn(env.SPW_DERIV_MANDATE_MAINNET), gmx = isOn(env.SPW_DERIV_GMX_LIVE), secret = env.SPW_RESEARCH_RUNNER_SECRET ?? '';
  const off = (v: string | undefined): boolean => v === 'off';
  return [
    { id: 'deriv_live_mainnet', on: live, missing: live ? [] : ['SPW_DERIV_LIVE_MAINNET'], why: live ? 'live derivatives trading and collateral moves on mainnet are enabled'
      : 'SPW_DERIV_LIVE_MAINNET is not "on": NEW mainnet risk answers mainnet_disabled (orders that open or add, leverage changes, authorizations, collateral moves); cancels and reduce-only closes of existing orders and positions still work (testnet works)' },
    { id: 'deriv_mandate_mainnet', on: live && mandate, missing: [...(live ? [] : ['SPW_DERIV_LIVE_MAINNET']), ...(mandate ? [] : ['SPW_DERIV_MANDATE_MAINNET'])],
      why: live && mandate ? 'autonomous (mandate) trading on mainnet is enabled'
        : 'needs SPW_DERIV_LIVE_MAINNET=on AND SPW_DERIV_MANDATE_MAINNET=on: perp agents cannot go live on mainnet, and one already live can only reduce (its reduce-only orders and cancels still pass)' },
    // v8 GMX (added on main after the hardening branch was cut): the second server lock of GMX v2 trading; the third is the passkey-approved venue policy
    { id: 'deriv_gmx_live', on: live && gmx, missing: [...(live ? [] : ['SPW_DERIV_LIVE_MAINNET']), ...(gmx ? [] : ['SPW_DERIV_GMX_LIVE'])],
      why: live && gmx ? 'GMX v2 orders can be prepared on Arbitrum (each one still needs the venue policy and a passkey)'
        : 'needs SPW_DERIV_LIVE_MAINNET=on AND SPW_DERIV_GMX_LIVE=on: a NEW GMX position answers gmx_disabled / mainnet_disabled; closing a position and cancelling a pending order still work (reading works)' },
    // V11 market making: quoting on mainnet needs FOUR settings (and a quoting mandate approved with the passkey); testnet has its own
    { id: 'deriv_mm_mainnet', on: live && mandate && isOn(env.SPW_DERIV_MM_MAINNET) && isOn(env.SPW_TRADING_API_EXECUTION),
      missing: [...(live ? [] : ['SPW_DERIV_LIVE_MAINNET']), ...(mandate ? [] : ['SPW_DERIV_MANDATE_MAINNET']), ...(isOn(env.SPW_DERIV_MM_MAINNET) ? [] : ['SPW_DERIV_MM_MAINNET']), ...(isOn(env.SPW_TRADING_API_EXECUTION) ? [] : ['SPW_TRADING_API_EXECUTION'])],
      why: live && mandate && isOn(env.SPW_DERIV_MM_MAINNET) && isOn(env.SPW_TRADING_API_EXECUTION) ? 'market making: live on Hyperliquid mainnet is enabled (each session still needs a quoting mandate approved with the passkey)'
        : 'market making: live on Hyperliquid, off unless SPW_DERIV_LIVE_MAINNET, SPW_DERIV_MANDATE_MAINNET, SPW_DERIV_MM_MAINNET and SPW_TRADING_API_EXECUTION are all "on" and a quoting mandate is approved: a quote answers the code of the first setting that is off; cancels, reduce-only orders and the dead man\'s switch always pass (paper works)' },
    { id: 'deriv_mm_testnet', on: isOn(env.SPW_DERIV_MM_TESTNET) && isOn(env.SPW_TRADING_API_EXECUTION), missing: [...(isOn(env.SPW_DERIV_MM_TESTNET) ? [] : ['SPW_DERIV_MM_TESTNET']), ...(isOn(env.SPW_TRADING_API_EXECUTION) ? [] : ['SPW_TRADING_API_EXECUTION'])],
      why: isOn(env.SPW_DERIV_MM_TESTNET) && isOn(env.SPW_TRADING_API_EXECUTION) ? 'market making on Hyperliquid TESTNET is enabled (test funds; the owner\'s first go-live step)' : 'market making on Hyperliquid testnet needs SPW_DERIV_MM_TESTNET=on and SPW_TRADING_API_EXECUTION=on: a quote answers mm_testnet_disabled / execution_disabled; cancels and reductions pass' },
    { id: 'research_runner', on: secret.length >= 32, missing: secret.length >= 32 ? [] : ['SPW_RESEARCH_RUNNER_SECRET'],
      why: secret.length >= 32 ? 'the research runner routes accept the runner secret' : secret ? 'SPW_RESEARCH_RUNNER_SECRET is set but shorter than 32 characters: the runner routes answer 404, research jobs stay queued' : 'SPW_RESEARCH_RUNNER_SECRET is not set: the runner routes answer 404, research jobs stay queued' },
    { id: 'research_readonly_db', on: !!env.RESEARCH_DATABASE_URL, missing: env.RESEARCH_DATABASE_URL ? [] : ['RESEARCH_DATABASE_URL'],
      why: env.RESEARCH_DATABASE_URL ? 'backtest candles are read through the read-only role' : 'RESEARCH_DATABASE_URL is not set: backtest candles are read with the API\'s own database role (works, but not least privilege)' },
    { id: 'broadcast', on: !off(env.SPW_BROADCAST), missing: off(env.SPW_BROADCAST) ? ['SPW_BROADCAST'] : [], why: off(env.SPW_BROADCAST) ? 'SPW_BROADCAST=off: signed transactions are NOT relayed (test mode)' : 'signed transactions are relayed to the networks' },
    { id: 'workers', on: !off(env.SPW_WORKERS), missing: off(env.SPW_WORKERS) ? ['SPW_WORKERS'] : [], why: off(env.SPW_WORKERS) ? 'SPW_WORKERS=off: no background loop runs (no tracking, no engines, no alerts)' : 'background loops and agent engines run' },
    { id: 'strategy_sandbox_enforced', on: env.SPW_LAB_SANDBOX !== 'off', missing: env.SPW_LAB_SANDBOX === 'off' ? ['SPW_LAB_SANDBOX'] : [],
      why: env.SPW_LAB_SANDBOX === 'off' ? 'SPW_LAB_SANDBOX=off: strategy code runs WITHOUT OS confinement (development only)' : 'strategy code only runs inside the OS sandbox (see lab on the monitoring screen for its health)' },
    { id: 'web_app', on: !!env.SPW_WEB_DIR, missing: env.SPW_WEB_DIR ? [] : ['SPW_WEB_DIR'], why: env.SPW_WEB_DIR ? 'the web app is served by this process' : 'SPW_WEB_DIR is not set: this process serves the API only' },
  ];
}

/** One line for the log: `capabilities: a=on b=OFF(missing X) …` — names only. */
export function capabilitiesLine(caps: Capability[] = capabilities()): string {
  return `capabilities: ${caps.map((c) => (c.on ? `${c.id}=on` : `${c.id}=OFF(${c.missing.length ? `${c.id === 'broadcast' || c.id === 'workers' || c.id === 'strategy_sandbox_enforced' ? 'set off by' : 'missing'} ${c.missing.join('+')}` : 'off'})`)).join(' ')}`;
}
