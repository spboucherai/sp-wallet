const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined || v === '') throw new Error(`missing env ${k}`); return v; };
export const config = {
  origin: env('SPW_ORIGIN'),
  rpId: env('SPW_RP_ID'),
  port: Number(env('PORT', '8650')),
  host: env('HOST', '127.0.0.1'),
  databaseUrl: env('DATABASE_URL'),
  signerUrl: env('SPW_SIGNER_URL', 'http://127.0.0.1:8651'),
  signerSecret: env('SPW_SIGNER_SECRET'),
  trustProxy: (process.env.SPW_TRUST_PROXY ?? '127.0.0.1').split(',').map((x) => x.trim()),
  webDir: process.env.SPW_WEB_DIR ?? '',
  /** tests only: never relay signed bytes to a network */
  broadcast: env('SPW_BROADCAST', 'on') === 'on',
  /** SPW_WORKERS: `on` (default — every background worker in this process, the agent runtime included), `off`, `api` (every worker
   *  EXCEPT the agent runtime: a separate `sp-wallet-agents` process runs it) — `agents` is the value of that separate process
   *  (agent-worker-main.ts) and starts none of the API's workers */
  workers: ['on', 'api'].includes(env('SPW_WORKERS', 'on')),
  agentWorkers: ['on', 'agents'].includes(env('SPW_WORKERS', 'on')),
};
export const secureCookies = config.origin.startsWith('https://');
export class UserError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }
