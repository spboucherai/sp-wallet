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
};
const PATTERNS: [RegExp, (m: RegExpExecArray) => string][] = [
  [new RegExp(`^loss limit reached: equity ${NUM} USD against ${NUM} USD allocated \\(limit ${NUM} %\\); positions were sold to (\\S+)$`),
    (m) => `limite de perte atteinte : valeur de ${fr(m[1]!)} USD pour ${fr(m[2]!)} USD alloués (limite de ${fr(m[3]!)} %) ; les positions ont été vendues contre des ${m[4]}`],
  [new RegExp(`^total loss limit reached: equity ${NUM} USDC against ${NUM} allocated \\(limit ${NUM} %\\)$`),
    (m) => `limite de perte totale atteinte : valeur de ${fr(m[1]!)} USDC pour ${fr(m[2]!)} alloués (limite de ${fr(m[3]!)} %)`],
  [new RegExp(`^daily loss limit reached: equity ${NUM} USDC against ${NUM} at the start of the day \\(limit ${NUM} % of the capital\\)$`),
    (m) => `limite de perte quotidienne atteinte : valeur de ${fr(m[1]!)} USDC pour ${fr(m[2]!)} en début de journée (limite de ${fr(m[3]!)} % du capital)`],
];

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
