/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/derivatives/src/live/jurisdiction.ts
 * Module           : live
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-10
 * Last Modified    : 2026-11-15
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

// Jurisdiction acknowledgement shown before live derivative trading is enabled on a venue. ONE constant, mirroring
// docs/v4/venues/jurisdiction.md (read live on 2026-11-10). The authorization the owner approves commits to the SHA-256 of the
// exact text displayed; the signer accepts only a hash of one of these texts.
//
// This is a summary of what the venue's terms and the regulator's public pages say. It is general information, not legal advice,
// and nothing here states or implies that trading on the venue is lawful or cleared for the owner.
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from './canonical.ts';

export type AckLocale = 'fr' | 'en';
export const JURISDICTION_ACK_VERSION = '2026-11-10';
export const JURISDICTION_ACK_SOURCE = 'docs/v4/venues/jurisdiction.md';

/** v8: `gmx` added (same mechanism, its own text) */
export type AckVenue = 'hyperliquid' | 'gmx';
export const JURISDICTION_ACK: Record<AckVenue, Record<AckLocale, string>> = {
  hyperliquid: {
    en: [
      'Hyperliquid — the venue\'s terms and your jurisdiction (Québec, Canada). Read on 2026-11-10.',
      'This is general information, not legal advice. It is not a legal clearance, and SP Wallet gives none.',
      '1. Hyperliquid\'s terms of use (app.hyperliquid.xyz, last updated 2026-06-15, §1.6) exclude persons in the United States of America and in Ontario, Canada. Québec is not named. Those terms govern the website interface; §1.1 says the interface is not the exclusive means of access. No API terms and no documented API geo-blocking were found.',
      '2. §1.9 of those terms makes you solely responsible for determining whether leveraged or derivative trading is lawful where you live.',
      '3. The AMF\'s public page on buying and selling crypto says that platforms letting Québec clients trade crypto assets that are securities or derivatives must be registered with the AMF, and advises against dealing with platforms that are neither registered nor under a pre-registration undertaking. Hyperliquid is not on the AMF\'s register of crypto trading platforms (checked 2026-11-10). CSA Staff Notice 21-332 (2023) requires registered or undertaking platforms not to offer leverage to Canadian clients.',
      '4. Not verified: the AMF\'s warning list could not be searched in full; whether the venue blocks a Québec IP address in practice.',
      '5. SP Wallet does not work around any access restriction (no VPN, no proxy, no alternative path to a blocked service).',
      'By approving, you confirm that you have read this summary and that enabling live derivative trading on this venue is your own decision and your own responsibility. Your confirmation is recorded in the audit log.',
    ].join('\n'),
    fr: [
      'Hyperliquid — conditions de la plateforme et votre juridiction (Québec, Canada). Lu le 2026-11-10.',
      'Ceci est une information générale, pas un avis juridique. Ce n\'est pas une validation juridique, et SP Wallet n\'en donne aucune.',
      '1. Les conditions d\'utilisation de Hyperliquid (app.hyperliquid.xyz, mises à jour le 2026-06-15, §1.6) excluent les personnes situées aux États-Unis d\'Amérique et en Ontario (Canada). Le Québec n\'est pas nommé. Ces conditions régissent l\'interface du site web ; le §1.1 précise que l\'interface n\'est pas le seul moyen d\'accès. Aucune condition propre à l\'API ni aucun blocage géographique documenté de l\'API n\'a été trouvé.',
      '2. Le §1.9 de ces conditions vous rend seul responsable de déterminer si la négociation avec effet de levier ou de dérivés est licite là où vous résidez.',
      '3. La page publique de l\'AMF sur l\'achat et la vente de cryptoactifs indique que les plateformes qui permettent à des clients du Québec de négocier des cryptoactifs constituant des valeurs mobilières ou des dérivés doivent être inscrites auprès de l\'AMF, et déconseille de faire affaire avec des plateformes qui ne sont ni inscrites ni visées par un engagement de préinscription. Hyperliquid ne figure pas au registre de l\'AMF des plateformes de négociation de cryptoactifs (vérifié le 2026-11-10). L\'Avis 21-332 du personnel des ACVM (2023) exige des plateformes inscrites ou sous engagement qu\'elles n\'offrent pas d\'effet de levier aux clients canadiens.',
      '4. Non vérifié : la liste de mises en garde de l\'AMF n\'a pas pu être consultée en entier ; le blocage éventuel d\'une adresse IP du Québec par la plateforme en pratique.',
      '5. SP Wallet ne contourne aucune restriction d\'accès (ni VPN, ni proxy, ni chemin détourné vers un service bloqué).',
      'En approuvant, vous confirmez avoir lu ce résumé et que l\'activation de la négociation réelle de dérivés sur cette plateforme est votre propre décision et votre propre responsabilité. Votre confirmation est consignée dans le journal d\'audit.',
    ].join('\n'),
  },
  // >>> v8 GMX v2 trading (additive) — mirrors the GMX row of docs/v4/venues/jurisdiction.md
  gmx: {
    en: [
      'GMX v2 — the venue\'s terms and your jurisdiction (Québec, Canada). Read on 2026-11-10.',
      'This is general information, not legal advice. It is not a legal clearance, and SP Wallet gives none.',
      '1. The terms of gmx.io / app.gmx.io (last modified 2026-08-20) do not name Canada. They exclude U.S. persons (1.1.3) and residents of territories under U.S., U.K. or E.U. sanctions (1.1.4), and forbid using a VPN to get around a restriction (1.1.7). Those terms govern the site and the interface; the contracts on Arbitrum are permissionless and SP Wallet talks to them directly.',
      '2. Clause 1.1.8 ("Applicable Laws") makes you responsible for complying with the laws that apply to you, federal and provincial: whether leveraged derivative trading is lawful where you live is for you to determine.',
      '3. The AMF\'s public page on buying and selling crypto says that platforms letting Québec clients trade crypto assets that are securities or derivatives must be registered with the AMF, and advises against dealing with platforms that are neither registered nor under a pre-registration undertaking. GMX is not on the AMF\'s register of crypto trading platforms (checked 2026-11-10). CSA Staff Notice 21-332 (2023) requires registered or undertaking platforms not to offer leverage to Canadian clients.',
      '4. Not verified: the AMF\'s warning list could not be searched in full; whether the venue\'s interface blocks a Québec IP address in practice.',
      '5. SP Wallet does not work around any access restriction (no VPN, no proxy, no alternative path to a blocked service).',
      '6. On GMX an order is a transaction of your own wallet: your collateral leaves the wallet for GMX\'s contracts, the order is executed or cancelled later by GMX\'s keepers at GMX\'s oracle price, and a position can be liquidated. GMX\'s role holders can change market parameters and replace contracts.',
      'By approving, you confirm that you have read this summary and that enabling live derivative trading on this venue is your own decision and your own responsibility. Your confirmation is recorded in the audit log.',
    ].join('\n'),
    fr: [
      'GMX v2 — conditions de la plateforme et votre juridiction (Québec, Canada). Lu le 2026-11-10.',
      'Ceci est une information générale, pas un avis juridique. Ce n\'est pas une validation juridique, et SP Wallet n\'en donne aucune.',
      '1. Les conditions de gmx.io / app.gmx.io (modifiées le 2026-08-20) ne nomment pas le Canada. Elles excluent les personnes des États-Unis (1.1.3) et les résidents de territoires visés par des sanctions des États-Unis, du Royaume-Uni ou de l\'Union européenne (1.1.4), et interdisent l\'usage d\'un VPN pour contourner une restriction (1.1.7). Ces conditions régissent le site et l\'interface ; les contrats sur Arbitrum sont sans permission et SP Wallet s\'y adresse directement.',
      '2. La clause 1.1.8 (« Applicable Laws ») vous rend responsable du respect des lois qui s\'appliquent à vous, fédérales et provinciales : c\'est à vous de déterminer si la négociation de dérivés avec effet de levier est licite là où vous résidez.',
      '3. La page publique de l\'AMF sur l\'achat et la vente de cryptoactifs indique que les plateformes qui permettent à des clients du Québec de négocier des cryptoactifs constituant des valeurs mobilières ou des dérivés doivent être inscrites auprès de l\'AMF, et déconseille de faire affaire avec des plateformes qui ne sont ni inscrites ni visées par un engagement de préinscription. GMX ne figure pas au registre de l\'AMF des plateformes de négociation de cryptoactifs (vérifié le 2026-11-10). L\'Avis 21-332 du personnel des ACVM (2023) exige des plateformes inscrites ou sous engagement qu\'elles n\'offrent pas d\'effet de levier aux clients canadiens.',
      '4. Non vérifié : la liste de mises en garde de l\'AMF n\'a pas pu être consultée en entier ; le blocage éventuel d\'une adresse IP du Québec par l\'interface de la plateforme en pratique.',
      '5. SP Wallet ne contourne aucune restriction d\'accès (ni VPN, ni proxy, ni chemin détourné vers un service bloqué).',
      '6. Sur GMX, un ordre est une transaction de votre propre portefeuille : votre garantie quitte le portefeuille pour les contrats de GMX, l\'ordre est exécuté ou annulé plus tard par les « keepers » de GMX au prix de l\'oracle de GMX, et une position peut être liquidée. Les titulaires de rôles de GMX peuvent modifier les paramètres des marchés et remplacer des contrats.',
      'En approuvant, vous confirmez avoir lu ce résumé et que l\'activation de la négociation réelle de dérivés sur cette plateforme est votre propre décision et votre propre responsabilité. Votre confirmation est consignée dans le journal d\'audit.',
    ].join('\n'),
  },
  // <<< v8 GMX v2 trading
};

export interface JurisdictionAck { venue: AckVenue; locale: AckLocale; text: string; sha256: string; version: string; source: string }

export function jurisdictionAck(venue: AckVenue, locale: AckLocale): JurisdictionAck {
  const text = JURISDICTION_ACK[venue][locale];
  return { venue, locale, text, sha256: hex(sha256(new TextEncoder().encode(text))), version: JURISDICTION_ACK_VERSION, source: JURISDICTION_ACK_SOURCE };
}
/** which displayed text a hash stands for; null when it is none of them */
export function jurisdictionAckOf(venue: AckVenue, sha: string): JurisdictionAck | null {
  for (const locale of ['fr', 'en'] as const) { const a = jurisdictionAck(venue, locale); if (a.sha256 === sha) return a; }
  return null;
}

// >>> v11 edgeX (additive). NOT an acknowledgement: there is nothing to approve. A venue whose terms name the owner's country
// as blocked is integrated for market data only (the rule already applied to dYdX), and no text here can enable trading on it.
// Mirrors the edgeX row of docs/v4/venues/jurisdiction.md. General information, not legal advice.
export interface VenueJurisdictionBlock {
  venue: 'edgex'; reason: string; readOn: string; termsUrl: string; termsUpdated: string;
  /** verbatim quotes of the venue's Terms of Use */
  clauses: string[];
  notice: Record<AckLocale, string>;
}
export const EDGEX_BLOCKED_JURISDICTION: VenueJurisdictionBlock = {
  venue: 'edgex', reason: 'edgex_trading_restricted_jurisdiction', readOn: '2026-11-15',
  termsUrl: 'https://edgex-1.gitbook.io/edgeX-documentation/about/terms-of-use', termsUpdated: '2026-10-04',
  clauses: [
    'THE edgeX INTERFACE (AS DEFINED BELOW) IS NOT AVAILABLE TO PERSONS OR ENTITIES WHO RESIDE IN, ARE LOCATED IN, ARE INCORPORATED IN, OR HAVE A REGISTERED OFFICE IN THE UNITED STATES OF AMERICA OR CANADA (COLLECTIVELY, "BLOCKED PERSONS"). … WE DO NOT MAKE EXCEPTIONS; THEREFORE, IF YOU ARE A BLOCKED PERSON, THEN DO NOT ATTEMPT TO USE THE edgeX INTERFACE … USE OF A VIRTUAL PRIVATE NETWORK ("VPN") TO CIRCUMVENT THE RESTRICTIONS SET FORTH HEREIN IS PROHIBITED.',
    '12.1 … As a result of restrictions under the Commodity Exchange Act and the regulations promulgated thereunder by the U.S. Commodity Futures Trading Commission ("CFTC"), no Blocked Person may enter into Perpetual Contracts using the Services.',
  ],
  notice: {
    en: 'Trading unavailable: edgeX\'s terms exclude Canada. edgeX is shown for its market data only; no account, no order and no simulated account are offered on it, and SP Wallet does not work around the restriction.',
    fr: 'Négociation indisponible : les conditions d\'edgeX excluent le Canada. edgeX est affiché pour ses données de marché seulement ; aucun compte, aucun ordre et aucun compte de simulation n\'y sont offerts, et SP Wallet ne contourne pas la restriction.',
  },
};
// <<< v11 edgeX
