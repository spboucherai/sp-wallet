// SP Wallet isolated signer — CLI + daemon. Holds the only copy of signing keys.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { verifyAuditChain } from '@spw/core';
import dns from 'node:dns';
import net from 'node:net';
import { deriveKeys } from './keys.ts';
import { exchangePrices } from './prices.ts';
import { initKeystore, loadMnemonic } from './keystore.ts';
import { createSignerServer } from './server.ts';
import { Signer } from './signer.ts';
import { Store } from './store.ts';
import { thorVaults } from './vaults.ts';

const dir = process.env.SPW_SIGNER_DIR ?? join(homedir(), 'sp-wallet-signer-data');
const wrapKey = process.env.SPW_SIGNER_WRAP_KEY ?? join(homedir(), '.config', 'sp-wallet-signer', 'wrap.key');
const paths = { keystore: join(dir, 'keystore.json'), state: join(dir, 'state.json'), policy: join(dir, 'policy.json'), secret: join(dir, 'gateway.secret') };
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(2); } return v; };
process.umask(0o077);

const cmd = process.argv[2] ?? 'serve';
const open = () => {
  const keys = deriveKeys(loadMnemonic(paths.keystore, wrapKey));
  const store = new Store(paths.state, paths.policy);
  return { keys, store };
};

if (cmd === 'init') {
  initKeystore(paths.keystore, wrapKey);
  const { keys } = open();
  console.log(JSON.stringify({ ok: true, keyId: keys.keyId, addresses: keys.addresses }, null, 2));
  console.log('Keystore created. The recovery phrase was NOT displayed. Run `export-recovery` yourself in a private terminal and write it on paper.');
} else if (cmd === 'setup-token') {
  const { store } = open();
  if (store.state.credentials.length > 0) { console.error('a passkey is already enrolled; setup token refused'); process.exit(1); }
  const token = randomBytes(18).toString('base64url');
  store.state.setupTokenHash = createHash('sha256').update(token).digest('hex');
  store.log('setup_token.issued', {});
  store.save();
  console.log(token);
} else if (cmd === 'status') {
  const { keys, store } = open();
  const s = new Signer(keys, store, { rpId: 'unused', origin: 'unused' }).status();
  console.log(JSON.stringify({ ...s, journalIntact: verifyAuditChain(store.state.journal) === null }, null, 2));
} else if (cmd === 'halt' || cmd === 'unhalt') {
  const { store } = open();
  store.state.halted = cmd === 'halt';
  store.log(cmd === 'halt' ? 'halt.on' : 'halt.off', { via: 'cli' });
  store.save();
  console.log(`halted=${store.state.halted} (restart the signer daemon to apply)`);
} else if (cmd === 'reset-passkeys') {
  const { store } = open();
  store.state.credentials = [];
  store.log('credentials.reset', { via: 'cli' });
  store.save();
  console.log('all passkeys removed; issue a new setup-token and restart the daemon');
} else if (cmd === 'export-recovery') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error('export-recovery only runs in an interactive terminal (never piped, logged or run by an agent)'); process.exit(1); }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question('This prints the 24-word recovery phrase. Nobody is watching, no screen sharing, no AI session? Type SHOW: ');
  rl.close();
  if (a.trim() !== 'SHOW') process.exit(1);
  const words = loadMnemonic(paths.keystore, wrapKey).split(' ');
  console.log('\n' + words.map((w, k) => `${String(k + 1).padStart(2)}. ${w}`).join('\n') + '\n\nWrite it on paper, store it offline, then clear this terminal (Cmd-K).');
} else if (cmd === 'serve') {
  if (!existsSync(paths.keystore)) { console.error('no keystore: run `init` first'); process.exit(1); }
  const { keys, store } = open();
  const broken = verifyAuditChain(store.state.journal);
  if (broken !== null) { console.error(`signer journal hash chain broken at seq ${broken} — refusing to start`); process.exit(1); }
  const secret = existsSync(paths.secret) ? readFileSync(paths.secret, 'utf8').trim() : need('SPW_SIGNER_SECRET');
  // outbound HTTPS is used for one thing only: reading public exchange prices to check agent orders and live venue orders
  // (the signer never talks to a venue: it reads and signs payloads, the API sends them)
  dns.setDefaultResultOrder('ipv4first'); net.setDefaultAutoSelectFamilyAttemptTimeout(2500);
  const signer = new Signer(keys, store, { rpId: need('SPW_RP_ID'), origin: need('SPW_ORIGIN') }, undefined, exchangePrices(),
    thorVaults()); // second outbound use: asking independent THORNode operators whether a vault is genuine before signing a cross-chain swap (vaults.ts)
  const host = process.env.SPW_SIGNER_HOST ?? '127.0.0.1', port = Number(process.env.SPW_SIGNER_PORT ?? 8651);
  const allowed = (process.env.SPW_SIGNER_ALLOW_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  createSignerServer(signer, secret, allowed).listen(port, host, () => console.log(`signer ${keys.keyId} listening on ${host}:${port} halted=${store.state.halted}`));
  process.on('uncaughtException', (e) => { console.error('fatal:', e.message); process.exit(1); });
} else {
  console.error('usage: signer init | setup-token | status | serve | halt | unhalt | reset-passkeys | export-recovery');
  process.exit(2);
}
