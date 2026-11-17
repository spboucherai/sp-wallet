// NFT screens (delivery 1, read-only) — rendered through the REAL components to a string (no browser), with hostile and with
// honest data: XSS in name / description / traits / links / SVG / HTML stays inert; states (loading, empty, error, blocked,
// unsupported) say what they are; Send and market actions are present, disabled, with the asset's real reason; every text has
// its two languages. The browser side of the same guarantees (sandboxed iframe, CSP) is tests/e2e/nft.spec.ts.
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { I18n } from '../src/i18n.ts';
import { displayName, safeLink, shortId, STANDARD_KEY, unitsToText, type NftChainCap, type NftItem, type NftList, type NftSummary, type Stamp } from '../src/nft.ts';
import { ChainStates, NftDetail, NftLookup, NftMediaView, Nfts } from '../src/screens/Nft.tsx';
import { i18nTables } from '../scripts/i18n-split.mts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const screen = read('../src/screens/Nft.tsx').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n') /* code, without its comment lines */, i18nSrc = read('../src/i18n.ts'), tables = i18nTables(i18nSrc);
const REF = 'CMhGwGHMbVaBmxebfU3t5eViSf6FKHnvFCBNiA1D659j', KEY = `sol:solana:${REF}`;
const stamp = (category: Stamp['category'], source: string, o: Partial<Stamp> = {}): Stamp => ({ category, source, detail: 'api.mainnet-beta.solana.com, solana-rpc.publicnode.com', fetchedAt: '2026-11-17T08:43:25.488Z', confidence: category === 'onchain' ? 'chain_verified' : 'creator_declared', freshness: 'fresh', covers: [], ...o });
const U = { state: 'unsupported' } as const, N = { state: 'none' } as const;
/** the reference item as the API answers it (values from the recorded chain answers and its metadata document) */
const item = (o: Partial<NftItem> = {}): NftItem => ({
  key: KEY, family: 'sol', chainId: 'solana', assetId: REF, standard: 'metaplex-core', tokenId: null, contractAddress: null, mintAddress: REF, quantity: '0', supply: { state: 'known', value: '1' }, ownerAddress: null,
  collection: { key: 'sol:solana:phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC', id: 'phygZDQZJZVHvJGYPGoKPYUtXw7mstSYtTtcuh8LJcC', name: 'Phygitals', verifiedOnChain: { state: 'known', value: true }, source: stamp('onchain', 'solana-rpc') },
  updateAuthority: { state: 'known', value: '6gn64NNTDS4sNDfAq6Qk6cdgPeCWjupPbUVLfNSHeY4S' }, creators: U, tokenProgram: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', royaltyBps: N, ruleSet: U, extensions: ['core-collection:PermanentTransferDelegate'],
  metadata: { status: 'ok', errorCode: null, sourceUri: `https://metadata.phygitals.com/${REF}`, resolvedUri: `https://metadata.phygitals.com/${REF}`, onchainName: '2016 Pokemon XY Special Box Prom', onchainSymbol: null, name: '2016 Pokemon XY Special Box Prom', description: '2016 Pokemon XY Special Box Promo Japanese Rayquaza Poncho Weari', externalUrl: null,
    attributes: [{ raw: {}, traitType: 'Grade', value: 'PSA 10.0', valueText: 'PSA 10.0', displayType: null, maxValue: null, malformed: false }, { raw: {}, traitType: 'Cert Number', value: '65475295', valueText: '65475295', displayType: null, maxValue: null, malformed: false }],
    contentHash: 'ab'.repeat(32), mutable: { state: 'known', value: true }, traitStatistics: { computed: false, reason: 'no_collection_index' }, source: stamp('creator_metadata', 'metadata-uri', { detail: 'metadata.phygitals.com' }) },
  media: [{ role: 'image', id: `m${'1'.repeat(40)}`, sourceUri: 'https://gateway.irys.xyz/29YSZT2VooL3a8413PAq25rF48j1pa1Rbk9LfYvDA6YF', resolvedUri: null, declaredMime: 'image/png', mime: null, kind: 'image', status: 'not_fetched', errorCode: null, bytes: null }],
  ownership: { state: 'not_in_wallet', owner: { state: 'known', value: '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS' }, tokenAccount: U, frozen: { state: 'known', value: false }, delegate: N, tokenRecordState: U, heldByWallet: false, source: stamp('onchain', 'solana-rpc', { blockRef: { slot: '470470907' } }) },
  market: null, capabilities: { viewable: true, transferable: false, transferBlockedBy: ['not_in_wallet', 'transfer_not_built'], marketActions: false, marketBlockedBy: 'market_not_integrated' },
  sources: [stamp('onchain', 'solana-rpc', { blockRef: { slot: '470470907' } }), stamp('creator_metadata', 'metadata-uri', { detail: 'metadata.phygitals.com' })], fetchedAt: '2026-11-17T08:43:25.488Z', origin: 'lookup', explorerUrl: `https://solscan.io/token/${REF}`, firstSeen: '2026-11-17T08:43:25.488Z', lastSeen: '2026-11-17T08:43:25.488Z', verifiedAt: '2026-11-17T08:43:25.488Z', goneAt: null,
  externalMarkets: [{ name: 'Magic Eden', url: `https://magiceden.io/item-details/${REF}` }, { name: 'OpenSea', url: `https://opensea.io/item/solana/${REF}` }], ...o });

function render(el: ReactElement, seed: (qc: QueryClient) => void = () => {}, locale: 'fr' | 'en' = 'fr'): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  seed(qc);
  return renderToString(createElement(QueryClientProvider, { client: qc }, createElement(I18n.Provider, { value: { locale, setLocale: () => {} } }, el)));
}
const detail = (a: NftItem, locale: 'fr' | 'en' = 'fr', extra: (qc: QueryClient) => void = () => {}) => render(createElement(NftDetail, { id: a.key, nav: () => {} }), (qc) => { qc.setQueryData(['nft', 'item', a.key], a);
  qc.setQueryData(['nft', 'activity', a.key], { events: [], cursor: null, completeness: 'full', note: null, scannedAt: null, canLoadOlder: false, error: null }); for (const m of a.media) qc.setQueryData(['nft', 'media', m.id], { status: 'available', kind: m.kind, mime: m.mime }); extra(qc); }, locale);
const text = (html: string) => html.replace(/<!-- -->/g, '');

describe('the reference item page — real fields, each with its provenance', () => {
  const html = text(detail(item()));
  it('shows what was established and labels where it came from', () => {
    expect(html).toContain('2016 Pokemon XY Special Box Prom'); expect(html).toContain('PSA 10.0'); expect(html).toContain('Cert Number'); expect(html).toContain('Phygitals');
    expect(html).toContain('Confirmé on-chain'); expect(html).toContain('Métadonnée du créateur'); expect(html).toContain('Appartenance à la collection vérifiée on-chain');
    expect(html).toContain(REF); expect(html).toContain('62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS'); // full identifiers, not shortened
    expect(html).toContain('slot 470470907'); expect(html).toContain('plusieurs points d’accès concordants');
  });
  it('says it is not in this wallet, and what could not be established', () => {
    expect(html).toContain('data-testid="nft-not-in-wallet"'); expect(html).toContain('Ce NFT n’est pas dans ce portefeuille');
    expect(html).toContain('Aucune donnée de marché'); expect(html).toContain('Valeur de cet objet : non disponible'); expect(html).toContain('Fréquence et rareté : non calculées'); expect(html).toContain('dénominateur inconnu');
    expect(html).not.toMatch(/rang|rank #|floor: [0-9]/i);
  });
  it('Send and the market actions are there, DISABLED, with the real reasons — in plain words', () => {
    for (const id of ['nft-send', 'nft-market-actions']) { const tag = new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? ''; expect(tag, id).toContain('disabled=""'); }
    expect(html).toContain('data-reason="not_in_wallet"'); expect(html).toContain('data-reason="transfer_not_built"');
    expect(html).toContain('L’envoi de NFT n’est pas pris en charge dans cette version.'); expect(html).toContain('Actions de marché non prises en charge dans cette version');
    expect(html + i18nSrc.slice(i18nSrc.indexOf('>>> NFT delivery 1'))).not.toMatch(/livraison suivante|prochaine livraison|next delivery|coming soon|bientôt/i);
  });
  it('external marketplaces are links opened outside, with the warning', () => {
    expect(html).toContain('data-testid="nft-outside-warning"'); expect(html).toContain('hors de SP Wallet'); expect(html).toMatch(/href="https:\/\/opensea\.io\/item\/solana\/CMhG[^"]+" target="_blank" rel="noreferrer noopener"/); expect(html).toContain('(opensea.io)');
  });
  it('in English too', () => {
    const en = text(detail(item(), 'en'));
    for (const s of ['Confirmed on-chain', 'Creator metadata', 'This NFT is not in this wallet', 'Sending NFTs is not supported in this version.', 'Frequency and rarity: not computed.', 'outside SP Wallet']) expect(en, s).toContain(s);
    expect(en).not.toContain('Confirmé');
  });
  it('a pNFT in the wallet: locked, rule set — each reason is its own line', () => {
    const p = text(detail(item({ standard: 'metaplex-pnft', ruleSet: { state: 'known', value: 'ARdHQ5FBBMyMaA5dzyJji6U8i7uwAK2TBsMHM8GTBUGn' }, quantity: '1', origin: 'discovered',
      ownership: { ...item().ownership, state: 'escrow_or_delegated', heldByWallet: true, frozen: { state: 'known', value: true }, delegate: { state: 'known', value: '94PEhc7PwL5fjpz7dQoienNWzyBTnupBWksEAjHxd5d9' }, tokenRecordState: { state: 'known', value: 'locked' }, tokenAccount: { state: 'known', value: '2vK6qEqvadYp151cBaMnxviSnargTwqcr6F3NgaJD9bg' } },
      capabilities: { ...item().capabilities, transferBlockedBy: ['pnft_locked', 'pnft_rule_set', 'transfer_not_built'] } })));
    expect(p).toContain('NFT programmable verrouillé par un délégué'); expect(p).toContain('soumis à un jeu de règles'); expect(p).toContain('Délégué ou verrouillé'); expect(p).not.toContain('data-testid="nft-not-in-wallet"'); expect(p).toContain('ARdHQ5FBBMyMaA5dzyJji6U8i7uwAK2TBsMHM8GTBUGn');
  });
  it('market data, when a source is on: "Marché — mis à jour à …", the seller is the marketplace\'s, the floor is not a value', () => {
    const cur = { network: 'solana', asset: 'native', symbol: 'SOL', decimals: 9 };
    const m = text(detail(item({ market: { source: stamp('market', 'magiceden', { detail: 'api-mainnet.magiceden.dev', confidence: 'market_reported' }), url: null, listed: { state: 'known', value: true }, seller: { state: 'known', value: 'EuVNEdz5yHiR9kY8KZHPbYfFzX9nS4CFQPmAdPngyH9P' }, marketCollection: 'thugbirdz',
      listingPrice: { state: 'known', value: { amount: '915900000', currency: cur } }, bestOffer: { state: 'unknown' }, lastSale: { state: 'unknown' }, collectionFloor: { state: 'known', value: { amount: '4000000', currency: cur } } } })));
    expect(m).toContain('Marché — mis à jour à'); expect(m).toContain('0.9159 SOL'); expect(m).toContain('0.004 SOL'); expect(m).toContain('Vendeur selon la place de marché'); expect(m).toContain('EuVNEdz5yHiR9kY8KZHPbYfFzX9nS4CFQPmAdPngyH9P');
    expect(m).toContain('n’est pas une estimation de la valeur de cet objet'); expect(m).toContain('Valeur de cet objet : non disponible'); expect(m).toContain('Données de marché : Magic Eden.');
  });
});

describe('hostile metadata is inert in the rendered page', () => {
  const evil = item({ metadata: { ...item().metadata, name: '<img src=x onerror="alert(1)">', description: '<script>alert(document.cookie)</script><a href="javascript:alert(1)">x</a>', externalUrl: 'javascript:alert(document.domain)',
    attributes: [{ raw: {}, traitType: '<b onmouseover=alert(1)>T</b>', value: '"><svg onload=alert(1)>', valueText: '"><svg onload=alert(1)>', displayType: '<i>', maxValue: null, malformed: false }, { raw: 'x', traitType: null, value: null, valueText: '', displayType: null, maxValue: null, malformed: true }] },
    collection: { ...item().collection!, name: '<script>alert("c")</script>', verifiedOnChain: { state: 'known', value: false } }, explorerUrl: 'javascript:alert(1)',
    externalMarkets: [{ name: 'Evil', url: 'javascript:alert(1)' }, { name: 'Data', url: 'data:text/html,<script>alert(1)</script>' }] });
  const html = detail(evil);
  it('name, description, traits and collection name are escaped text — no element is created from them', () => {
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'); expect(html).toContain('&lt;script&gt;alert(document.cookie)&lt;/script&gt;'); expect(html).toContain('&lt;b onmouseover=alert(1)&gt;T&lt;/b&gt;'); expect(html).toContain('&quot;&gt;&lt;svg onload=alert(1)&gt;');
    expect(html).not.toMatch(/<script/i); expect(html).not.toMatch(/<img src=x/i); expect(html).not.toMatch(/<svg onload/i); expect(html).not.toMatch(/<b onmouseover/i); expect(html.replace(/="[^"]*"/g, '=""')).not.toMatch(/<[^>]+\son[a-z]+=/i); // attribute values aside (they are quoted and escaped), no element carries an event handler
  });
  it('javascript: and data: URLs never become links (external link, explorer, marketplaces)', () => {
    expect(html).not.toMatch(/href="(javascript|data|vbscript):/i); expect(html).not.toContain('data-testid="nft-external-link"'); expect(html).not.toContain('data-testid="nft-explorer"'); expect(html).not.toContain('data-testid="nft-market-link"');
    const ok = detail(item({ metadata: { ...item().metadata, externalUrl: 'https://madlads.com/x' } }));
    expect(ok).toMatch(/<a href="https:\/\/madlads\.com\/x" target="_blank" rel="noreferrer noopener nofollow"[^>]*data-testid="nft-external-link"/); expect(ok).toContain('madlads.com'); expect(text(ok)).toContain('non vérifié');
  });
  it('a declared-but-unverified collection is said to be NOT verified; a malformed trait is flagged and kept', () => {
    expect(text(html)).toContain('Collection déclarée mais NON vérifiée on-chain'); expect(text(html)).not.toContain('Appartenance à la collection vérifiée on-chain'); expect(text(html)).toContain('entrée mal formée, conservée telle quelle'); expect(html).toContain('data-malformed="true"');
  });
  it('the source never injects HTML, never autoplays, and the only iframe is sandboxed without same-origin', () => {
    expect(screen).not.toMatch(/dangerouslySetInnerHTML|innerHTML|document\.write|\beval\(/); expect(screen).not.toMatch(/\bautoPlay\b|\bautoplay=/); expect(screen).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
    expect(screen.match(/<iframe/g)).toHaveLength(1); expect(screen).toMatch(/sandbox=\{mode === 'run' \? 'allow-scripts' : ''\}/); expect(screen).toMatch(/<iframe[^>]*allow=""/); expect(screen).not.toMatch(/srcDoc|srcdoc/);
    // media are loaded from this origin's proxy only
    expect(screen).not.toMatch(/src=\{[^}]*(sourceUri|resolvedUri)/); expect([...screen.matchAll(/src=\{([^}]+)\}/g)].map((m) => m[1]!).every((s) => s.startsWith('mediaUrl(') || s.startsWith('qr'))).toBe(true);
  });
});

describe('media player', () => {
  const m = (kind: NftItem['media'][number]['kind'], o: Partial<NftItem['media'][number]> = {}) => ({ ...item().media[0]!, kind, ...o });
  const view = (media: NftItem['media'][number] | null, fit: 'tile' | 'full' = 'full', info: unknown = undefined) => render(createElement(NftMediaView, { m: media, alt: 'alt text', fit }), (qc) => { if (media && info !== null) qc.setQueryData(['nft', 'media', media.id], info ?? { status: 'available', kind: media.kind }); });
  it('an image (an SVG too) is an <img> from the proxy — no referrer, lazy; never inline markup', () => {
    const h = view(m('image')); expect(h).toMatch(new RegExp(`<img src="/api/v1/nfts/media/m1{40}" alt="alt text" loading="lazy"[^>]*referrerPolicy="no-referrer"`)); expect(h).not.toContain('<svg xmlns');
  });
  it('video and audio: standard players with controls, no autoplay', () => {
    const v = view(m('video')), a = view(m('audio')); expect(v).toMatch(/<video[^>]*controls=""[^>]*preload="metadata"/); expect(a).toMatch(/<audio[^>]*controls=""[^>]*preload="none"/); expect(v + a).not.toMatch(/autoplay/i);
  });
  it('HTML is locked by default: no frame until the owner asks; the two actions are distinct', () => {
    const h = text(view(m('html'))); expect(h).not.toContain('<iframe'); expect(h).toContain('data-testid="nft-media-active"'); expect(h).toContain('Afficher sans scripts'); expect(h).toContain('Exécuter ce contenu'); expect(h).toContain('cadre isolé');
    expect(view(m('html'), 'tile')).not.toContain('<iframe');
  });
  it('blocked content says it is blocked, with the reason — it is not attempted', () => {
    const b = text(view(m('image', { status: 'blocked', errorCode: 'private_address' }), 'full', null)); expect(b).toContain('data-testid="nft-media-blocked"'); expect(b).toContain('Contenu bloqué pour votre sécurité'); expect(b).toContain('réseau privé ou local'); expect(b).not.toContain('<img');
    const s = text(view(m('image'), 'full', { status: 'media_blocked', code: 'mime_mismatch' })); expect(s).toContain('le fichier n’est pas du type annoncé'); expect(s).not.toContain('<img');
    const u = text(view(m('image'), 'full', { status: 'media_unreachable', code: 'timeout' })); expect(u).toContain('data-testid="nft-media-unreachable"'); expect(u).toContain('Média injoignable');
    expect(text(view(m('image', { status: 'blocked', errorCode: 'some_new_code' }), 'full', null))).toContain('motif : some_new_code'); // an unknown code is shown as a code, not guessed
    expect(text(view(null))).toContain('Aucun média');
  });
});

describe('gallery states', () => {
  const sum = (o: Partial<NftSummary> = {}): NftSummary => ({ key: KEY, chain: 'solana', family: 'sol', standard: 'metaplex-core', assetId: REF, tokenId: null, name: 'A name', onchainName: 'On-chain', collection: { key: 'c', name: 'Phygitals', verifiedOnChain: { state: 'known', value: true } }, quantity: '1', state: 'in_wallet', inWallet: true, origin: 'discovered', metadataStatus: 'ok', image: null, transferBlockedBy: 'transfer_not_built', firstSeen: '2026-11-17T00:00:00Z', verifiedAt: null, goneAt: null, stale: false, ...o });
  const list = (items: NftSummary[], o: Partial<NftList> = {}): NftList => ({ items, total: items.length, cursor: null, sync: { running: [], lastSyncedAt: { solana: '2026-11-17T08:00:00Z' } }, valuation: { state: 'unavailable', reason: 'no_reliable_valuation' }, asOf: '2026-11-17T08:00:00Z', ...o });
  const cap = (network: string, inventory: NftChainCap['inventory'], o: Partial<NftChainCap> = {}): NftChainCap => ({ network, name: network, family: network === 'solana' ? 'sol' : 'evm', inventory, reason: inventory === 'supported' ? 'onchain_and_das' : inventory === 'unsupported' ? 'no_adapter' : 'no_keyless_discovery', unlockedBy: inventory === 'blocked_by_provider' ? 'NFT_EVM_INDEXER_URLS' : null, standards: [], lookup: inventory !== 'unsupported', manualAdd: true, receive: true, transfer: 'not_built', marketRead: false, marketWrite: false, sections: [], ...o });
  const caps = { chains: [cap('solana', 'supported'), cap('ethereum', 'blocked_by_provider'), cap('cardano', 'unsupported'), cap('bitcoin', 'blocked_by_provider', { reason: 'ordinals_need_ord_indexer', unlockedBy: null, lookup: false })], providers: [] };
  const gallery = (l: NftList | null, locale: 'fr' | 'en' = 'fr') => text(render(createElement(Nfts, { nav: () => {} }), (qc) => { qc.setQueryData(['nft', 'caps'], caps); if (l) qc.setQueryData(['nft', 'list', '', '', 'in_wallet', '', 'recent'], { pages: [l], pageParams: [0] }); }, locale));
  it('loading: a skeleton, not an empty gallery', () => { const h = gallery(null); expect(h).toContain('data-testid="nft-skeleton"'); expect(h).toContain('aria-busy="true"'); expect(h).not.toContain('data-testid="nft-empty"'); });
  it('empty: says which networks were read — never "you have no NFT" for networks that were not', () => {
    const h = gallery(list([])); expect(h).toContain('Aucun NFT détecté sur les réseaux lus'); expect(h).toContain('cela ne veut pas dire qu’il ne contient aucun NFT'); expect(h).toContain('data-testid="nft-blocked-note"');
    expect(h).toMatch(/<details[^>]*open=""[^>]*data-testid="nft-chains-fold"/); // the per-chain states are open when nothing is shown
  });
  it('while synchronising, the empty state says so', () => { const h = gallery(list([], { sync: { running: ['solana'], lastSyncedAt: {} } })); expect(h).toContain('Lecture des réseaux en cours'); expect(h).toContain('data-testid="nft-syncing"'); });
  it('items: a name when one is established, the identifier otherwise; quantity for ERC-1155; the count; the NFT value line', () => {
    const h = gallery(list([sum(), sum({ key: 'k2', name: null, onchainName: null, assetId: '0x0905b2277df5c7dd6c5e3399ece8a36621aebe85/5', quantity: '3', chain: 'ethereum', standard: 'erc1155', collection: null })]));
    expect(h).toContain('A name'); expect(h).toContain('0x0905b2…aebe85/5'); expect(h).toContain('×3'); expect(h).toContain('2 NFT'); expect(h).toContain('Sans collection déclarée');
    expect(h).toContain('Valeur des NFT : non disponible'); expect(h).toContain('ne valent pas zéro'); expect(h).toContain('Pas de tri par prix');
  });
  it('per-chain states: supported / blocked by provider (with the setting that unlocks it) / not supported', () => {
    const h = text(render(createElement(ChainStates, { chains: caps.chains })));
    expect(h).toMatch(/data-chain="solana" data-inventory="supported"/); expect(h).toContain('Pris en charge'); expect(h).toMatch(/data-chain="ethereum" data-inventory="blocked_by_provider"/); expect(h).toContain('Bloqué par le fournisseur'); expect(h).toContain('NFT_EVM_INDEXER_URLS');
    expect(h).toMatch(/data-chain="cardano" data-inventory="unsupported"/); expect(h).toContain('Aucun adaptateur NFT pour ce réseau dans cette version.'); expect(h).toContain('Les envois BTC ordinaires ne protègent pas les inscriptions.');
  });
  it('the lookup form offers only chains that can be read, and asks for a token id on EVM', () => {
    const h = text(render(createElement(NftLookup, { chains: caps.chains, nav: () => {} }))); expect(h).toContain('data-testid="nft-lookup-address"'); expect(h).toContain('solana'); expect(h).toContain('ethereum'); expect(h).not.toMatch(/>cardano</); expect(h).not.toMatch(/>bitcoin</);
  });
  it('English gallery', () => { const h = gallery(list([]), 'en'); expect(h).toContain('No NFT detected on the networks read'); expect(h).toContain('NFT value: unavailable'); });
});

describe('texts and helpers', () => {
  const block = i18nSrc.slice(i18nSrc.indexOf('>>> NFT delivery 1'), i18nSrc.indexOf('<<< NFT delivery 1'));
  const keys = Object.keys(tables.fr).filter((k) => k.startsWith('nf'));
  it('the nf block is one contiguous block; every key has its two languages', () => {
    expect(block.length).toBeGreaterThan(1000); expect(keys.length).toBeGreaterThan(250);
    for (const k of keys) { expect(tables.fr[k], k).toBeTruthy(); expect(tables.en[k], k).toBeTruthy(); expect(block, k).toContain(`${k}:`); }
    expect(i18nSrc.replace(block, '').match(/\bnf[A-Z][A-Za-z_0-9]*: \[/g)).toBeNull(); // no nf key outside the block
  });
  it('every key the screens use exists; every server code has its text', () => {
    const src = screen + read('../src/nft.ts') + read('../src/screens/Assets.tsx');
    for (const m of src.matchAll(/t\('(nf[A-Za-z0-9_]+)'/g)) expect(keys, m[1]).toContain(m[1]);
    for (const m of src.matchAll(/'(nf[A-Z][A-Za-z0-9]*_[a-z0-9_]+)'/g)) expect(keys, m[1]).toContain(m[1]);
    const need = (prefix: string, codes: string[]) => { for (const c of codes) expect(keys, `${prefix}${c}`).toContain(`${prefix}${c}`); };
    need('nfWhy_', ['transfer_not_built', 'not_in_wallet', 'burned', 'frozen', 'pnft_locked', 'pnft_listed', 'pnft_rule_set', 'delegated', 'soulbound', 'compressed_requires_indexer', 'escrow', 'unsupported_standard', 'ownership_unknown', 'ordinals_requires_ord_aware_send']);
    need('nfState_', ['in_wallet', 'not_in_wallet', 'escrow_or_delegated', 'burned', 'unknown']); need('nfInv_', ['supported', 'partial', 'blocked_by_provider', 'unsupported']);
    need('nfInvWhy_', ['onchain_and_das', 'sections_blocked', 'indexer_hint_verified_onchain', 'no_keyless_discovery', 'ordinals_need_ord_indexer', 'no_adapter']);
    need('nfMeta_', ['missing', 'no_uri', 'blocked', 'unreachable', 'malformed', 'too_large', 'not_loaded']); need('nfSec_', ['token', 'core', 'compressed', 'indexer', 'manual', 'inventory']); need('nfSecStatus_', ['ok', 'blocked_by_provider', 'error', 'not_configured']);
    need('nfErr_', ['not_found', 'bad_identifier', 'unsupported_standard', 'unsupported_chain', 'provider_rate_limited', 'provider_unavailable', 'provider_bad_answer', 'provider_disagreement', 'provider_method_unsupported', 'provider_not_configured', 'budget_exhausted']);
    need('nfEv_', ['mint', 'transfer', 'transfer_in', 'transfer_out', 'burn', 'unknown']); need('nfFinal_', ['finalized', 'confirmed', 'pending', 'reorged']); need('nfActComp_', ['full', 'partial', 'recent_window', 'unavailable']);
    need('nfRecvWarn_', ['ordinals_not_protected', 'evm_same_address_check_network', 'evm_arrival_not_detected', 'sol_compressed_needs_indexer']); need('nfRarityWhy_', ['no_collection_index', 'collection_unverified', 'compressed', 'mutable_metadata', 'not_built']);
    need('nfConf_', ['chain_verified', 'chain_single_source', 'indexer_reported', 'creator_declared', 'market_reported']); need('nfBlock_', ['scheme_not_allowed', 'private_address', 'forbidden_host', 'mime_mismatch', 'unsupported_type', 'too_large', 'bad_redirect']);
    for (const k of Object.values(STANDARD_KEY)) expect(keys, k).toContain(k);
  });
  it('the Ordinals warning on the Bitcoin receive address is explicit', () => { expect(tables.fr.nfRecvWarn_ordinals_not_protected).toMatch(/Ne recevez PAS d’inscription Ordinals/); expect(tables.en.nfRecvWarn_ordinals_not_protected).toMatch(/Do NOT receive an Ordinals inscription/); expect(tables.fr.nfRecvConfirm).toMatch(/jamais avant/); });
  it('amounts are exact (BigInt strings, no float); names are never guessed; links are filtered', () => {
    expect(unitsToText('915900000', 9)).toBe('0.9159'); expect(unitsToText('1', 9)).toBe('0.000000001'); expect(unitsToText('123456789012345678901234567890', 18)).toBe('123456789012.34567890123456789'); expect(unitsToText('5', 0)).toBe('5'); expect(unitsToText('1000000000', 9)).toBe('1');
    expect(displayName({ name: null, onchainName: null })).toBeNull(); expect(displayName({ name: null, onchainName: 'On-chain' })).toBe('On-chain'); expect(displayName({ metadata: { name: 'Creator', onchainName: 'On-chain' } })).toBe('Creator');
    expect(shortId(REF)).toBe('CMhGwGHM…iA1D659j'); expect(safeLink('javascript:alert(1)')).toBeNull(); expect(safeLink('https://u:p@x.example/')).toBeNull(); expect(safeLink('https://x.example/a')).toEqual({ href: 'https://x.example/a', host: 'x.example' });
  });
  it('the shell: NFT screens are lazy chunks of the Home area, reached from Assets', () => {
    const app = read('../src/App.tsx'), assets = read('../src/screens/Assets.tsx');
    expect(app).toMatch(/nft: \(\) => import\('\.\/screens\/Nft'\)/); expect(app).not.toMatch(/^import .* from '\.\/screens\/Nft'/m); expect(app).toMatch(/tab === 'nfts' \|\| tab === 'nft' \|\| tab === 'nftc' \? 'home'/);
    expect(assets).toContain("nav({ tab: 'nfts' })"); expect(assets).not.toMatch(/from '\.\.\/nft'|from '\.\/Nft'/); // Assets (first chunk) imports nothing of the NFT code
  });
});
