// Records real mainnet data (read-only) used by the Cardano and Polkadot tests to prove the hand-written codecs on real
// transactions:  node scripts/record-cardano-polkadot-fixtures.mts
//   packages/core/test/fixtures/cardano-mainnet-txs.json      real transactions (CBOR) + what the Koios indexer says they contain
//   packages/core/test/fixtures/polkadot-asset-hub.json       runtime version, real Balances transfers (extrinsics), one block's events
//   packages/core/test/fixtures/polkadot-asset-hub-metadata.hex.gz   the runtime metadata (V14) the plugin was reviewed against
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const out = (name: string) => new URL(`../packages/core/test/fixtures/${name}`, import.meta.url);
const KOIOS = 'https://api.koios.rest/api/v1', DOT = 'https://polkadot-asset-hub-rpc.polkadot.io';
const post = async (url: string, body: unknown): Promise<any> => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); };
const rpc = async (method: string, params: unknown[] = []): Promise<any> => { const j = await post(DOT, { jsonrpc: '2.0', id: 1, method, params }); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };

// ---- Cardano: recent transactions of several shapes (tagged and untagged sets, legacy and map outputs, with and without native assets)
{
  const tip = (await (await fetch(KOIOS + '/tip')).json())[0];
  const picked: any[] = [], want = { tagged: 2, plain: 2, assets: 2, legacy: 1 }, have = { tagged: 0, plain: 0, assets: 0, legacy: 0 };
  for (let h = tip.block_no - 3; h > tip.block_no - 40 && picked.length < 7; h--) {
    const blocks = await (await fetch(`${KOIOS}/blocks?block_height=eq.${h}&select=hash`)).json();
    const hashes = (await post(KOIOS + '/block_txs', { _block_hashes: [blocks[0].hash] })).map((x: any) => x.tx_hash).slice(0, 30);
    if (hashes.length === 0) continue;
    const cbors = await post(KOIOS + '/tx_cbor', { _tx_hashes: hashes });
    const infos = await post(KOIOS + '/tx_info', { _tx_hashes: hashes, _inputs: true, _metadata: false, _assets: true, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false });
    for (const c of cbors) {
      const info = infos.find((x: any) => x.tx_hash === c.tx_hash);
      if (!info || c.cbor.length > 6000) continue;
      const tagged = /^84a[0-9a-f]00d90102/.test(c.cbor), assets = info.outputs.some((o: any) => o.asset_list.length > 0), legacy = /0181?8[1-9a-f]?82/.test(c.cbor.slice(0, 400)) && !tagged;
      const kind = assets ? 'assets' : tagged ? 'tagged' : 'plain';
      if (have[kind as keyof typeof have] >= want[kind as keyof typeof want]) continue;
      have[kind as keyof typeof have]++; void legacy;
      picked.push({ txid: c.tx_hash, block: info.block_height, cbor: c.cbor, fee: info.fee, ttl: info.invalid_after, size: info.tx_size,
        inputs: info.inputs.map((u: any) => `${u.tx_hash}#${u.tx_index}`).sort(),
        outputs: [...info.outputs].sort((a: any, b: any) => a.tx_index - b.tx_index).map((o: any) => ({ address: o.payment_addr.bech32, lovelace: o.value, assets: o.asset_list.length })) });
    }
  }
  writeFileSync(out('cardano-mainnet-txs.json'), JSON.stringify({ source: KOIOS, recordedAt: new Date().toISOString(), txs: picked }, null, 1) + '\n');
  console.log('cardano: recorded', picked.length, 'transactions', JSON.stringify(have));
}

// ---- Polkadot Asset Hub: metadata, runtime version, real signed Balances transfers and the events of their blocks
{
  const version = await rpc('state_getRuntimeVersion'), genesis = await rpc('chain_getBlockHash', [0]);
  const metadata: string = await rpc('state_getMetadata');
  writeFileSync(out('polkadot-asset-hub-metadata.hex.gz'), gzipSync(Buffer.from(metadata.slice(2), 'hex'), { level: 9 }));
  const head = parseInt((await rpc('chain_getHeader', [await rpc('chain_getFinalizedHead')])).number, 16);
  const EVENTS = '0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7';
  const transfers: any[] = [];
  for (let b = head; b > head - 1500 && transfers.length < 8; b--) {
    const hash = await rpc('chain_getBlockHash', [b]);
    const xts: string[] = (await rpc('chain_getBlock', [hash])).block.extrinsics;
    for (const [index, hex] of xts.entries()) {
      // signed v4, short, calling pallet 10 call 0 or 3 with an account-id destination
      if (hex.length > 420 || !/^0x[0-9a-f]{2,6}8400/.test(hex) || !/0a0[03]00[0-9a-f]{64}/.test(hex)) continue;
      const ev = transfers.some((t) => t.block === b) ? undefined : await rpc('state_getStorage', [EVENTS, hash]);
      transfers.push({ block: b, blockHash: hash, index, hex, ...(ev && ev.length < 60000 && transfers.filter((t) => t.events).length < 2 ? { events: ev } : {}) });
    }
  }
  writeFileSync(out('polkadot-asset-hub.json'), JSON.stringify({ source: DOT, recordedAt: new Date().toISOString(), genesis, version: { specName: version.specName, specVersion: version.specVersion, transactionVersion: version.transactionVersion }, transfers }, null, 1) + '\n');
  console.log('polkadot: metadata', (metadata.length - 2) / 2, 'bytes; spec', version.specVersion, 'tx', version.transactionVersion, '; recorded', transfers.length, 'transfers,', transfers.filter((t) => t.events).length, 'with events');
}
