/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/derivatives/mockLiveTexts.ts
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-11
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

/**
 * DEVELOPMENT BUILDS ONLY (imported by mockLive.ts alone). A verbatim COPY of the server-authored texts of controlled live
 * trading — services/api/src/derivatives/live-texts.ts — so that the dev mock answers with the same French and English
 * sentences as the backend (the web app cannot import from services/). Only the import below and the two aliases at the end
 * differ. If the server's texts change, copy them again.
 */
// Server-authored human texts of controlled live trading, in French and English. They are selected by a `locale` parameter
// (query `?locale=fr|en` on GET routes, the `locale` field of the body on the prepare routes; default `en`, which is the text
// these routes always returned). Machine-readable codes never change with the locale. Shape: docs/v4/API-LIVE-NOTES.md.
import { VENUE_MANDATE_WIND_DOWN_S } from '../../../../packages/derivatives/src/live/mandate.ts';

export type LiveLocale = 'fr' | 'en';
export const LIVE_LOCALES = ['fr', 'en'] as const;
export const liveLocale = (x: unknown): LiveLocale => (x === 'fr' ? 'fr' : 'en');

const HOURS = VENUE_MANDATE_WIND_DOWN_S / 3600;
type Both = Record<LiveLocale, string>;

/** reasons the server gives for a refusal that the UI shows as a sentence; the key is the error code */
export const LIVE_REASONS = {
  mainnet_disabled: {
    en: 'live trading on Hyperliquid MAINNET is disabled on this server (SPW_DERIV_LIVE_MAINNET is not "on"): nothing was built, signed or sent. The testnet account works.',
    fr: 'la négociation réelle sur le MAINNET de Hyperliquid est désactivée sur ce serveur (SPW_DERIV_LIVE_MAINNET n\'est pas à « on ») : rien n\'a été construit, signé ni envoyé. Le compte testnet fonctionne.',
  },
  mandate_mainnet_disabled: {
    en: 'autonomous (mandate) trading on Hyperliquid MAINNET is disabled on this server: it needs SPW_DERIV_LIVE_MAINNET=on AND SPW_DERIV_MANDATE_MAINNET=on. Nothing was built, signed or sent. Mandates work on the testnet account.',
    fr: 'la négociation autonome (mandat) sur le MAINNET de Hyperliquid est désactivée sur ce serveur : elle exige SPW_DERIV_LIVE_MAINNET=on ET SPW_DERIV_MANDATE_MAINNET=on. Rien n\'a été construit, signé ni envoyé. Les mandats fonctionnent sur le compte testnet.',
  },
  mandate_unavailable: {
    en: 'derivative mandates are not available on this server (the signer connection does not offer them)',
    fr: 'les mandats de dérivés ne sont pas disponibles sur ce serveur (la connexion au signataire ne les offre pas)',
  },
} as const satisfies Record<string, Both>;
export type LiveReasonCode = keyof typeof LIVE_REASONS;
export const liveReason = (code: LiveReasonCode, locale: LiveLocale = 'en'): string => LIVE_REASONS[code][locale];

const T = {
  depositsHow: {
    en: 'docs/v4/venues/hyperliquid.md, section 15: native USDC on Arbitrum sent by the wallet itself to the pinned venue bridge, with the passkey (venue minimum 5 USDC; the wallet refuses less than 6) — routes …/collateral/status and …/collateral/deposit/…; mainnet only (testnet collateral is mock USDC from the venue faucet)',
    fr: 'docs/v4/venues/hyperliquid.md, section 15 : USDC natif sur Arbitrum envoyé par le portefeuille lui-même au pont épinglé de la plateforme, avec la clé d\'accès (minimum de la plateforme 5 USDC ; le portefeuille refuse moins de 6) — routes …/collateral/status et …/collateral/deposit/… ; réseau principal seulement (sur le testnet, la garantie est de l\'USDC fictif du robinet de la plateforme)',
  },
  withdrawalsHow: {
    en: 'routes …/collateral/withdraw/…: the user-signed withdraw3 action, signed by the wallet key after a passkey approval, to the wallet\'s own address only; venue fee 1 USDC (same section)',
    fr: 'routes …/collateral/withdraw/… : l\'action withdraw3 signée par la clé du portefeuille après approbation par clé d\'accès, uniquement vers l\'adresse du portefeuille ; frais de la plateforme 1 USDC (même section)',
  },
  agentNote: {
    en: 'On the venue an API wallet could also move collateral between the account\'s own balances; the signer refuses to sign anything but orders, cancels and leverage changes.',
    fr: 'Sur la plateforme, un portefeuille API pourrait aussi déplacer la garantie entre les soldes du compte lui-même ; le signataire refuse de signer autre chose que des ordres, des annulations et des changements de levier.',
  },
  byMainKey: {
    en: 'one approveAgent action naming the trading key above (the wallet key signs nothing else to trade; its only other venue message is a withdrawal to the wallet\'s own address, approved separately with the passkey)',
    fr: 'une seule action approveAgent désignant la clé de négociation ci-dessus (la clé du portefeuille ne signe rien d\'autre pour négocier ; son seul autre message pour la plateforme est un retrait vers l\'adresse du portefeuille, approuvé à part avec la clé d\'accès)',
  },
  byPasskey: {
    en: 'the SHA-256 of this authorization, which includes the hash of the acknowledgement text',
    fr: 'le SHA-256 de cette autorisation, qui inclut l\'empreinte du texte de reconnaissance',
  },
  mandateByPasskey: {
    en: 'the SHA-256 of this mandate: every limit below, the strategy code hash, the agent, the expiry and the hash of the acknowledgement text. Nothing is signed by a key at this step.',
    fr: 'le SHA-256 de ce mandat : chaque limite ci-dessous, l\'empreinte du code de la stratégie, l\'agent, l\'échéance et l\'empreinte du texte de reconnaissance. Aucune clé ne signe quoi que ce soit à cette étape.',
  },
  mandateWarning: {
    en: 'After this approval, orders inside these limits are placed WITHOUT asking for your passkey. Manual orders still need it.',
    fr: 'Après cette approbation, les ordres à l\'intérieur de ces limites sont placés SANS demander votre clé d\'accès. Les ordres manuels l\'exigent toujours.',
  },
  windDown: {
    en: `When the mandate is revoked or expires, no order that can add exposure is signed any more. For ${HOURS} hours the signer still signs cancels and reduce-only orders, so that the engine can close positions; after that, nothing. Revoking the venue authorization stops everything at once, cancels and closes included. Open positions are NOT closed by a revocation: close them, or let the engine do it during the wind-down.`,
    fr: `Quand le mandat est révoqué ou expire, plus aucun ordre pouvant ajouter de l'exposition n'est signé. Pendant ${HOURS} heures, le signataire signe encore les annulations et les ordres en réduction seule, pour que le moteur puisse fermer les positions ; ensuite, plus rien. Révoquer l'autorisation de la plateforme arrête tout immédiatement, annulations et fermetures comprises. Une révocation NE ferme PAS les positions ouvertes : fermez-les, ou laissez le moteur le faire pendant la période de liquidation.`,
  },
  venueAgent: {
    en: 'The trading key stays registered at the venue until its expiry, but it exists only in the signer, which now refuses to use it.',
    fr: 'La clé de négociation reste enregistrée sur la plateforme jusqu\'à son échéance, mais elle n\'existe que dans le signataire, qui refuse désormais de l\'utiliser.',
  },
} as const satisfies Record<string, Both>;

const LISTS = {
  can: { en: ['place orders', 'cancel orders', 'change leverage'], fr: ['placer des ordres', 'annuler des ordres', 'changer le levier'] },
  cannot: { en: ['withdraw', 'transfer to another address'], fr: ['retirer des fonds', 'transférer vers une autre adresse'] },
  enforcedBySigner: {
    en: [
      'allowed instruments; one order per signature; orders, cancels and leverage changes only',
      'notional of each order; price of each order and trigger within the band around the signer\'s own price (two exchanges)',
      'worst-case position per instrument and worst-case gross exposure: the venue\'s positions read by the signer itself, plus every resting order and every order it signed that could still fill, plus the new order',
      'orders per day and per hour, daily turnover (orders that can add exposure)',
      'account value floor: below it, only cancels and reduce-only orders',
      'leverage: never above the mandate; no margin-mode change while a position is open',
      'venue expiry of every signature (at most 120 s), nonce and client id never reused',
    ],
    fr: [
      'instruments permis ; un ordre par signature ; ordres, annulations et changements de levier seulement',
      'notionnel de chaque ordre ; prix de chaque ordre et de chaque déclencheur dans la bande autour du prix propre du signataire (deux bourses)',
      'position maximale par instrument et exposition brute maximale dans le pire cas : les positions de la plateforme lues par le signataire lui-même, plus chaque ordre en attente et chaque ordre signé pouvant encore s\'exécuter, plus le nouvel ordre',
      'ordres par jour et par heure, volume quotidien (ordres pouvant ajouter de l\'exposition)',
      'plancher de valeur du compte : en dessous, seulement des annulations et des ordres en réduction seule',
      'levier : jamais au-dessus du mandat ; aucun changement de mode de marge tant qu\'une position est ouverte',
      'échéance de chaque signature sur la plateforme (120 s au plus), nonce et identifiant client jamais réutilisés',
    ],
  },
  trustedBySigner: {
    en: [
      'the venue\'s public info endpoint, for the size of the positions, the resting orders and the account value (the venue already holds the funds and executes the orders)',
      'the venue, to enforce reduce-only and the expiry of a signed order',
      'two public exchanges (Coinbase, Kraken), for prices',
    ],
    fr: [
      'le point d\'accès public d\'information de la plateforme, pour la taille des positions, les ordres en attente et la valeur du compte (la plateforme détient déjà les fonds et exécute les ordres)',
      'la plateforme, pour faire respecter la réduction seule et l\'échéance d\'un ordre signé',
      'deux bourses publiques (Coinbase, Kraken), pour les prix',
    ],
  },
  notEnforced: {
    en: [
      'that the strategy code running is the one whose hash you approved (the hash is recorded, not verified)',
      'profit: inside its limits a strategy can lose money; exposure is bounded when an order is signed, at the price of that moment',
    ],
    fr: [
      'que le code de stratégie exécuté soit celui dont vous avez approuvé l\'empreinte (l\'empreinte est consignée, pas vérifiée)',
      'le profit : à l\'intérieur de ses limites, une stratégie peut perdre de l\'argent ; l\'exposition est bornée au moment où un ordre est signé, au prix de ce moment',
    ],
  },
} as const satisfies Record<string, Record<LiveLocale, readonly string[]>>;

export function liveTexts(locale: LiveLocale = 'en') {
  const t = <K extends keyof typeof T>(k: K): string => T[k][locale];
  const l = <K extends keyof typeof LISTS>(k: K): string[] => [...LISTS[k][locale]];
  return {
    locale, depositsHow: t('depositsHow'), withdrawalsHow: t('withdrawalsHow'), agentNote: t('agentNote'), byMainKey: t('byMainKey'), byPasskey: t('byPasskey'), venueAgent: t('venueAgent'),
    mandateByPasskey: t('mandateByPasskey'), mandateWarning: t('mandateWarning'), windDown: t('windDown'),
    can: l('can'), cannot: l('cannot'), enforcedBySigner: l('enforcedBySigner'), trustedBySigner: l('trustedBySigner'), notEnforced: l('notEnforced'),
  };
}

export type MockLocale = LiveLocale;
export const mockLiveReasons = LIVE_REASONS;
export const mockLiveTexts = (locale: unknown) => liveTexts(liveLocale(locale));
