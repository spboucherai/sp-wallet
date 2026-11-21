/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/nft/test/nft-model.test.ts
 * Module           : nft
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-17
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

// NFT model v1 and the pure helpers around it (brief §15 "Model and provider"): keys, exact integers, URI resolution,
// address classification (SSRF), content sniffing, bounded metadata parsing.
import { describe, expect, it } from 'vitest';
import { capabilitiesOf, classifyAddress, decideMedia, DEFAULT_GATEWAYS, evmAssetId, forbiddenHostname, known, nftKey, NONE, normaliseAttributes, normaliseMetadata, parseBoundedJson, parseGatewayList, parseIPv6, parseNftKey, parseTokenId, plainText,
  resolveUri, safeExternalLink, sniff, substituteErc1155Id, transferBlockReasons, UNSUPPORTED, unknown, type NftOwnershipRecord } from '../src/index.ts';

const stamp = { category: 'onchain' as const, source: 't', detail: 't', fetchedAt: '2026-11-17T00:00:00Z', confidence: 'chain_verified' as const, freshness: 'fresh' as const, covers: ['ownership' as const] };
const own = (o: Partial<NftOwnershipRecord> = {}): NftOwnershipRecord => ({ state: 'in_wallet', owner: known('me'), tokenAccount: UNSUPPORTED, frozen: known(false), delegate: NONE, tokenRecordState: UNSUPPORTED, heldByWallet: true, source: stamp, ...o });

describe('canonical key', () => {
  it('is family:chain:asset-id, deterministic, and round-trips', () => {
    const k = nftKey('sol', 'solana', 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j');
    expect(k).toBe('sol:solana:CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j');
    expect(parseNftKey(k)).toEqual({ family: 'sol', chainId: 'solana', assetId: 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j' });
    const e = nftKey('evm', 'ethereum', evmAssetId('0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', '1'));
    expect(e).toBe('evm:ethereum:0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1');
    expect(parseNftKey(e).assetId).toBe('0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d/1');
  });
  it('never collides across chains, contracts or token ids — and never depends on a name', () => {
    const c = '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D', d = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
    const keys = [nftKey('evm', 'ethereum', evmAssetId(c, '1')), nftKey('evm', 'base', evmAssetId(c, '1')), nftKey('evm', 'ethereum', evmAssetId(d, '1')), nftKey('evm', 'ethereum', evmAssetId(c, '11')), nftKey('evm', 'ethereum', evmAssetId(c, '0x1'))];
    expect(new Set(keys).size).toBe(4); // '1' and '0x1' are the SAME token: one key
    expect(keys[0]).toBe(keys[4]);
    // Solana addresses are case-sensitive: two mints differing by case are two assets
    expect(nftKey('sol', 'solana', 'AbcDEFGHJKLMNPQRSTUVWXYZabcdefghijkm')).not.toBe(nftKey('sol', 'solana', 'abcDEFGHJKLMNPQRSTUVWXYZabcdefghijkm'));
  });
  it('refuses malformed parts', () => {
    for (const bad of [['EVM', 'ethereum', 'x'], ['evm', 'eth ereum', 'x'], ['evm', 'ethereum', ''], ['evm', 'ethereum', 'a:b'], ['evm', 'ethereum', 'a b'], ['evm', 'ethereum', 'a%2F']] as [string, string, string][]) expect(() => nftKey(...bad)).toThrow();
    for (const bad of ['', 'evm', 'evm:ethereum', 'evm::x', ':a:b']) expect(() => parseNftKey(bad)).toThrow();
  });
  it('token ids are exact at uint256 size (never a JS number)', () => {
    const max = (1n << 256n) - 1n;
    expect(parseTokenId(max.toString())).toBe(max);
    expect(evmAssetId('0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85', '79233663829379634837589865448569342784712482819484549289560981379859480642508')).toBe('0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85/79233663829379634837589865448569342784712482819484549289560981379859480642508');
    for (const bad of [(max + 1n).toString(), '-1', '1.5', '1e3', ' 1', '0x', 'abc']) expect(() => parseTokenId(bad)).toThrow();
  });
});

describe('capabilities (delivery 2): transferable when no FACT stands in the way, with the real reasons otherwise', () => {
  const base = { standard: 'metaplex-token-metadata' as const, ruleSet: UNSUPPORTED, extensions: [] as string[], quantity: '1' };
  it('held, nothing in the way → no reason: the asset can be sent (market actions stay off)', () => {
    expect(transferBlockReasons({ ...base, ownership: own() })).toEqual([]);
    const c = capabilitiesOf({ ...base, ownership: own() });
    expect(c.transferable).toBe(true); expect(c.transferBlockedBy).toEqual([]); expect(c.marketActions).toBe(false); expect(c.viewable).toBe(true);
    expect(capabilitiesOf({ ...base, ownership: own({ frozen: known(true) }) }).transferable).toBe(false);
  });
  it('each fact gives its own reason, most specific first; "not built" is no longer a reason', () => {
    expect(transferBlockReasons({ ...base, ownership: own({ state: 'not_in_wallet', heldByWallet: false }) })).toEqual(['not_in_wallet']);
    expect(transferBlockReasons({ ...base, ownership: own({ state: 'burned', heldByWallet: false }) })[0]).toBe('burned');
    expect(transferBlockReasons({ ...base, ownership: own({ state: 'unknown', heldByWallet: false }) })[0]).toBe('ownership_unknown');
    expect(transferBlockReasons({ ...base, ownership: own({ frozen: known(true) }) })).toEqual(['frozen']);
    expect(transferBlockReasons({ ...base, ownership: own({ delegate: known('d') }) })).toEqual(['delegated']);
    expect(transferBlockReasons({ ...base, standard: 'metaplex-pnft', ruleSet: known('r'), ownership: own({ frozen: known(true), tokenRecordState: known('locked') }) })).toEqual(['pnft_locked']); // the rule set is a warning now, not a block
    expect(transferBlockReasons({ ...base, standard: 'metaplex-pnft', ruleSet: NONE, ownership: own({ tokenRecordState: known('listed') }) })).toEqual(['pnft_listed']);
    expect(transferBlockReasons({ ...base, standard: 'spl-token-2022', extensions: ['nonTransferable'], ownership: own() })).toEqual(['soulbound']);
    expect(transferBlockReasons({ ...base, standard: 'metaplex-bubblegum', ownership: own() })).toEqual(['compressed_transfer_not_supported']);
    expect(transferBlockReasons({ ...base, standard: 'ordinals-inscription', ownership: own() })).toEqual(['ordinals_transfer_not_supported']);
    expect(transferBlockReasons({ ...base, standard: 'evm-nonstandard', ownership: own() })).toEqual(['unsupported_standard']);
    // delivery 2: Token-2022 extensions a plain TransferChecked does not account for; states that could not be read; warnings
    expect(transferBlockReasons({ ...base, standard: 'spl-token-2022', extensions: ['metadataPointer', 'tokenMetadata', 'freezeAuthority'], ownership: own() })).toEqual([]);
    for (const ext of ['transferHook', 'permanentDelegate', 'transferFeeConfig', 'confidentialTransferMint', 'defaultAccountState', 'pausableConfig', 'somethingNew'])
      expect(transferBlockReasons({ ...base, standard: 'spl-token-2022', extensions: ['metadataPointer', ext], ownership: own() }), ext).toEqual(['token2022_extension_unsupported']);
    expect(transferBlockReasons({ ...base, standard: 'spl-token-2022', extensions: ['nonTransferable', 'transferHook'], ownership: own() })).toEqual(['soulbound', 'token2022_extension_unsupported']);
    expect(transferBlockReasons({ ...base, ownership: own({ frozen: unknown('not read') }) })).toEqual(['ownership_unknown']);
    expect(transferBlockReasons({ ...base, ownership: own({ delegate: unknown('not read') }) })).toEqual(['ownership_unknown']);
    expect(transferBlockReasons({ ...base, standard: 'metaplex-pnft', ruleSet: NONE, ownership: own({ tokenRecordState: unknown('no record') }) })).toEqual(['ownership_unknown']);
    expect(transferBlockReasons({ ...base, standard: 'metaplex-pnft', ruleSet: NONE, ownership: own({ frozen: known(true), tokenRecordState: known('unlocked') }) })).toEqual([]); // a pNFT's SPL account is always frozen
    expect(transferBlockReasons({ ...base, standard: 'metaplex-pnft', ruleSet: NONE, ownership: own({ tokenRecordState: known('unlocked'), delegate: known('d') }) })).toEqual(['delegated']);
    expect(transferBlockReasons({ ...base, standard: 'spl-token', ownership: own() })).toEqual(['unsupported_standard']);
    expect(transferBlockReasons({ ...base, standard: 'erc721', ownership: own({ frozen: UNSUPPORTED, delegate: UNSUPPORTED, tokenRecordState: UNSUPPORTED }) })).toEqual([]);
    expect(capabilitiesOf({ ...base, standard: 'metaplex-pnft', ruleSet: known('r'), ownership: own({ tokenRecordState: known('unlocked') }) }).transferWarnings).toEqual(['pnft_rule_set']);
    expect(capabilitiesOf({ ...base, standard: 'metaplex-core', extensions: ['core:Attributes', 'core-collection:PermanentTransferDelegate', 'core-collection:PermanentFreezeDelegate'], ownership: own() }).transferWarnings).toEqual(['core_collection_permanent_delegate']);
    expect(capabilitiesOf({ ...base, standard: 'erc1155', ownership: own() }).transferWarnings).toEqual(['semi_fungible']);
  });
  it('null, unknown, unsupported and a value are four states', () => {
    expect([known(0).state, NONE.state, unknown('why').state, UNSUPPORTED.state]).toEqual(['known', 'none', 'unknown', 'unsupported']);
    expect(known('0')).toEqual({ state: 'known', value: '0' }); // zero is a value
  });
});

describe('URI resolver', () => {
  const CID0 = 'QmeSjSinHpPnmXmspMjwiXyN6zS4E9zccariGR3jxcaWtq', CID1 = 'bafybeigetp7ywldrr3xxjlc4h7vrairauzm5oeibkychllu3k66nq7lsbq';
  it('https is kept as written; the source URI is never rewritten', () => {
    expect(resolveUri('https://metadata.phygitals.com/CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j')).toEqual({ ok: true, kind: 'https', candidates: ['https://metadata.phygitals.com/CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j'] });
  });
  it('ipfs:// in its forms → every configured gateway, in order (failover)', () => {
    const want = DEFAULT_GATEWAYS.ipfs.map((g) => `${g}${CID0}/1`);
    expect(resolveUri(`ipfs://${CID0}/1`)).toEqual({ ok: true, kind: 'ipfs', candidates: want });
    expect(resolveUri(`ipfs://ipfs/${CID0}/1`)).toEqual({ ok: true, kind: 'ipfs', candidates: want });
    expect(resolveUri(`ipfs://${CID1}`, { ipfs: ['https://gw.example/ipfs/'], arweave: [] })).toEqual({ ok: true, kind: 'ipfs', candidates: [`https://gw.example/ipfs/${CID1}`] });
    expect(resolveUri(`ipfs://${CID0}`, { ipfs: [], arweave: [] })).toEqual({ ok: false, code: 'no_gateway' });
    for (const bad of ['ipfs://', 'ipfs://not-a-cid/x', `ipfs://${CID0}/../../etc/passwd`, `ipfs://${CID0}/a?x=1`, `ipfs://${CID0}/a\\b`]) expect(resolveUri(bad)).toEqual({ ok: false, code: 'bad_ipfs_path' });
  });
  it('ar:// → the Arweave gateway', () => {
    expect(resolveUri('ar://w4RVczdWwyiWS8tXgDenLEL7iFDdu4bi2YVmGyQo_dE/3936.json')).toEqual({ ok: true, kind: 'arweave', candidates: ['https://arweave.net/w4RVczdWwyiWS8tXgDenLEL7iFDdu4bi2YVmGyQo_dE/3936.json'] });
    expect(resolveUri('ar://short')).toEqual({ ok: false, code: 'bad_arweave_id' });
  });
  it('on-chain data: JSON is decoded inline (base64 and percent-encoded); other data: types are refused for metadata', () => {
    const j = JSON.stringify({ name: 'on-chain', image: 'data:image/svg+xml;base64,PHN2Zy8+' });
    const b = resolveUri(`data:application/json;base64,${btoa(j)}`);
    expect(b.ok && b.kind === 'data' && new TextDecoder().decode(b.bytes)).toBe(j);
    const p = resolveUri(`data:application/json,${encodeURIComponent(j)}`);
    expect(p.ok && p.kind === 'data' && new TextDecoder().decode(p.bytes)).toBe(j);
    expect(resolveUri('data:text/html,<script>alert(1)</script>')).toEqual({ ok: false, code: 'data_uri_not_allowed' });
    expect(resolveUri('data:text/html;base64,PHNjcmlwdD4=', DEFAULT_GATEWAYS, 'media')).toEqual({ ok: false, code: 'data_uri_not_allowed' });
    expect(resolveUri('data:image/svg+xml;base64,PHN2Zy8+', DEFAULT_GATEWAYS, 'media').ok).toBe(true);
    expect(resolveUri('data:application/json;base64,@@@')).toEqual({ ok: false, code: 'data_uri_malformed' });
  });
  it('refuses every other scheme, credentials, ports and oversized URIs', () => {
    for (const [u, code] of [['http://example.com/a.json', 'scheme_not_allowed'], ['javascript:alert(1)', 'scheme_not_allowed'], ['file:///etc/passwd', 'scheme_not_allowed'], ['ftp://example.com/x', 'scheme_not_allowed'], ['gopher://x', 'scheme_not_allowed'], ['blob:https://x/y', 'scheme_not_allowed'],
      ['https://user:pass@example.com/a', 'credentials_in_url'], ['https://example.com:8443/a', 'port_not_allowed'], ['https://example.com:22/', 'port_not_allowed'], ['', 'empty_uri'], ['   ', 'empty_uri'], ['not a uri', 'malformed_uri'], [`https://example.com/${'a'.repeat(3000)}`, 'uri_too_long']] as const)
      expect(resolveUri(u), u).toEqual({ ok: false, code });
    expect(resolveUri('https://example.com:443/a').ok).toBe(true);
  });
  it('trailing NUL padding of on-chain strings is ignored', () => { expect(resolveUri('https://example.com/a.json\0\0\0')).toEqual({ ok: true, kind: 'https', candidates: ['https://example.com/a.json'] }); });
  it('ERC-1155 {id}: lowercase hex, zero-padded to 64, no 0x — exactly as the EIP says', () => {
    expect(substituteErc1155Id('https://token-cdn-domain/{id}.json', '314592')).toBe('https://token-cdn-domain/000000000000000000000000000000000000000000000000000000000004cce0.json'); // the EIP's own example
    expect(substituteErc1155Id('https://x/{id}/{id}', 255n)).toBe(`https://x/${'0'.repeat(62)}ff/${'0'.repeat(62)}ff`);
    expect(substituteErc1155Id('https://x/static.json', '5')).toBe('https://x/static.json');
    expect(substituteErc1155Id('https://x/{ID}', '5')).toBe('https://x/{ID}'); // only the literal {id}
  });
  it('gateway lists: https bases only', () => {
    expect(parseGatewayList(undefined, ['d'])).toEqual(['d']);
    expect(parseGatewayList('https://a.example/ipfs, https://b.example/ipfs/', [])).toEqual(['https://a.example/ipfs/', 'https://b.example/ipfs/']);
    for (const bad of ['http://a.example/ipfs/', 'https://u:p@a.example/', 'https://a.example/?k=1', 'nope']) expect(() => parseGatewayList(bad, [])).toThrow();
  });
  it('external links: http(s) only, host returned for display', () => {
    expect(safeExternalLink('https://madlads.com/x?y=1')).toEqual({ href: 'https://madlads.com/x?y=1', host: 'madlads.com' });
    for (const bad of ['javascript:alert(document.cookie)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', 'https://user:pw@evil.example/', ' ', null, 42, {}]) expect(safeExternalLink(bad)).toBeNull();
  });
});

describe('address classification (SSRF)', () => {
  it('public addresses pass', () => { for (const a of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e']) expect(classifyAddress(a), a).toEqual({ ok: true }); });
  it('loopback, private, link-local, CGNAT, cloud metadata, multicast, reserved — IPv4', () => {
    for (const [a, r] of [['127.0.0.1', 'loopback'], ['127.255.255.254', 'loopback'], ['10.0.0.1', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.2.103', 'private'], ['169.254.169.254', 'cloud_metadata'], ['169.254.1.1', 'link_local'],
      ['100.64.0.1', 'cgnat'], ['100.125.225.117', 'cgnat'], ['100.100.100.200', 'cloud_metadata'], ['0.0.0.0', 'unspecified'], ['224.0.0.1', 'multicast'], ['255.255.255.255', 'reserved'], ['240.0.0.1', 'reserved'], ['192.0.2.1', 'documentation'], ['198.18.0.1', 'reserved'], ['192.0.0.8', 'reserved']] as const)
      expect(classifyAddress(a), a).toEqual({ ok: false, reason: r });
    expect(classifyAddress('172.32.0.1').ok).toBe(true); expect(classifyAddress('100.128.0.1').ok).toBe(true);
  });
  it('IPv6 equivalents, and IPv6 forms that embed an IPv4 address', () => {
    for (const [a, r] of [['::1', 'loopback'], ['::', 'unspecified'], ['fe80::1', 'link_local'], ['fc00::1', 'private'], ['fd12:3456::1', 'private'], ['fd00:ec2::254', 'cloud_metadata'], ['ff02::1', 'multicast'], ['2001:db8::1', 'documentation'],
      ['::ffff:127.0.0.1', 'loopback'], ['::ffff:7f00:1', 'loopback'], ['::ffff:10.0.0.1', 'private'], ['::ffff:169.254.169.254', 'cloud_metadata'], ['::127.0.0.1', 'loopback'], ['64:ff9b::7f00:1', 'loopback'], ['64:ff9b::a9fe:a9fe', 'cloud_metadata'],
      ['2002:7f00:1::', 'loopback'], ['2002:c0a8:101::1', 'private'], ['2001:0:1::1', 'reserved'], ['fec0::1', 'private'], ['100::1', 'reserved']] as const)
      expect(classifyAddress(a), a).toEqual({ ok: false, reason: r });
    // an IPv4-mapped PUBLIC address is still refused: no legitimate HTTPS host resolves to one
    expect(classifyAddress('::ffff:93.184.216.34')).toEqual({ ok: false, reason: 'reserved' });
    expect(classifyAddress('[::1]')).toEqual({ ok: false, reason: 'loopback' });
  });
  it('what is not an address is refused; zone ids are refused', () => {
    for (const a of ['', 'localhost', '1.2.3', '256.1.1.1', 'fe80::1%eth0', ':::', '1::2::3']) expect(classifyAddress(a).ok, a).toBe(false);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).not.toBeNull(); expect(parseIPv6('1:2:3:4:5:6:7')).toBeNull();
  });
  it('local host names never resolve', () => {
    for (const h of ['localhost', 'LOCALHOST', 'a.localhost', 'printer.local', 'db.internal', 'router.lan', 'x.home.arpa', 'intranet', 'm3u96a']) expect(forbiddenHostname(h), h).toBe(true);
    for (const h of ['example.com', 'arweave.net', 'gateway.irys.xyz']) expect(forbiddenHostname(h), h).toBe(false);
  });
});

describe('content sniffing', () => {
  const bytes = (...x: (number[] | string)[]) => Uint8Array.from(x.flatMap((p) => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : p)));
  const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'rest'), JPG = bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF'), HTML = bytes('<!DOCTYPE html><html><script>alert(1)</script></html>'), SVG = bytes('<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  it('recognises the allow-listed formats by magic bytes', () => {
    expect(sniff(PNG)).toEqual({ mime: 'image/png', kind: 'image' }); expect(sniff(JPG)?.mime).toBe('image/jpeg'); expect(sniff(bytes('GIF89a....'))?.mime).toBe('image/gif');
    expect(sniff(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))?.mime).toBe('image/webp'); expect(sniff(bytes('RIFF', [0, 0, 0, 0], 'WAVEfmt '))?.mime).toBe('audio/wav');
    expect(sniff(bytes([0, 0, 0, 0x20], 'ftypisom', [0, 0, 0, 0]))?.mime).toBe('video/mp4'); expect(sniff(bytes([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0]))?.mime).toBe('image/avif');
    expect(sniff(bytes([0x1a, 0x45, 0xdf, 0xa3], 'x'))?.mime).toBe('video/webm'); expect(sniff(bytes('OggS', [0, 2]))?.mime).toBe('audio/ogg'); expect(sniff(bytes('ID3', [3, 0, 0]))?.mime).toBe('audio/mpeg');
    expect(sniff(SVG)).toEqual({ mime: 'image/svg+xml', kind: 'image' }); expect(sniff(HTML)).toEqual({ mime: 'text/html', kind: 'html' });
    expect(sniff(bytes('  \n<html><body>x</body></html>'))?.kind).toBe('html'); expect(sniff(bytes('<script>alert(1)</script>'))?.kind).toBe('html');
  });
  it('what is not allow-listed is not served', () => {
    for (const b of [bytes('MZ', [0x90, 0, 3, 0]), bytes([0x7f], 'ELF', [2, 1]), bytes('%PDF-1.7'), bytes('PK', [3, 4, 0, 0]), bytes('{"a":1}'), bytes('plain text file'), bytes([0, 1, 2, 3, 4, 5, 6, 7, 8]), bytes('ab')]) expect(sniff(b)).toBeNull();
    expect(decideMedia('application/pdf', bytes('%PDF-1.7'))).toEqual({ ok: false, code: 'unsupported_type' });
  });
  it('a mislabelled payload is refused: HTML or script announced as an image, an image announced as HTML', () => {
    expect(decideMedia('image/png', HTML)).toEqual({ ok: false, code: 'mime_mismatch' });
    expect(decideMedia('image/jpeg; charset=binary', bytes('<script>fetch("/api/v1/portfolio")</script>'))).toEqual({ ok: false, code: 'mime_mismatch' });
    expect(decideMedia('video/mp4', HTML)).toEqual({ ok: false, code: 'mime_mismatch' });
    expect(decideMedia('text/html', PNG)).toEqual({ ok: false, code: 'mime_mismatch' });
  });
  it('the served type is the sniffed one; a generic or absent header is accepted', () => {
    expect(decideMedia('image/jpeg', PNG)).toEqual({ ok: true, mime: 'image/png', kind: 'image' });
    expect(decideMedia('application/octet-stream', PNG)).toEqual({ ok: true, mime: 'image/png', kind: 'image' });
    expect(decideMedia(null, JPG)).toEqual({ ok: true, mime: 'image/jpeg', kind: 'image' });
    expect(decideMedia('image/svg+xml', SVG)).toEqual({ ok: true, mime: 'image/svg+xml', kind: 'image' });
    expect(decideMedia('text/plain', HTML)).toEqual({ ok: true, mime: 'text/html', kind: 'html' }); // served as HTML, i.e. sandboxed — never as text the browser may sniff
  });
});

describe('metadata documents', () => {
  it('bounded JSON: size, depth, node count, shape', () => {
    expect(parseBoundedJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseBoundedJson('{"a":'.repeat(40) + '1' + '}'.repeat(40))).toEqual({ ok: false, code: 'json_too_deep' });
    expect(parseBoundedJson('['.repeat(100_000))).toEqual({ ok: false, code: 'json_too_deep' }); // refused by the scan, before any parser recursion
    expect(parseBoundedJson(`{"a":"${'x'.repeat(300_000)}"}`)).toEqual({ ok: false, code: 'json_too_large' });
    expect(parseBoundedJson(JSON.stringify({ a: Array.from({ length: 30_000 }, (_, k) => k) }))).toEqual({ ok: false, code: 'json_too_many_nodes' });
    expect(parseBoundedJson('{"a":')).toEqual({ ok: false, code: 'json_malformed' });
    for (const s of ['[]', '"x"', '1', 'null']) expect(parseBoundedJson(s)).toEqual({ ok: false, code: 'json_not_object' });
    expect(parseBoundedJson('{"s":"a string with [[[[[[[[[[[[[[[[[[[[ brackets"}').ok).toBe(true); // brackets inside strings do not count
  });
  it('normalises the Metaplex / ERC-721 schema and keeps what it does not understand in raw', () => {
    const doc = { name: '2016 Pokemon XY Special Box Prom', image: 'https://gateway.irys.xyz/29YSZT2VooL3a8413PAq25rF48j1pa1Rbk9LfYvDA6YF', attributes: [{ value: 'PSA 10.0', trait_type: 'Grade' }], properties: { files: [{ uri: 'https://gateway.irys.xyz/29YSZT2VooL3a8413PAq25rF48j1pa1Rbk9LfYvDA6YF', type: 'image/png' }] }, description: 'd', seller_fee_basis_points: 0, unknown_field: { x: 1 } };
    const n = normaliseMetadata(doc);
    expect(n.name).toBe('2016 Pokemon XY Special Box Prom'); expect(n.image).toBe(doc.image); expect(n.files).toEqual([{ uri: doc.image, type: 'image/png' }]); expect(n.attributes[0]).toMatchObject({ traitType: 'Grade', value: 'PSA 10.0', valueText: 'PSA 10.0', malformed: false });
  });
  it('wrong types become null, never a guess', () => {
    const n = normaliseMetadata({ name: { evil: 1 }, description: ['a'], image: 42, external_url: null, attributes: 'nope' });
    expect(n).toMatchObject({ name: null, description: null, image: null, externalUrl: null, attributes: [] });
  });
  it('every attribute is kept: duplicates, numbers, booleans, nulls, display_type, malformed entries', () => {
    const raw = [{ trait_type: 'Level', value: 5, display_type: 'number', max_value: 10 }, { trait_type: 'Level', value: 5 }, { trait_type: 'Legendary', value: true }, { trait_type: 'Empty', value: null }, { value: 'no type' }, { trait_type: 'no value' }, 'just a string', 7, null, { trait_type: 'Obj', value: { a: 1 } },
      { trait_type: 'Case', value: 'MiXeD  Case 12 kg' }, { trait_type: 'Big', value: 123456789012345680000 }];
    const a = normaliseAttributes(raw);
    expect(a).toHaveLength(raw.length);
    expect(a[0]).toMatchObject({ traitType: 'Level', value: 5, valueText: '5', displayType: 'number', maxValue: '10', malformed: false });
    expect(a[1]).toMatchObject({ traitType: 'Level', value: 5 }); // the duplicate is not merged
    expect(a[2]).toMatchObject({ value: true, valueText: 'true' }); expect(a[3]).toMatchObject({ value: null, valueText: '', malformed: false });
    expect(a[4]).toMatchObject({ traitType: null, value: 'no type' }); expect(a[5]).toMatchObject({ traitType: 'no value', malformed: true });
    expect(a[6]).toMatchObject({ malformed: true, valueText: 'just a string', raw: 'just a string' }); expect(a[7]).toMatchObject({ malformed: true, valueText: '7' }); expect(a[8]).toMatchObject({ malformed: true, raw: null });
    expect(a[9]).toMatchObject({ malformed: true, value: null, raw: { trait_type: 'Obj', value: { a: 1 } } });
    expect(a[10]!.valueText).toBe('MiXeD  Case 12 kg'); // case, spacing and unit are not normalised away
    raw.forEach((r, k) => expect(a[k]!.raw).toBe(r));
  });
  it('text fields are plain text: control characters and bidi overrides are removed, HTML is left as characters', () => {
    expect(plainText('<img src=x onerror=alert(1)>', 300)).toBe('<img src=x onerror=alert(1)>'); // not interpreted, not altered: the UI renders it as text
    expect(plainText('safe‮gnp.exe', 300)).toBe('safegnp.exe'); expect(plainText('a\u0000b\u0007c⁦d', 300)).toBe('abcd'); expect(plainText('padded\0\0\0', 300)).toBe('padded');
    expect(plainText('x'.repeat(400), 300)).toHaveLength(301); expect(plainText('   ', 10)).toBeNull(); expect(plainText({ toString: () => 'x' }, 10)).toBeNull(); expect(plainText(12, 10)).toBe('12');
  });
});
