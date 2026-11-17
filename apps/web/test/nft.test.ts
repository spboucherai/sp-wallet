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
import { NftSend, UtxoLocks } from '../src/screens/NftSend.tsx';
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
  market: null, capabilities: { viewable: true, transferable: false, transferBlockedBy: ['not_in_wallet'], transferWarnings: [], marketActions: false, marketBlockedBy: 'market_not_integrated' },
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
  it('an asset that cannot be sent: Send is DISABLED with its exact reason (never "not built"); the market actions stay disabled', () => {
    for (const id of ['nft-send', 'nft-market-actions']) { const tag = new RegExp(`<button[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? ''; expect(tag, id).toContain('disabled=""'); }
    expect(html).toContain('data-reason="not_in_wallet"'); expect(html).not.toContain('transfer_not_built'); expect(html).not.toContain('pas pris en charge dans cette version.<');
    expect(html).toContain('Ce NFT n’est pas détenu par ce portefeuille.'); expect(html).toContain('Actions de marché non prises en charge dans cette version');
    expect(html + i18nSrc.slice(i18nSrc.indexOf('>>> NFT delivery 1'))).not.toMatch(/livraison suivante|prochaine livraison|next delivery|coming soon|bientôt/i);
  });
  it('external marketplaces are links opened outside, with the warning', () => {
    expect(html).toContain('data-testid="nft-outside-warning"'); expect(html).toContain('hors de SP Wallet'); expect(html).toMatch(/href="https:\/\/opensea\.io\/item\/solana\/CMhG[^"]+" target="_blank" rel="noreferrer noopener"/); expect(html).toContain('(opensea.io)');
  });
  it('in English too', () => {
    const en = text(detail(item(), 'en'));
    for (const s of ['Confirmed on-chain', 'Creator metadata', 'This NFT is not in this wallet', 'This NFT is not held by this wallet.', 'Frequency and rarity: not computed.', 'outside SP Wallet']) expect(en, s).toContain(s);
    expect(en).not.toContain('Confirmé');
  });
  it('a pNFT in the wallet: locked, rule set — each reason is its own line', () => {
    const p = text(detail(item({ standard: 'metaplex-pnft', ruleSet: { state: 'known', value: 'ARdHQ5FBBMyMaA5dzyJji6U8i7uwAK2TBsMHM8GTBUGn' }, quantity: '1', origin: 'discovered',
      ownership: { ...item().ownership, state: 'escrow_or_delegated', heldByWallet: true, frozen: { state: 'known', value: true }, delegate: { state: 'known', value: '94PEhc7PwL5fjpz7dQoienNWzyBTnupBWksEAjHxd5d9' }, tokenRecordState: { state: 'known', value: 'locked' }, tokenAccount: { state: 'known', value: '2vK6qEqvadYp151cBaMnxviSnargTwqcr6F3NgaJD9bg' } },
      capabilities: { ...item().capabilities, transferBlockedBy: ['pnft_locked', 'delegated'] }, transfer: { transferable: false, blockedBy: ['pnft_locked', 'delegated'], warnings: ['pnft_rule_set'], standard: 'metaplex-pnft', route: null } })));
    expect(p).toContain('NFT programmable VERROUILLÉ'); expect(p).toContain('data-reason="pnft_locked"'); expect(p).toContain('data-reason="delegated"'); expect(p).toContain('révoquez-le avant l’envoi'); expect(new RegExp('<button[^>]*data-testid="nft-send"[^>]*>').exec(p)![0]).toContain('disabled=""'); expect(p).toContain('Délégué ou verrouillé'); expect(p).not.toContain('data-testid="nft-not-in-wallet"'); expect(p).toContain('ARdHQ5FBBMyMaA5dzyJji6U8i7uwAK2TBsMHM8GTBUGn');
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
    need('nfWhy_', ['token2022_extension_unsupported', 'compressed_transfer_not_supported', 'ordinals_transfer_not_supported', 'source_not_associated_account', 'ownership_single_source', 'network_disabled_by_policy', 'transfer_not_built', 'not_in_wallet', 'burned', 'frozen', 'pnft_locked', 'pnft_listed', 'pnft_rule_set', 'delegated', 'soulbound', 'compressed_requires_indexer', 'escrow', 'unsupported_standard', 'ownership_unknown', 'ordinals_requires_ord_aware_send']);
    need('nfState_', ['in_wallet', 'not_in_wallet', 'escrow_or_delegated', 'burned', 'unknown']); need('nfInv_', ['supported', 'partial', 'blocked_by_provider', 'unsupported']);
    need('nfInvWhy_', ['onchain_and_das', 'sections_blocked', 'indexer_hint_verified_onchain', 'no_keyless_discovery', 'ordinals_need_ord_indexer', 'no_adapter']);
    need('nfMeta_', ['missing', 'no_uri', 'blocked', 'unreachable', 'malformed', 'too_large', 'not_loaded']); need('nfSec_', ['token', 'core', 'compressed', 'indexer', 'manual', 'inventory']); need('nfSecStatus_', ['ok', 'blocked_by_provider', 'error', 'not_configured']);
    need('nfErr_', ['not_found', 'bad_identifier', 'unsupported_standard', 'unsupported_chain', 'provider_rate_limited', 'provider_unavailable', 'provider_bad_answer', 'provider_disagreement', 'provider_method_unsupported', 'provider_not_configured', 'budget_exhausted']);
    need('nfEv_', ['mint', 'transfer', 'transfer_in', 'transfer_out', 'burn', 'unknown']); need('nfFinal_', ['finalized', 'confirmed', 'pending', 'reorged']); need('nfActComp_', ['full', 'partial', 'recent_window', 'unavailable']);
    need('nfRecvWarn_', ['ordinals_not_protected', 'evm_same_address_check_network', 'evm_arrival_not_detected', 'sol_compressed_needs_indexer', 'ordinals_heuristic_only', 'ordinals_ord_source', 'ordinals_no_transfer', 'arrival_after_confirmation', 'evm_arrival_known_contracts_only']);
    // delivery 2: every code the Send flow and the lock-list screen can show
    need('nfTWarn_', ['pnft_rule_set', 'core_collection_permanent_delegate', 'core_permanent_delegate', 'mutable_metadata', 'contract_recipient', 'creates_token_account', 'semi_fungible']); need('nfTToKind_', ['account', 'contract', 'new_account']); need('nfTAcct_', ['intent', 'derived', 'pinned']);
    need('nfTErr_', ['simulation_reverted', 'simulation_failed', 'destination_is_wallet', 'destination_is_contract_itself', 'bad_destination', 'insufficient_quantity', 'policy_quantity_cap', 'policy_not_allowlisted', 'policy_daily_count', 'policy_halted', 'fee_above_policy', 'not_owned', 'rpc_disagreement', 'rpc_identity', 'non_standard_contract', 'contract_is_fungible_token', 'standard_changed', 'state_changed', 'gas_too_high', 'signer_too_old', 'simulation_unexpected']);
    need('nfUMode_', ['ord', 'heuristic', 'locks_only', 'ord_unavailable']); need('nfUWhy_', ['signer_locked', 'ord_inscription', 'ord_rune', 'ord_unindexed', 'ord_unlisted', 'ord_unavailable', 'heuristic_small', 'heuristic_envelope']);
    const send = read('../src/screens/NftSend.tsx');
    for (const m of send.matchAll(/t\('(nf[A-Za-z0-9_]+)'/g)) expect(keys, m[1]).toContain(m[1]); need('nfRarityWhy_', ['no_collection_index', 'collection_unverified', 'compressed', 'mutable_metadata', 'not_built']);
    need('nfConf_', ['chain_verified', 'chain_single_source', 'indexer_reported', 'creator_declared', 'market_reported']); need('nfBlock_', ['scheme_not_allowed', 'private_address', 'forbidden_host', 'mime_mismatch', 'unsupported_type', 'too_large', 'bad_redirect']);
    for (const k of Object.values(STANDARD_KEY)) expect(keys, k).toContain(k);
  });
  it('the Ordinals warning on the Bitcoin receive address is explicit', () => { expect(tables.fr.nfRecvWarn_ordinals_not_protected).toMatch(/Évitez de recevoir une inscription Ordinals/); expect(tables.en.nfRecvWarn_ordinals_not_protected).toMatch(/Avoid receiving an Ordinals inscription/); expect(tables.fr.nfUMode_heuristic).toMatch(/HEURISTIQUE, pas une détection/); expect(tables.en.nfUMode_heuristic).toMatch(/HEURISTIC, not a detection/); expect(tables.fr.nfRecvConfirm).toMatch(/jamais avant/);
    expect(read('../src/screens/Receive.tsx')).toMatch(/n\.id === 'bitcoin' && <Notice tone="warn"><span data-testid="recv-ordinals-warning">\{t\('nfRecvWarn_ordinals_not_protected'\)\}/); }); // the ordinary Receive screen carries it too
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

// ── delivery 2: Send NFT and the Bitcoin protected outputs ──────────────────────────────────────────────────────────────
describe('Send NFT (delivery 2) — on-chain identifiers first, creator metadata secondary and labelled unverified', () => {
  const mine = (o: Partial<NftItem> = {}) => item({ quantity: '1', origin: 'discovered', ownerAddress: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', ownership: { ...item().ownership, state: 'in_wallet', heldByWallet: true },
    capabilities: { ...item().capabilities, transferable: true, transferBlockedBy: [], transferWarnings: ['core_collection_permanent_delegate', 'mutable_metadata'] },
    transfer: { transferable: true, blockedBy: [], warnings: ['core_collection_permanent_delegate', 'mutable_metadata'], standard: 'metaplex-core', route: 'Core TransferV1 (no compression proof)' }, ...o });
  it('a transferable asset: Send is ENABLED on the item page and names the instruction that will be used', () => {
    const html = text(detail(mine())), tag = /<button[^>]*data-testid="nft-send"[^>]*>/.exec(html)![0];
    expect(tag).not.toContain('disabled=""'); expect(tag).toContain('data-transferable="true"'); expect(html).toContain('Core TransferV1 (no compression proof)'); expect(html).not.toContain('data-testid="nft-send-why"');
  });
  it('the form: network, standard, asset address IN FULL, program called; the creator\'s name and image are small, below, and labelled « métadonnée du créateur, non vérifiée »', () => {
    const html = text(render(createElement(NftSend, { item: mine({ metadata: { ...item().metadata, name: '<b>FREE MINT</b> official ✅', onchainName: 'x' } }), onClose: () => {} }), (qc) => qc.setQueryData(['book'], [{ id: 'b1', network: 'solana', address: '62Q9eeDY3eM8A5CnprBGYMPShdBjAzdpBdr71QHsS8dS', label: 'Coffre' }, { id: 'b2', network: 'base', address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', label: 'EVM' }])));
    const idBlock = html.slice(html.indexOf('data-testid="nft-send-identity"'), html.indexOf('data-testid="nft-send-creator"'));
    expect(idBlock).toContain(REF); expect(idBlock).toContain('Metaplex Core'); expect(idBlock).toContain('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'); expect(idBlock).toContain('Core TransferV1 (no compression proof)');
    expect(idBlock).not.toContain('FREE MINT'); // the creator-declared name is NOT part of what is identified
    const creator = html.slice(html.indexOf('data-testid="nft-send-creator"'), html.indexOf('data-testid="nft-send-warn-'));
    expect(creator).toContain('métadonnée du créateur, non vérifiée'); expect(creator).toContain('&lt;b&gt;FREE MINT&lt;/b&gt; official ✅'); expect(creator).not.toContain('<b>FREE MINT');
    expect(html).toContain('data-testid="nft-send-warn-core_collection_permanent_delegate"'); expect(html).toContain('pouvoir PERMANENT'); expect(html).toContain('data-testid="nft-send-warn-mutable_metadata"');
    expect(html).toContain('Coffre'); expect(html).not.toContain('>EVM<'); // the address book of THIS network only
    expect(html).not.toContain('data-testid="nft-send-qty"'); // one unit: no quantity field
    expect(/<button[^>]*data-testid="nft-send-review"[^>]*>/.exec(html)![0]).toContain('disabled=""'); // no recipient yet
    expect(text(render(createElement(NftSend, { item: mine(), onClose: () => {} }), () => {}, 'en'))).toContain('creator metadata, not verified');
  });
  it('ERC-1155: contract and token id in full (a 78-digit id is not shortened), and a quantity field bounded by what is held', () => {
    const id = '115792089237316195423570985008687907853269984665640564039457584007913129639935', c = '0x495f947276749Ce646f68AC8c248420045cb7b5e';
    const html = text(render(createElement(NftSend, { item: mine({ key: `evm:ethereum:${c.toLowerCase()}/${id}`, family: 'evm', chainId: 'ethereum', standard: 'erc1155', tokenId: id, contractAddress: c, mintAddress: null, assetId: `${c.toLowerCase()}/${id}`, quantity: '3', tokenProgram: null,
      transfer: { transferable: true, blockedBy: [], warnings: ['semi_fungible'], standard: 'erc1155', route: 'safeTransferFrom(address,address,uint256,uint256,bytes) — data empty' } }), onClose: () => {} })));
    expect(html).toContain(id); expect(html).toContain(c); expect(html).toContain('ERC-1155'); expect(html).toContain('data-testid="nft-send-qty"'); expect(html).toContain('Unités détenues : 3'); expect(html).toContain('data empty'); expect(html).toContain('Vérifiez la quantité');
  });
});
describe('Bitcoin protected outputs (delivery 2) — the heuristic is called a heuristic; lock and unlock say they need the passkey', () => {
  const T1 = 'ab'.repeat(32), T2 = 'cd'.repeat(32), T3 = 'ef'.repeat(32);
  const view = (o: Record<string, unknown> = {}) => ({ network: 'bitcoin', address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', mode: 'heuristic', ordConfigured: false, ordHost: null, ordError: null, signerSupportsLocks: true, symbol: 'BTC', decimals: 8, staleLocks: [],
    utxos: [{ txid: T1, vout: 0, outpoint: `${T1}:0`, value: 60000, signerLock: null, ord: null, excludedBy: [], reviewed: false, spendable: true },
      { txid: T2, vout: 1, outpoint: `${T2}:1`, value: 546, signerLock: null, ord: null, excludedBy: ['heuristic_small'], reviewed: false, spendable: false },
      { txid: T3, vout: 0, outpoint: `${T3}:0`, value: 9000, signerLock: { reason: 'owner', at: 1 }, ord: null, excludedBy: ['signer_locked'], reviewed: false, spendable: false }], ...o });
  const html = (v: unknown, locale: 'fr' | 'en' = 'fr') => text(render(createElement(UtxoLocks, { network: 'bitcoin' }), (qc) => qc.setQueryData(['utxo-locks', 'bitcoin'], v), locale));
  it('heuristic mode: said as such; each output with its full outpoint, its exact amount, its state and the actions that apply', () => {
    const h = html(view());
    expect(h).toContain('HEURISTIQUE, pas une détection'); expect(h).toContain('n’est PAS vue'); expect(h).toContain('demande la clé d’accès');
    expect(h).toContain(`${T1}:0`); expect(h).toContain(`${T2}:1`); expect(h).toContain('0.0006 BTC'); expect(h).toContain('0.00000546 BTC'); expect(h).toContain('0.00009 BTC');
    const row = (o: string) => h.slice(h.indexOf(`data-outpoint="${o}"`), h.indexOf('</li>', h.indexOf(`data-outpoint="${o}"`) + 800) > 0 ? h.indexOf('data-outpoint="', h.indexOf(`data-outpoint="${o}"`) + 20) > 0 ? h.indexOf('data-outpoint="', h.indexOf(`data-outpoint="${o}"`) + 20) : h.length : h.length);
    expect(row(`${T1}:0`)).toContain('Dépensable'); expect(row(`${T1}:0`)).toContain('data-testid="utxo-lock"'); expect(row(`${T1}:0`)).not.toContain('data-testid="utxo-review"');
    expect(row(`${T2}:1`)).toContain('Tenue à l’écart'); expect(row(`${T2}:1`)).toContain('possiblement une inscription'); expect(row(`${T2}:1`)).toContain('data-testid="utxo-review"'); expect(row(`${T2}:1`)).toContain('C’est une pièce ordinaire');
    expect(row(`${T3}:0`)).toContain('Verrouillée (signataire)'); expect(row(`${T3}:0`)).toContain('data-testid="utxo-unlock"'); expect(row(`${T3}:0`)).not.toContain('data-testid="utxo-review"'); // a signer lock is not lifted by a review
    expect(html(view(), 'en')).toContain('HEURISTIC, not a detection');
  });
  it('ord mode: the report decides, the unprotected inscription outputs can be locked together; ord unreachable: nothing is spendable and it says why', () => {
    const o = html(view({ mode: 'ord', ordConfigured: true, ordHost: 'ord.local:8080', utxos: [{ txid: T2, vout: 1, outpoint: `${T2}:1`, value: 546, signerLock: null, ord: { inscriptions: [`${T1}i0`], runes: [] }, excludedBy: ['ord_inscription'], reviewed: false, spendable: false }] }));
    expect(o).toContain('ord.local:8080'); expect(o).toContain('ord : porte une inscription.'); expect(o).toContain(`${T1}i0`); expect(o).toContain('data-testid="utxo-lock-all"'); expect(o).toContain('Verrouiller les 1 sorties signalées par ord'); expect(o).not.toContain('data-testid="utxo-review"');
    const down = html(view({ mode: 'ord_unavailable', ordConfigured: true, ordError: 'ord_unavailable', utxos: [{ txid: T1, vout: 0, outpoint: `${T1}:0`, value: 60000, signerLock: null, ord: null, excludedBy: ['ord_unavailable'], reviewed: false, spendable: false }] }));
    expect(down).toContain('aucun envoi Bitcoin ordinaire n’est préparé'); expect(down).toContain('Serveur ord injoignable'); expect(down).not.toContain('Dépensable');
  });
});
