/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : scripts/cctp-pins.mts
 * Module           : scripts
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-10
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

// Read-only: prints what CCTP_ENABLED pins for each EVM network (proxy and implementation bytecode hashes, implementation
// addresses) together with who can change it (proxy admin, owner, attester manager, attesters). Run it to (re)review after
// Circle upgrades a contract:  node scripts/cctp-pins.mts [network…]
// Every value is read from BOTH registry RPC endpoints and must agree.
import { createHash } from 'node:crypto';
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { NETWORKS } from '@spw/core';

const MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64', MINTER = '0xfd78EE919681417d192449715b2594ab58f5D002';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const abi = parseAbi(['function owner() view returns (address)', 'function attesterManager() view returns (address)', 'function signatureThreshold() view returns (uint256)',
  'function getNumEnabledAttesters() view returns (uint256)', 'function getEnabledAttester(uint256) view returns (address)', 'function localDomain() view returns (uint32)', 'function version() view returns (uint32)',
  'function messageBodyVersion() view returns (uint32)', 'function localMinter() view returns (address)', 'function localMessageTransmitter() view returns (address)', 'function minFee() view returns (uint256)',
  'function paused() view returns (bool)', 'function pauser() view returns (address)', 'function denylister() view returns (address)', 'function feeRecipient() view returns (address)']);
const nets = process.argv.slice(2).length ? process.argv.slice(2) : ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche', 'hyperevm'];
let id = 0;
async function rpc<T>(net: string, method: string, params: unknown[]): Promise<T> {
  const out: string[] = [];
  for (const url of NETWORKS[net]!.rpc) {
    let last = '';
    for (let k = 0; k < 4; k++) {
      try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(15000) });
        const j = await r.json() as { result?: T; error?: { message: string } }; if (j.error) { last = `ERR ${j.error.message}`; if (/revert/i.test(last)) break; } else { last = JSON.stringify(j.result); break; } }
      catch (e) { last = `ERR ${(e as Error).message}`; }
      await new Promise((r) => setTimeout(r, 800));
    }
    out.push(last);
  }
  if (out.some((o) => o !== out[0])) throw new Error(`${net} ${method}: endpoints disagree: ${out.join(' | ').slice(0, 300)}`);
  if (out[0]!.startsWith('ERR')) throw new Error(`${net} ${method}: ${out[0]}`);
  return JSON.parse(out[0]!) as T;
}
const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex.slice(2), 'hex')).digest('hex');
const addr = (word: string) => '0x' + word.slice(26);
const call = async (net: string, to: string, fn: string, args: unknown[] = []) => decodeFunctionResult({ abi, functionName: fn as never, data: await rpc<`0x${string}`>(net, 'eth_call', [{ to, data: encodeFunctionData({ abi, functionName: fn as never, args: args as never }) }, 'latest']) }) as unknown;
const tryCall = (net: string, to: string, fn: string, args: unknown[] = []) => call(net, to, fn, args).catch(() => 'n/a');

for (const net of nets) {
  const o: Record<string, unknown> = { network: net };
  for (const [name, a] of [['messenger', MESSENGER], ['transmitter', TRANSMITTER]] as const) {
    const code = await rpc<string>(net, 'eth_getCode', [a, 'latest']);
    const impl = addr(await rpc<string>(net, 'eth_getStorageAt', [a, IMPL_SLOT, 'latest'])), admin = addr(await rpc<string>(net, 'eth_getStorageAt', [a, ADMIN_SLOT, 'latest']));
    const implCode = await rpc<string>(net, 'eth_getCode', [impl, 'latest']);
    o[name] = { proxyBytes: (code.length - 2) / 2, proxySha256: sha(code), impl, implBytes: (implCode.length - 2) / 2, implSha256: sha(implCode), proxyAdmin: admin, adminIsContract: (await rpc<string>(net, 'eth_getCode', [admin, 'latest'])) !== '0x', owner: await tryCall(net, a, 'owner') };
  }
  const minterCode = await rpc<string>(net, 'eth_getCode', [MINTER, 'latest']);
  o.minter = { bytes: (minterCode.length - 2) / 2, sha256: sha(minterCode), implSlot: await rpc<string>(net, 'eth_getStorageAt', [MINTER, IMPL_SLOT, 'latest']), owner: await tryCall(net, MINTER, 'owner') };
  const n = Number(await call(net, TRANSMITTER, 'getNumEnabledAttesters'));
  const attesters: unknown[] = []; for (let k = 0; k < n; k++) attesters.push(await call(net, TRANSMITTER, 'getEnabledAttester', [BigInt(k)]));
  o.wiring = { localDomain: await call(net, TRANSMITTER, 'localDomain'), version: await call(net, TRANSMITTER, 'version'), bodyVersion: await call(net, MESSENGER, 'messageBodyVersion'),
    localMinter: await call(net, MESSENGER, 'localMinter'), localMessageTransmitter: await call(net, MESSENGER, 'localMessageTransmitter'), minFee: String(await tryCall(net, MESSENGER, 'minFee')),
    attesterManager: await call(net, TRANSMITTER, 'attesterManager'), signatureThreshold: String(await call(net, TRANSMITTER, 'signatureThreshold')), attesters,
    paused: await tryCall(net, TRANSMITTER, 'paused'), pauser: await tryCall(net, TRANSMITTER, 'pauser'), denylister: await tryCall(net, MESSENGER, 'denylister'), feeRecipient: await tryCall(net, MESSENGER, 'feeRecipient') };
  console.log(JSON.stringify(o, null, 1));
}
