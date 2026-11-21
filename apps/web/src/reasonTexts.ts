/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/reasonTexts.ts
 * Module           : web
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
 * Last Modified    : 2026-11-16
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

// v8 hardening (D2): the `reason` inside an alert is a sentence the server wrote in English when the event happened (it is
// stored with the alert, so it cannot follow the language of the screen). The sentences below are the ones the server writes
// itself, word for word or with figures; they are shown in French on a French screen. Any other reason — a venue's or a
// network's own error text, a strategy's message — is left exactly as the server stored it.
// Pure and without imports: used by the alert list and by the service worker (push notifications).

const NUM = '(\\d+(?:\\.\\d+)?)';
const fr = (s: string): string => s.replace('.', ',');

const EXACT: Record<string, string> = {
  'the mint transaction reverted on the destination; the funds are not lost, finish the transfer with your passkey': 'la transaction de frappe a été annulée sur le réseau de destination ; les fonds ne sont pas perdus, terminez le transfert avec votre clé d’accès',
  'mandate expired': 'le mandat est arrivé à échéance',
  'the approved strategy no longer matches the mandate': 'la stratégie approuvée ne correspond plus au mandat',
  'stopped by the owner': 'arrêté par le propriétaire',
  'the approved version is not a perpetual-futures strategy (contract 2)': 'la version approuvée n’est pas une stratégie de contrats perpétuels (contrat 2)',
  // the stop reasons of a live perp agent (services/api/src/agents/perp-live-cycle.ts)
  'the mandate is no longer in force on the venue account': 'le mandat n’est plus en vigueur sur le compte de la plateforme',
  'the venue authorization was revoked or has expired': 'l’autorisation de la plateforme a été révoquée ou est arrivée à échéance',
  'live trading on mainnet is switched off on the server': 'la négociation réelle sur le réseau principal est désactivée sur le serveur',
  'autonomous (mandate) trading on mainnet is switched off on the server': 'la négociation autonome (mandat) sur le réseau principal est désactivée sur le serveur',
  'trading was halted on the venue account': 'la négociation a été arrêtée sur le compte de la plateforme',
  'the venue\'s state and the wallet\'s records differ (an order or a position the wallet did not create)': 'l’état de la plateforme et les registres du portefeuille diffèrent (un ordre ou une position que le portefeuille n’a pas créés)',
  'a manual order was placed on the venue account while the agent was live': 'un ordre manuel a été passé sur le compte de la plateforme pendant que l’agent était en marche',
  'the venue liquidated a position of the account': 'la plateforme a liquidé une position du compte',
  'the approved strategy version is no longer the one pinned in the mandate': 'la version approuvée de la stratégie n’est plus celle qui est épinglée dans le mandat',
  'a loss limit of the agent was reached': 'une limite de perte de l’agent a été atteinte',
  'the engine stopped the agent': 'le moteur a arrêté l’agent',
  'the signer reports the mandate as revoked': 'le signataire indique que le mandat est révoqué',
  'the signer reports the mandate as expired': 'le signataire indique que le mandat est arrivé à échéance',
  'the signer only signs reduce-only orders for this mandate (wind-down)': 'le signataire ne signe plus que des ordres de réduction pour ce mandat (liquidation ordonnée)',
  'the signer no longer holds the venue authorization': 'le signataire ne détient plus l’autorisation de la plateforme',
  // v11 interface (audit B3 remainder) — an agent's withdrawal (services/api/src/agents/withdrawals.ts)
  'interrupted during signing; nothing was sent': 'interrompu pendant la signature ; rien n’a été envoyé',
  'incomplete withdrawal; nothing was sent': 'retrait incomplet ; rien n’a été envoyé',
  'broadcast is disabled on this server; nothing was sent': 'la diffusion est désactivée sur ce serveur ; rien n’a été envoyé',
  'the transaction could not be relayed in time; nothing was sent': 'la transaction n’a pas pu être relayée à temps ; rien n’a été envoyé',
  'the transaction reverted on-chain; only the network fee was spent': 'la transaction a été annulée sur la chaîne ; seuls les frais de réseau ont été dépensés',
  'mined, but the payment to your address was not found in the transaction: check the explorer': 'minée, mais le paiement vers votre adresse n’a pas été trouvé dans la transaction : vérifiez dans l’explorateur',
  'another transaction of the vault used the same nonce; this withdrawal was not executed': 'une autre transaction du coffre a utilisé le même nonce ; ce retrait n’a pas été exécuté',
  // research jobs (services/api/src/research/routes.ts)
  'cancelled by the owner': 'annulé par le propriétaire',
  'the runner stopped reporting (no log line or heartbeat for 5 minutes)': 'l’exécuteur a cessé de répondre (aucune ligne de journal ni signal de vie depuis 5 minutes)',
  // system status: what a connector measured (services/api/src/monitor/health.ts)
  'Signer': 'Signataire', 'Market data · quality': 'Données de marché · qualité',
  'answering': 'répond', 'no answer': 'aucune réponse', 'halted': 'à l’arrêt', 'not checked yet': 'pas encore vérifié', 'newest BTC bar': 'dernière barre BTC',
  'last equity snapshot': 'dernier relevé de valeur', 'no active account: not measured': 'aucun compte actif : non mesuré', 'last quote asked': 'dernière cotation demandée',
  'no recent quote: not measured': 'aucune cotation récente : non mesuré', 'no transfer in flight: not measured': 'aucun transfert en cours : non mesuré',
};
const PATTERNS: [RegExp, (m: RegExpExecArray) => string][] = [
  [new RegExp(`^loss limit reached: equity ${NUM} USD against ${NUM} USD allocated \\(limit ${NUM} %\\); positions were sold to (\\S+)$`),
    (m) => `limite de perte atteinte : valeur de ${fr(m[1]!)} USD pour ${fr(m[2]!)} USD alloués (limite de ${fr(m[3]!)} %) ; les positions ont été vendues contre des ${m[4]}`],
  [new RegExp(`^total loss limit reached: equity ${NUM} USDC against ${NUM} allocated \\(limit ${NUM} %\\)$`),
    (m) => `limite de perte totale atteinte : valeur de ${fr(m[1]!)} USDC pour ${fr(m[2]!)} alloués (limite de ${fr(m[3]!)} %)`],
  [new RegExp(`^daily loss limit reached: equity ${NUM} USDC against ${NUM} at the start of the day \\(limit ${NUM} % of the capital\\)$`),
    (m) => `limite de perte quotidienne atteinte : valeur de ${fr(m[1]!)} USDC pour ${fr(m[2]!)} en début de journée (limite de ${fr(m[3]!)} % du capital)`],
  // v11 interface (audit B3 remainder)
  [/^refused by the signer: (.+)$/, (m) => `refusé par le signataire — message d’origine, en anglais : « ${m[1]} »`],
  [/^not relayed yet: (.+)$/, (m) => `pas encore relayée — message d’origine, en anglais : « ${m[1]} »`],
  [/^no data set: (.+)$/, (m) => `aucun jeu de données — message d’origine, en anglais : « ${m[1]} »`],
  [/^the account holds (.+), which this agent does not manage$/, (m) => `le compte détient ${m[1]}, que cet agent ne gère pas`],
  [/^(\d+)\/(\d+) endpoints(, degraded)?(, identity not verified)?$/, (m) => `${m[1]}/${m[2]} points d’accès${m[3] ? ', dégradé' : ''}${m[4] ? ', identité non vérifiée' : ''}`],
  [/^Market data · (.+)$/, (m) => `Données de marché · ${m[1]}`],
  [/^(\d+)\/(\d+) series fresh$/, (m) => `${m[1]}/${m[2]} séries à jour`],
  [/^(\d+) transfer\(s\) awaiting attestation$/, (m) => `${m[1]} transfert(s) en attente d’attestation`],
];

/** is the server's own wording known here (so that a French screen can show it in French)? */
export function reasonKnown(reason: string): boolean { return EXACT[reason] !== undefined || PATTERNS.some(([re]) => re.test(reason)); }

/** a server reason in the screen's language when the server's own wording is known; otherwise unchanged */
export function reasonText(reason: string, locale: string): string {
  if (locale !== 'fr') return reason;
  const exact = EXACT[reason];
  if (exact !== undefined) return exact;
  for (const [re, f] of PATTERNS) { const m = re.exec(reason); if (m) return f(m); }
  return reason;
}
/** the parameters of an alert with its `reason` in the screen's language (every other parameter untouched) */
export function localizeAlertParams<P extends Record<string, unknown>>(params: P, locale: string): P {
  return typeof params.reason === 'string' && locale === 'fr' ? { ...params, reason: reasonText(params.reason, locale) } : params;
}
