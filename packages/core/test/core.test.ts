import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { address as kitAddress, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { parseTransaction, decodeFunctionData, erc20Abi } from 'viem';
import { base58 } from '@scure/base';
import {
  appendAudit, associatedTokenAddress, assertTransition, buildBtcTx, buildEvmTx, buildSolMessage, canonicalBytes, canTransition,
  checkPolicy, DEFAULT_POLICY, formatUnits, getAsset, intentHash, normalizeAddress, parseUnits, serializeEvmUnsigned, toHex,
  verifyAuditChain, NETWORKS, type AuditRecord, type Intent,
} from '../src/index.ts';

const now = 1_800_000_000;
const base = { v: 1 as const, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a11', keyId: 'spw-0123456789abcdef', createdAt: now, expiresAt: now + 120, policyVersion: 2 };
const USDC_BASE = NETWORKS.base.tokens[0]!.id, USDC_SOL = NETWORKS.solana.tokens[0]!.id;
const evmIntent: Intent = { ...base, network: 'base', chainRef: '8453', asset: USDC_BASE, symbol: 'USDC', decimals: 6, amount: '12500000',
  from: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', maxFee: '100000000000000',
  evm: { nonce: 3, gasLimit: '90000', maxFeePerGas: '1000000000', maxPriorityFeePerGas: '1000000' } };
const solIntent: Intent = { ...base, network: 'solana', chainRef: NETWORKS.solana.chainRef, asset: USDC_SOL, symbol: 'USDC', decimals: 6, amount: '10000000',
  from: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', to: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', maxFee: '100000',
  sol: { recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 1000, createAta: true, computeUnitLimit: 60000, computeUnitPrice: '10000' } };
const btcIntent: Intent = { ...base, network: 'bitcoin', chainRef: NETWORKS.bitcoin.chainRef, asset: 'native', symbol: 'BTC', decimals: 8, amount: '20000',
  from: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', to: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', maxFee: '2000',
  btc: { inputs: [{ txid: 'aa'.repeat(32), vout: 1, value: '50000' }], change: '29500', fee: '500' } };

describe('amounts', () => {
  it('parses and formats exactly', () => {
    expect(parseUnits('12.5', 6)).toBe(12_500_000n);
    expect(parseUnits('0,000001', 6)).toBe(1n);
    expect(formatUnits(12_500_000n, 6)).toBe('12.5');
    expect(() => parseUnits('1.0000001', 6)).toThrow();
    expect(() => parseUnits('-1', 6)).toThrow();
    expect(() => parseUnits('1e3', 6)).toThrow();
    expect(() => parseUnits('', 6)).toThrow();
  });
  it('round-trips (property)', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 1n << 190n }), fc.integer({ min: 0, max: 18 }), (v, d) => parseUnits(formatUnits(v, d), d) === v));
  });
});

describe('addresses', () => {
  it('EVM checksum', () => {
    expect(normalizeAddress('base', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8')).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(() => normalizeAddress('base', '0x70997970C51812dc3A010C7d01b50e0d17dc79c8')).toThrow(); // bad checksum
    expect(() => normalizeAddress('base', '0x0000000000000000000000000000000000000000')).toThrow();
    expect(() => normalizeAddress('base', 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk')).toThrow();
  });
  it('BTC and Solana', () => {
    expect(normalizeAddress('bitcoin', 'BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ')).toBe('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
    expect(() => normalizeAddress('bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdx')).toThrow();
    expect(() => normalizeAddress('bitcoin', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')).toThrow();
    expect(normalizeAddress('solana', solIntent.to)).toBe(solIntent.to);
    expect(() => normalizeAddress('solana', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8')).toThrow();
  });
  it('token identity is by address only', () => {
    expect(getAsset('base', USDC_BASE.toLowerCase()).symbol).toBe('USDC');
    expect(() => getAsset('base', NETWORKS.ethereum.tokens[0]!.id)).toThrow();
    expect(() => getAsset('base', 'USDC')).toThrow();
  });
});

describe('canonical intent hash', () => {
  it('is stable and independent of JSON key order', () => {
    const shuffled = Object.fromEntries(Object.entries(evmIntent).reverse()) as Intent;
    expect(toHex(intentHash(shuffled))).toBe(toHex(intentHash(evmIntent)));
  });
  it('changes when any material field changes', () => {
    const h = toHex(intentHash(evmIntent));
    const muts: Intent[] = [
      { ...evmIntent, amount: '12500001' }, { ...evmIntent, to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' },
      { ...evmIntent, network: 'arbitrum', chainRef: '42161' }, { ...evmIntent, asset: 'native' }, { ...evmIntent, maxFee: '100000000000001' },
      { ...evmIntent, expiresAt: now + 121 }, { ...evmIntent, proposalId: '6f1c1f0e-8f5f-4b1e-9c56-0d6b5f0f1a12' }, { ...evmIntent, keyId: 'spw-0123456789abcdee' },
      { ...evmIntent, evm: { ...evmIntent.evm!, nonce: 4 } }, { ...evmIntent, evm: { ...evmIntent.evm!, gasLimit: '90001' } },
      { ...evmIntent, evm: { ...evmIntent.evm!, maxFeePerGas: '1000000001' } }, { ...evmIntent, policyVersion: 3 }, { ...evmIntent, decimals: 18 },
    ];
    const hs = new Set(muts.map((m) => toHex(intentHash(m))));
    expect(hs.size).toBe(muts.length);
    expect(hs.has(h)).toBe(false);
  });
  it('field boundaries cannot be shifted', () => {
    const a = canonicalBytes({ ...evmIntent, symbol: 'USDC', keyId: 'spw-0123456789abcdef' });
    const b = canonicalBytes({ ...evmIntent, symbol: 'USD', keyId: 'spw-0123456789abcdefC' });
    expect(toHex(a)).not.toBe(toHex(b));
  });
  it('rejects unknown fields and mismatched sections', () => {
    expect(() => intentHash({ ...evmIntent, extra: 1 } as never)).toThrow();
    expect(() => intentHash({ ...evmIntent, evm: undefined, sol: solIntent.sol })).toThrow();
  });
});

describe('EVM builder', () => {
  it('builds exactly an ERC-20 transfer to the allowlisted USDC', () => {
    const tx = parseTransaction(serializeEvmUnsigned(evmIntent));
    expect(tx.chainId).toBe(8453);
    expect(tx.to?.toLowerCase()).toBe(USDC_BASE.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n);
    const d = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect(d.functionName).toBe('transfer');
    expect(d.args).toEqual([evmIntent.to, 12_500_000n]);
  });
  it('fails closed', () => {
    expect(() => buildEvmTx({ ...evmIntent, asset: '0xdAC17F958D2ee523a2206206994597C13D831ec7' })).toThrow(/allowlisted/);
    expect(() => buildEvmTx({ ...evmIntent, chainRef: '1' })).toThrow();
    expect(() => buildEvmTx({ ...evmIntent, maxFee: '1' })).toThrow(/fee/);
    expect(() => buildEvmTx({ ...evmIntent, decimals: 18 })).toThrow();
    expect(() => buildEvmTx({ ...evmIntent, to: USDC_BASE })).toThrow();
    expect(() => buildEvmTx({ ...evmIntent, asset: 'native', symbol: 'ETH', decimals: 18 })).toThrow(/21000/);
  });
});

describe('Solana builder (cross-checked against @solana/kit)', () => {
  it('derives the same associated token accounts as the SDK', async () => {
    for (const owner of [solIntent.from, solIntent.to, 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg']) {
      const [pda] = await findAssociatedTokenPda({ owner: kitAddress(owner), mint: kitAddress(USDC_SOL), tokenProgram: TOKEN_PROGRAM_ADDRESS });
      expect(associatedTokenAddress(owner, USDC_SOL)).toBe(pda);
    }
  });
  it('message decodes to the fixed instruction set', () => {
    const m = getCompiledTransactionMessageDecoder().decode(buildSolMessage(solIntent)) as any;
    expect(m.version).toBe('legacy');
    expect(m.header).toEqual({ numSignerAccounts: 1, numReadonlySignerAccounts: 0, numReadonlyNonSignerAccounts: 6 });
    expect(m.staticAccounts[0]).toBe(solIntent.from);
    expect(m.lifetimeToken).toBe(solIntent.sol!.recentBlockhash);
    const progs = m.instructions.map((ix: any) => m.staticAccounts[ix.programAddressIndex]);
    expect(progs).toEqual(['ComputeBudget111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']);
    const xfer = m.instructions[3];
    const accts = xfer.accountIndices.map((k: number) => m.staticAccounts[k]);
    expect(accts).toEqual([associatedTokenAddress(solIntent.from, USDC_SOL), USDC_SOL, associatedTokenAddress(solIntent.to, USDC_SOL), solIntent.from]);
    const data = Buffer.from(xfer.data);
    expect(data[0]).toBe(12);
    expect(data.readBigUInt64LE(1)).toBe(10_000_000n);
    expect(data[9]).toBe(6);
  });
  it('native transfer + fail-closed cases', () => {
    const n: Intent = { ...solIntent, asset: 'native', symbol: 'SOL', decimals: 9, amount: '1000000', sol: { ...solIntent.sol!, createAta: false } };
    const m = getCompiledTransactionMessageDecoder().decode(buildSolMessage(n)) as any;
    expect(m.instructions.length).toBe(3);
    expect(Buffer.from(m.instructions[2].data).readBigUInt64LE(4)).toBe(1_000_000n);
    expect(() => buildSolMessage({ ...solIntent, to: solIntent.from })).toThrow();
    expect(() => buildSolMessage({ ...solIntent, to: USDC_SOL })).toThrow();
    expect(() => buildSolMessage({ ...solIntent, asset: 'So11111111111111111111111111111111111111112' })).toThrow(/allowlisted/);
    expect(() => buildSolMessage({ ...solIntent, maxFee: '5000' })).toThrow(/fee/);
    expect(base58.decode(solIntent.to).length).toBe(32);
  });
});

describe('registry (wave 1: more networks and tokens)', () => {
  it('every listed asset has a signer limit and every network a fee ceiling; nothing is sendable by default otherwise', () => {
    for (const n of Object.values(NETWORKS)) {
      expect(DEFAULT_POLICY.maxFee[n.id], n.id).toBeDefined();
      for (const a of [n.native, ...n.tokens]) expect(BigInt(DEFAULT_POLICY.perTx[`${n.id}:${a.symbol}`] ?? '0') > 0n, `${n.id}:${a.symbol}`).toBe(true);
      expect(new Set(n.tokens.map((t) => t.id.toLowerCase())).size).toBe(n.tokens.length); // no duplicate contracts
      expect(new Set(n.tokens.map((t) => t.symbol)).size).toBe(n.tokens.length); // one contract per ticker per network
    }
    expect(Object.keys(NETWORKS).length).toBeGreaterThanOrEqual(10);
  });
  it('EVM token addresses are checksummed and chain ids are distinct', () => {
    const ids = Object.values(NETWORKS).filter((n) => n.family === 'evm').map((n) => n.chainRef);
    expect(new Set(ids).size).toBe(ids.length);
    for (const n of Object.values(NETWORKS)) if (n.family === 'evm') for (const t of n.tokens) expect(normalizeAddress(n.id, t.id)).toBe(t.id);
  });
  it('builds transfers on the new EVM networks with their own chain id', () => {
    for (const [net, chain] of [['optimism', 10], ['bsc', 56], ['avalanche', 43114], ['hyperevm', 999]] as const) {
      const n = NETWORKS[net];
      const tx = parseTransaction(serializeEvmUnsigned({ ...evmIntent, network: net, chainRef: n.chainRef, asset: 'native', symbol: n.native.symbol, decimals: 18, amount: '1000', evm: { ...evmIntent.evm!, gasLimit: '21000' } }));
      expect(tx.chainId).toBe(chain);
      expect(() => buildEvmTx({ ...evmIntent, network: net, chainRef: '1' })).toThrow();
    }
  });
  it('Token-2022 mints use the Token-2022 program for the instruction and the token-account derivation', async () => {
    const py = NETWORKS.solana.tokens.find((t) => t.symbol === 'PYUSD')!;
    expect(py.program).toBe('token2022');
    const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    const [pda] = await findAssociatedTokenPda({ owner: kitAddress(solIntent.from), mint: kitAddress(py.id), tokenProgram: kitAddress(T22) });
    expect(associatedTokenAddress(solIntent.from, py.id, T22)).toBe(pda);
    const m = getCompiledTransactionMessageDecoder().decode(buildSolMessage({ ...solIntent, asset: py.id, symbol: 'PYUSD', decimals: py.decimals })) as any;
    const progs = m.instructions.map((ix: any) => m.staticAccounts[ix.programAddressIndex]);
    expect(progs.slice(2)).toEqual(['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', T22]);
    expect(m.staticAccounts).not.toContain('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(m.instructions[3].accountIndices.map((k: number) => m.staticAccounts[k])[0]).toBe(pda);
  });
});

describe('Bitcoin builder', () => {
  it('balances inputs, outputs and fee', () => {
    const tx = buildBtcTx(btcIntent);
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(2);
    expect(tx.getOutput(0).amount).toBe(20000n);
    expect(tx.getOutput(1).amount).toBe(29500n);
  });
  it('fails closed', () => {
    expect(() => buildBtcTx({ ...btcIntent, btc: { ...btcIntent.btc!, fee: '501' } })).toThrow(/inputs/);
    expect(() => buildBtcTx({ ...btcIntent, maxFee: '100' })).toThrow(/fee/);
    expect(() => buildBtcTx({ ...btcIntent, amount: '100', btc: { ...btcIntent.btc!, change: '49400' } })).toThrow(/dust/);
    expect(() => buildBtcTx({ ...btcIntent, btc: { ...btcIntent.btc!, inputs: [btcIntent.btc!.inputs[0]!, btcIntent.btc!.inputs[0]!] } })).toThrow(/duplicate/);
    expect(() => buildBtcTx({ ...btcIntent, from: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' })).toThrow(/SegWit/);
  });
});

describe('policy', () => {
  it('defaults deny unknown assets and enforce limits', () => {
    expect(checkPolicy(DEFAULT_POLICY, evmIntent, 0n, now, false)).toEqual({ ok: true });
    expect(checkPolicy(DEFAULT_POLICY, evmIntent, 0n, now, true).ok).toBe(false);
    expect(checkPolicy(DEFAULT_POLICY, { ...evmIntent, amount: '50000001' }, 0n, now, false).ok).toBe(false);
    expect(checkPolicy(DEFAULT_POLICY, evmIntent, 90_000_000n, now, false).ok).toBe(false);
    expect(checkPolicy(DEFAULT_POLICY, evmIntent, 0n, now + 121, false).ok).toBe(false);
    expect(checkPolicy(DEFAULT_POLICY, { ...evmIntent, expiresAt: now + 3600 }, 0n, now, false).ok).toBe(false);
    expect(checkPolicy(DEFAULT_POLICY, { ...evmIntent, symbol: 'DAI' }, 0n, now, false).ok).toBe(false);
    expect(checkPolicy(DEFAULT_POLICY, { ...evmIntent, policyVersion: 1 }, 0n, now, false).ok).toBe(false);
    expect(checkPolicy(DEFAULT_POLICY, { ...evmIntent, maxFee: '900000000000000000' }, 0n, now, false).ok).toBe(false);
    expect(checkPolicy({ ...DEFAULT_POLICY, allowlist: ['base:0x0000000000000000000000000000000000000001'] }, evmIntent, 0n, now, false).ok).toBe(false);
  });
});

describe('audit chain + state machine', () => {
  it('detects tampering', () => {
    const recs: AuditRecord[] = [];
    for (let k = 0; k < 5; k++) recs.push(appendAudit(recs[k - 1] ?? null, 't', 'owner', { k }));
    expect(verifyAuditChain(recs)).toBeNull();
    const bad = structuredClone(recs); bad[2]!.data = { k: 99 };
    expect(verifyAuditChain(bad)).toBe(3);
    expect(verifyAuditChain([recs[0]!, recs[2]!])).not.toBeNull();
  });
  it('only allows legal transitions', () => {
    expect(canTransition('draft', 'pending_approval')).toBe(true);
    expect(canTransition('draft', 'signed')).toBe(false);
    expect(canTransition('pending_approval', 'broadcast')).toBe(false);
    expect(() => assertTransition('finalized', 'draft')).toThrow();
  });
});
