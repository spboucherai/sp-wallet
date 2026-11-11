// v8 hardening (D2): French variants of the server-authored sentences of the derivatives READ routes — the comparison table
// (`GET /derivatives/compare`: settlement, notes, restriction), the instrument facts (`GET /derivatives/instruments`: settlement,
// mark-price method) and the router simulation (`POST /derivatives/route`: engine messages, contract terms). Selected by the
// `locale` parameter (convention: docs/v4/API-LIVE-NOTES.md, « Locale shape »): default `en` returns the engines' own strings,
// byte for byte; `fr` returns the same fields in French. Machine-readable codes, ids, numbers and symbols never change.
//
// The engines (packages/derivatives, data.ts, route.ts) are NOT touched: they keep writing English, and this file translates
// what they wrote — a constant by exact match, a sentence with figures by a pattern that carries the figures over unchanged.
// A sentence this file does not know is returned as it is (English), never dropped and never altered.
import { ROUTER_FACTS, ROUTER_WARNINGS, type VenueId } from '@spw/derivatives';
import type { LiveLocale } from './live-texts.ts';
import { DYDX_FACTS, DYDX_RESTRICTION, GMX_FACTS, HYPERLIQUID_FACTS } from './venues.ts';

export type TextLocale = LiveLocale;
export const textLocale = (x: unknown): TextLocale => (x === 'fr' ? 'fr' : 'en');

// ------------------------------------------------------------------ constants (exact match)

/** notes of the comparison table, in the order of `*_FACTS.notes` (venues.ts) */
const HL_NOTES_FR = [
  'Carnet d’ordres central à cours limité sur la chaîne ; appariement immédiat.',
  'Prix de référence = médiane de l’oracle + moyenne mobile exponentielle de (milieu du carnet − oracle), de la médiane du carnet et d’une médiane pondérée des milieux de contrats perpétuels de bourses centralisées ; l’oracle est libellé en USDT (quanto : résultat en USDT payé en USDC, sans conversion).',
  'Le financement est payé toutes les heures, de pair à pair, sur taille × prix d’oracle × taux ; le taux horaire est le huitième d’un taux sur 8 h ; plafond de 0,5 % par heure.',
  'Marge croisée (par défaut) ou isolée ; la marge de maintien est la moitié de la marge initiale au levier maximal (par paliers de taille).',
  'Les frais affichés sont ceux du palier de base (preneur 0,045 %, teneur 0,015 %) ; il existe des paliers de volume et des rabais de mise en jeu.',
  'Liquidation par le carnet, puis par le coffre de liquidation ; pas de frais de liquidation distincts, la marge de maintien n’est pas rendue lors d’une reprise par le coffre.',
];
const DYDX_NOTES_FR = [
  'Carnet d’ordres sur la chaîne (les ordres à court terme vivent dans la mémoire des validateurs) ; le carnet est mince comparé à celui de Hyperliquid.',
  'Pas de prix de référence distinct : la marge et la liquidation utilisent le prix d’oracle (agrégat de bourses au comptant par les validateurs, en USD).',
  'Le financement est payé toutes les heures sur taille × prix d’oracle × taux ; le taux affiché est l’estimation du prochain taux horaire.',
  'Marge croisée dans un sous-compte ; pas de réglage de levier (borne de 50× issue d’une marge initiale de 2 %) ; pénalité de liquidation jusqu’à 1,5 %.',
  'Les frais affichés sont ceux du palier de base (preneur 0,05 %, teneur 0,01 %).',
  'Admissibilité : les conditions excluent les États-Unis, le Canada et le Royaume-Uni.',
];
const GMX_NOTES_FR = [
  'Pas de carnet d’ordres : les transactions s’exécutent contre une réserve de liquidité GM au prix d’oracle signé (un long ouvre au maximum, ferme au minimum), ajusté de l’impact de prix ; un instrument par réserve.',
  'L’exécution prend deux transactions (une demande, puis l’exécution par un « keeper » à un prix d’oracle ultérieur) ; un ordre peut être annulé ou gelé au lieu d’être exécuté.',
  'Le financement court à la seconde et est affiché par heure ; le côté dont l’intérêt ouvert est le plus grand paie aussi des frais d’emprunt.',
  'Marge isolée par position seulement ; la garantie est le jeton long ou court de la réserve (sa valeur peut bouger avec le marché).',
  'Frais de position de 0,04 % quand la transaction améliore l’équilibre entre longs et shorts, 0,06 % sinon (le plus élevé est affiché) ; plus l’impact de prix, des frais d’exécution en ETH et le gaz d’Arbitrum.',
  'Le levier maximal est la borne du contrat ; le maximum effectif est plus bas et baisse quand l’intérêt ouvert augmente.',
];
export const DYDX_RESTRICTION_FR = 'dYdX est servi pour les données de marché seulement : ses conditions d’utilisation excluent le Canada (ainsi que les États-Unis et le Royaume-Uni) et son indexeur bloque géographiquement la lecture des comptes depuis le réseau du propriétaire. Aucune vue de compte et aucun compte de simulation ne sont offerts sur cette plateforme, afin qu’elle ne puisse pas être prise pour une plateforme où le propriétaire peut négocier.';

/** settlement and mark-price sentences of the adapters (packages/derivatives/src/venues/*): keyed by the English text they return */
const INSTRUMENT_FR: Record<string, string> = {
  'Linear perpetual margined and settled in USDC; the oracle is USDT-denominated for most assets (quanto: USDT PnL paid in USDC, no conversion); funding every hour, peer to peer':
    'Contrat perpétuel linéaire, avec marge et règlement en USDC ; l’oracle est libellé en USDT pour la plupart des actifs (quanto : résultat en USDT payé en USDC, sans conversion) ; financement toutes les heures, de pair à pair',
  'Median of (1) oracle + 150 s EMA of (Hyperliquid mid − oracle), (2) median of best bid, best ask, last trade, (3) weighted median of Binance, OKX, Bybit, Gate IO, MEXC perp mids; updated about every 3 s':
    'Médiane de (1) l’oracle + la moyenne mobile exponentielle sur 150 s de (milieu Hyperliquid − oracle), (2) la médiane du meilleur achat, de la meilleure vente et de la dernière transaction, (3) la médiane pondérée des milieux des contrats perpétuels de Binance, OKX, Bybit, Gate IO et MEXC ; mis à jour environ toutes les 3 s',
  'USDC-margined linear perpetual on dYdX Chain: PnL and funding settle in USDC (Noble USDC over IBC) in the subaccount; no expiry, no delivery':
    'Contrat perpétuel linéaire avec marge en USDC sur la chaîne dYdX : le résultat et le financement se règlent en USDC (USDC de Noble, par IBC) dans le sous-compte ; pas d’échéance, pas de livraison',
  'no separate mark price: the protocol oracle price (validator-aggregated index of exchange prices, updated per block) values positions, margin, liquidations and conditional triggers':
    'pas de prix de référence distinct : le prix d’oracle du protocole (indice de prix de bourses agrégé par les validateurs, mis à jour à chaque bloc) valorise les positions, la marge, les liquidations et les déclenchements conditionnels',
  'isolated position against a GM liquidity pool; PnL is computed in USD and paid in the pool token of the side (long token for longs, short token for shorts) on top of the returned collateral; settlement happens on chain when a keeper executes the order':
    'position isolée contre une réserve de liquidité GM ; le résultat est calculé en USD et payé dans le jeton de la réserve du côté de la position (jeton long pour les longs, jeton court pour les shorts), en plus de la garantie rendue ; le règlement a lieu sur la chaîne quand un « keeper » exécute l’ordre',
  'no order book and no separate mark price: orders execute at the Chainlink Data Streams signed min/max oracle price (longs open at max, close at min) adjusted by price impact; the displayed mark is (min + max) / 2':
    'pas de carnet d’ordres ni de prix de référence distinct : les ordres s’exécutent au prix d’oracle minimum/maximum signé de Chainlink Data Streams (un long ouvre au maximum, ferme au minimum), ajusté de l’impact de prix ; le prix de référence affiché est (min + max) / 2',
};

type TermsFr = Record<keyof (typeof ROUTER_FACTS)['hyperliquid']['terms'], string> & { maintenance: string };
/** contract terms of the router (`ROUTER_FACTS[venue].terms` and `.maintenanceText`, packages/derivatives/src/router.ts) */
const TERMS_FR: Record<VenueId, TermsFr> = {
  hyperliquid: {
    structure: 'carnet d’ordres central à cours limité sur la chaîne',
    execution: 'appariement immédiat contre le carnet',
    quote: 'oracle libellé en USDT, garantie en USDC, sans conversion (quanto : résultat en USDT payé en USDC)',
    fundingRule: 'payé toutes les heures, de pair à pair, sur taille × prix d’oracle × taux ; le taux horaire est 1/8 d’un taux sur 8 h ; plafond de 0,5 % par heure',
    otherCarry: 'aucun',
    sizeUnit: 'actif de base, lot de 10^-szDecimals',
    liquidation: 'sur le prix de référence, par le carnet, puis par le coffre de liquidation (marge de maintien non rendue lors d’une reprise par le coffre) ; pas de frais distincts',
    fees: 'preneur / teneur sur le notionnel, paliers de volume sur 14 jours',
    maintenance: 'la moitié de la marge initiale au levier maximal (1 / (2 × levier maximal) du notionnel) ; par paliers de taille de position — https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margining',
  },
  dydx: {
    structure: 'carnet d’ordres sur la chaîne ; les ordres à court terme vivent dans la mémoire des validateurs',
    execution: 'appariement immédiat (temps de bloc d’environ 1 s)',
    quote: 'oracle en USD ; résultat et financement en USDC',
    fundingRule: 'payé toutes les heures sur taille × prix d’oracle × taux ; taux = prime / 8 + intérêt',
    otherCarry: 'aucun',
    sizeUnit: 'actif de base, lot propre à chaque marché',
    liquidation: 'sur le prix d’oracle ; pénalité jusqu’à 1,5 % versée au fonds d’assurance',
    fees: 'preneur / teneur sur le notionnel, paliers de volume sur 30 jours',
    maintenance: 'fraction de marge de maintien propre à chaque marché (1,2 % pour BTC et ETH), sur le prix d’oracle — https://docs.dydx.xyz/concepts/trading/margin',
  },
  gmx: {
    structure: 'pas de carnet d’ordres : transactions au prix d’oracle contre une réserve de liquidité GM ; un instrument par réserve',
    execution: 'deux transactions : une demande, puis un « keeper » exécute à un prix d’oracle signé ultérieur ; l’ordre peut être annulé ou gelé à la place',
    quote: 'résultat calculé en USD, payé dans le jeton de la réserve du côté de la position',
    fundingRule: 'court à la seconde (affiché par heure), s’adapte au déséquilibre entre longs et shorts ; réglé à chaque changement de position ; un financement positif doit être réclamé',
    otherCarry: 'frais d’emprunt, payés seulement par le côté dont l’intérêt ouvert est le plus grand',
    sizeUnit: 'USD (30 décimales) ; la taille en jetons découle du prix d’exécution',
    liquidation: 'sur le minimum/maximum signé de l’oracle ; frais de liquidation de 0,20 à 0,45 % de la taille ; la garantie restante est rendue',
    fees: 'frais de position sur la taille : facteur le plus bas si la transaction améliore l’équilibre entre longs et shorts ; impact de prix réglé à la fermeture ; frais d’exécution en ETH ; gaz d’Arbitrum',
    maintenance: 'la garantie restante (après résultat, frais et impact négatif plafonné) doit rester au-dessus de max(1 $, minCollateralFactorForLiquidation × taille) — https://docs.gmx.io/docs/trading/liquidations/',
  },
};

/** the three standing messages of the router, in the order of `ROUTER_WARNINGS` */
const ROUTER_WARNINGS_FR = [
  'Simulation seulement : rien n’a été envoyé à une plateforme, et aucun ordre ne peut être passé à partir de ce résultat.',
  'Les taux de financement et d’emprunt changent (toutes les heures sur les plateformes à carnet d’ordres, à chaque seconde sur GMX) : le portage affiché est le taux du jour maintenu constant sur l’horizon, pas une prévision.',
  'Chaque coût est une estimation sur un instantané : le carnet, le prix d’oracle et les réserves bougent avant qu’un ordre réel ne s’exécute.',
];

const EXACT = new Map<string, string>();
const pair = (en: readonly string[], fr: readonly string[]): void => { en.forEach((s, i) => { if (fr[i] !== undefined) EXACT.set(s, fr[i]!); }); };
pair(HYPERLIQUID_FACTS.notes, HL_NOTES_FR); pair(DYDX_FACTS.notes, DYDX_NOTES_FR); pair(GMX_FACTS.notes, GMX_NOTES_FR);
pair(ROUTER_WARNINGS, ROUTER_WARNINGS_FR);
EXACT.set(DYDX_RESTRICTION, DYDX_RESTRICTION_FR);
for (const [en, fr] of Object.entries(INSTRUMENT_FR)) EXACT.set(en, fr);
for (const v of Object.keys(TERMS_FR) as VenueId[]) {
  const f = ROUTER_FACTS[v], t = TERMS_FR[v];
  for (const k of Object.keys(f.terms) as (keyof typeof f.terms)[]) EXACT.set(f.terms[k], t[k]);
  EXACT.set(f.maintenanceText, t.maintenance);
}
for (const [en, fr] of [
  ['The order changes when an immediate close is added to the all-in cost (see the round-trip column): the ranking is on entry costs and carry only.',
    'L’ordre du classement change quand on ajoute une fermeture immédiate au coût tout compris (voir la colonne aller-retour) : le classement porte seulement sur les coûts d’entrée et le portage.'],
  ['A venue restricted for the owner is shown for information and is never ranked.', 'Une plateforme restreinte pour le propriétaire est montrée à titre d’information et n’est jamais classée.'],
  ['none published', 'aucun minimum publié'], ['cross', 'croisée'], ['isolated', 'isolée'], ['cross, isolated', 'croisée, isolée'], ['isolated, cross', 'isolée, croisée'],
] as const) EXACT.set(en, fr);

// ------------------------------------------------------------------ sentences with figures (patterns)

/** cost ids of the router, as the UI names them (apps/web i18n `rxCost_*`) */
const COST_FR: Record<string, string> = { spread_slippage: 'écart et glissement', price_impact: 'impact de prix', trading_fee: 'frais de négociation', execution_fee: 'frais d’exécution', network_gas: 'frais de réseau',
  funding: 'financement', borrow: 'emprunt', collateral_transfer: 'acheminement de la garantie' };
/** a decimal figure written by the engines ("1234.5") with the French decimal comma; anything else is left as it is */
const num = (s: string): string => (/^-?\d+(\.\d+)?$/.test(s) ? s.replace('.', ',') : s);
const interval = (s: string): string => s;   // "1 h", "3600 s": the same in both languages

const PATTERNS: [RegExp, (m: RegExpExecArray) => string][] = [
  // ---- data.ts, compare()
  [/^order book unavailable: (.*)$/s, (m) => `carnet d’ordres indisponible : ${m[1]}`],
  [/^liquidity figures unavailable: (.*)$/s, (m) => `chiffres de liquidité indisponibles : ${m[1]}`],
  [/^The book snapshot \((\d+) bids, (\d+) asks\) does not reach 1 % from the mid on at least one side: the depth within 1 % is a lower bound\.$/,
    (m) => `L’instantané du carnet (${m[1]} niveaux à l’achat, ${m[2]} à la vente) n’atteint pas 1 % du milieu sur au moins un côté : la profondeur à 1 % est une borne inférieure.`],
  [/^No spread and no book depth on this venue\. Capacity still open: long (\S+) USD \(limited by (.+?)\), short (\S+) USD \(limited by (.+?)\)\.$/,
    (m) => `Ni écart ni profondeur de carnet sur cette plateforme. Capacité encore ouverte : long ${num(m[1]!)} USD (limitée par : ${m[2]}), short ${num(m[3]!)} USD (limitée par : ${m[4]}).`],
  [/^Open interest: long (\S+) USD, short (\S+) USD\. Oracle range (\S+) – (\S+)\.$/, (m) => `Intérêt ouvert : long ${num(m[1]!)} USD, short ${num(m[2]!)} USD. Fourchette de l’oracle : ${num(m[3]!)} – ${num(m[4]!)}.`],
  [/^Price impact: factor (\S+) \(negative\) \/ (\S+) \(positive\) × imbalance\^(\S+), capped at (\S+) % against and (\S+) % in favour of the trade\.$/,
    (m) => `Impact de prix : facteur ${num(m[1]!)} (négatif) / ${num(m[2]!)} (positif) × déséquilibre^${num(m[3]!)}, plafonné à ${num(m[4]!)} % contre la transaction et à ${num(m[5]!)} % en sa faveur.`],
  [/^Position fee (\S+) % when the trade improves the long\/short balance, (\S+) % otherwise\. Borrowing rate per hour as the venue publishes it: long (\S+), short (\S+) \(a cost carried by the larger open-interest side, on top of funding\)\.$/,
    (m) => `Frais de position de ${num(m[1]!)} % quand la transaction améliore l’équilibre entre longs et shorts, ${num(m[2]!)} % sinon. Taux d’emprunt par heure tel que la plateforme le publie : long ${num(m[3]!)}, short ${num(m[4]!)} (un coût supporté par le côté dont l’intérêt ouvert est le plus grand, en plus du financement).`],
  // ---- router.ts, routeOrder() and route.ts, route()
  [/^No venue lists a perpetual on (\S+)\.$/, (m) => `Aucune plateforme ne liste de contrat perpétuel sur ${m[1]}.`],
  [/^Some costs are unknown and are NOT in the totals \((.+)\): the totals of those instruments are lower bounds\.$/,
    (m) => `Certains coûts sont inconnus et ne sont PAS dans les totaux (${m[1]!.split(', ').map((c) => COST_FR[c] ?? c).join(', ')}) : les totaux de ces instruments sont des bornes inférieures.`],
  [/^Not read: (.+)\. The comparison is missing those venues\.$/, (m) => `Non lues : ${m[1]}. La comparaison se fait sans ces plateformes.`],
  [/^« (.*) » is on (\S+), which lists no (\S+) perpetual: its policy was not asked\.$/s, (m) => `« ${m[1]} » est sur ${m[2]}, qui ne liste aucun contrat perpétuel sur ${m[3]} : sa politique n’a pas été interrogée.`],
  // ---- router.ts, termsOf()
  [/^every (\d+ (?:h|s))$/, (m) => `toutes les ${interval(m[1]!)}`],
  [/^continuous \(per second\), quoted per (\d+ (?:h|s))$/, (m) => `en continu (à la seconde), affiché par ${interval(m[1]!)}`],
  [/^(\S+)× \(contract bound; lower in practice and falling with open interest\)$/, (m) => `${num(m[1]!)}× (borne du contrat ; plus bas en pratique et décroissant avec l’intérêt ouvert)`],
  [/^(\S+) USD notional$/, (m) => `${num(m[1]!)} USD de notionnel`],
];

/** one server-authored sentence in the requested language; `en` and unknown sentences are returned unchanged */
export function marketText(text: string, locale: TextLocale): string {
  if (locale !== 'fr') return text;
  const exact = EXACT.get(text);
  if (exact !== undefined) return exact;
  for (const [re, fr] of PATTERNS) { const m = re.exec(text); if (m) return fr(m); }
  return text;
}
/** true when `marketText` has a French variant for this sentence (tests: nothing shown by the UI is left behind silently) */
export const hasFrench = (text: string): boolean => marketText(text, 'fr') !== text;

// ------------------------------------------------------------------ answers

const tr = (locale: TextLocale) => (s: string): string => marketText(s, locale);
/** the collateral of an instrument is a symbol, or two symbols joined by the adapter's « or » (GMX: the pool's long or short token) */
export const collateralText = (s: string, locale: TextLocale): string => (locale === 'fr' ? s.replace(/^(\S+) or (\S+)$/, '$1 ou $2') : s);

/** `GET /derivatives/compare`: `settlement`, `restriction`, every note of each row, and the « or » of a two-token `collateral`; adds `locale` */
export function localizeCompare<T extends { rows: { collateral: string; settlement: string; restriction: string | null; notes: string[] }[] }>(answer: T, locale: TextLocale): T & { locale: TextLocale } {
  if (locale !== 'fr') return { ...answer, locale };
  const t = tr(locale);
  return { ...answer, locale, rows: answer.rows.map((r) => ({ ...r, collateral: collateralText(r.collateral, locale), settlement: t(r.settlement), restriction: r.restriction === null ? null : t(r.restriction), notes: r.notes.map(t) })) };
}
/** `GET /derivatives/instruments`: `settlement`, `markPriceMethod` and the « or » of a two-token `collateral`; adds `locale` */
export function localizeInstruments<T extends { instruments: { collateral: string; settlement: string; markPriceMethod: string }[] }>(answer: T, locale: TextLocale): T & { locale: TextLocale } {
  if (locale !== 'fr') return { ...answer, locale };
  const t = tr(locale);
  return { ...answer, locale, instruments: answer.instruments.map((i) => ({ ...i, collateral: collateralText(i.collateral, locale), settlement: t(i.settlement), markPriceMethod: t(i.markPriceMethod) })) };
}
interface Term { value: string; source: string }
interface RouteLike {
  warnings: string[];
  candidates: { terms: Record<string, Term> }[];
  differences: { fields: { field: string; values: { value: string }[] }[] };
}
/** contract terms whose value is a sentence or a word; tick and lot are figures, collateral is symbols (only its « or » is translated) */
const TEXT_TERMS = new Set(['structure', 'execution', 'settlement', 'quote', 'markPrice', 'fundingInterval', 'fundingRule', 'otherCarry', 'maxLeverage', 'marginModes', 'sizeUnit', 'minOrder', 'maintenance', 'liquidation', 'fees']);
/**
 * `POST /derivatives/route`: the engine messages (`warnings`) and the contract terms (`candidates[].terms`, and the same values
 * in `differences.fields`); adds `locale`. Everything else — cost `basis` and `uncertainty`, reason `message`s, margin methods,
 * `ranking.note`, `differences.statement` — stays as the engine wrote it (English): see docs/v4/API-LIVE-NOTES.md, « V8 ».
 */
export function localizeRoute<T extends RouteLike>(answer: T, locale: TextLocale): T & { locale: TextLocale } {
  if (locale !== 'fr') return { ...answer, locale };
  const t = tr(locale), term = (k: string, v: string): string => (k === 'collateral' ? collateralText(v, locale) : TEXT_TERMS.has(k) ? t(v) : v);
  return {
    ...answer, locale, warnings: answer.warnings.map(t),
    candidates: answer.candidates.map((c) => ({ ...c, terms: Object.fromEntries(Object.entries(c.terms).map(([k, v]) => [k, { ...v, value: term(k, v.value) }])) })),
    differences: { ...answer.differences, fields: answer.differences.fields.map((f) => ({ ...f, values: f.values.map((v) => ({ ...v, value: term(f.field, v.value) })) })) },
  };
}
