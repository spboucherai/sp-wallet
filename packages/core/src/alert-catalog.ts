// Alert catalogue — the ONE place where an alert kind, its default severity, its default switch and its FR/EN wording live.
// No import: this file is shared as-is by the API (rules, webhook), the web app (Alerts screen) and the service worker (push).
// An alert stores a kind and parameters, never a sentence; the sentence is produced where it is shown, in that device's language.
//
// `body` may use every parameter. `priv` is the lock-screen wording used when "show details" is off: it may only use the
// parameters listed in SAFE_PARAMS (names, networks, counts, durations) — never an amount, a price, an address or a reason text.

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertGroup = 'transfers' | 'agents' | 'derivatives' | 'security' | 'system';
export type AlertLocale = 'fr' | 'en';
export type AlertParams = Record<string, string | number | boolean | null>;
/** what an alert is about; the client turns it into a deep link */
export interface AlertSubject { type: 'proposal' | 'agent' | 'account' | 'network' | 'deposit' | 'plan' | 'none'; id?: string; network?: string }
type Pair = readonly [fr: string, en: string];
export interface AlertDef {
  kind: string; group: AlertGroup; severity: AlertSeverity;
  /** default state of the owner's switch */
  on: boolean;
  /** not switchable (the cap summary and the test notification) */
  fixed?: boolean;
  title: Pair; body: Pair; priv?: Pair;
}

const d = (kind: string, group: AlertGroup, severity: AlertSeverity, on: boolean, title: Pair, body: Pair, priv?: Pair, fixed?: boolean): AlertDef =>
  ({ kind, group, severity, on, title, body, ...(priv ? { priv } : {}), ...(fixed ? { fixed } : {}) });

export const ALERT_DEFS: readonly AlertDef[] = [
  // ---- transfers, swaps, bridges, deposits
  d('transfer.confirmed', 'transfers', 'info', true, ['Transfert confirmé', 'Transfer confirmed'],
    ['{amount} {symbol} envoyés sur {network}.', '{amount} {symbol} sent on {network}.'], ['Sur {network}.', 'On {network}.']),
  d('transfer.failed', 'transfers', 'warning', true, ['Transfert échoué', 'Transfer failed'],
    ['{amount} {symbol} sur {network} : {reason}', '{amount} {symbol} on {network}: {reason}'], ['Sur {network}. Rien de plus n’a été envoyé.', 'On {network}. Nothing more was sent.']),
  d('swap.confirmed', 'transfers', 'info', true, ['Échange confirmé', 'Swap confirmed'],
    ['{amount} {symbol} échangés contre {toSymbol} sur {network}.', '{amount} {symbol} swapped for {toSymbol} on {network}.'], ['Sur {network}.', 'On {network}.']),
  d('swap.failed', 'transfers', 'warning', true, ['Échange échoué', 'Swap failed'],
    ['{amount} {symbol} sur {network} : {reason}', '{amount} {symbol} on {network}: {reason}'], ['Sur {network}.', 'On {network}.']),
  d('bridge.confirmed', 'transfers', 'info', true, ['Transfert inter-réseaux terminé', 'Bridge transfer completed'],
    ['{amount} {symbol} arrivés sur {to} (depuis {network}).', '{amount} {symbol} arrived on {to} (from {network}).'], ['De {network} vers {to}.', 'From {network} to {to}.']),
  d('bridge.failed', 'transfers', 'warning', true, ['Transfert inter-réseaux à vérifier', 'Bridge transfer needs attention'],
    ['{network} → {to} : {reason}', '{network} → {to}: {reason}'], ['De {network} vers {to}.', 'From {network} to {to}.']),
  d('transfer.stuck', 'transfers', 'warning', true, ['Opération en attente', 'Operation still pending'],
    ['{what} sur {network} : toujours « {state} » après {minutes} min.', '{what} on {network}: still “{state}” after {minutes} min.'],
    ['{what} sur {network} : en attente depuis {minutes} min.', '{what} on {network}: pending for {minutes} min.']),
  d('deposit.received', 'transfers', 'info', true, ['Dépôt reçu', 'Deposit received'],
    ['{amount} {symbol} reçus sur {network}.', '{amount} {symbol} received on {network}.'], ['Sur {network}.', 'On {network}.']),

  // ---- v7 any-to-any plans: a plan never approves anything itself — each step waits for the owner's passkey
  d('plan.step_ready', 'transfers', 'info', true, ['Plan : étape à approuver', 'Plan: step to approve'],
    ['{what} : l’étape {step} sur {steps} est prête sur {network}. Elle attend votre clé d’accès.', '{what}: step {step} of {steps} is ready on {network}. It waits for your passkey.'],
    ['Une étape d’un plan d’échange attend votre approbation sur {network}.', 'A step of a swap plan waits for your approval on {network}.']),
  d('plan.paused', 'transfers', 'warning', true, ['Plan en pause', 'Plan paused'],
    ['{what} : arrêté à l’étape {step} sur {steps}. {reason} Les fonds restent dans votre portefeuille.', '{what}: stopped at step {step} of {steps}. {reason} The funds stay in your wallet.'],
    ['Un plan d’échange est en pause sur {network}. Les fonds restent dans votre portefeuille.', 'A swap plan is paused on {network}. The funds stay in your wallet.']),
  d('plan.done', 'transfers', 'info', true, ['Plan terminé', 'Plan completed'],
    ['{what} : {amount} {symbol} reçus après {steps} étape(s).', '{what}: {amount} {symbol} received after {steps} step(s).'], ['Un plan d’échange est terminé.', 'A swap plan is completed.']),

  // ---- trading agents
  d('agent.order_filled', 'agents', 'info', true, ['Ordre d’agent exécuté', 'Agent order filled'],
    ['{agent} : {count} ordre(s) exécuté(s), dernier {from} → {to}.', '{agent}: {count} order(s) filled, last {from} → {to}.'], ['{agent} : {count} ordre(s) exécuté(s).', '{agent}: {count} order(s) filled.']),
  d('agent.stopped_loss', 'agents', 'critical', true, ['Agent arrêté : limite de perte', 'Agent stopped: loss limit'],
    ['{agent} : {reason}', '{agent}: {reason}'], ['{agent} a atteint sa limite de perte et s’est arrêté.', '{agent} reached its loss limit and stopped.']),
  d('agent.stopped_mandate', 'agents', 'warning', true, ['Agent arrêté : mandat expiré', 'Agent stopped: mandate expired'],
    ['{agent} : le mandat a expiré ; approuvez-en un nouveau pour continuer.', '{agent}: the mandate expired; approve a new one to continue.'],
    ['{agent} : le mandat a expiré.', '{agent}: the mandate expired.']),
  d('agent.stopped', 'agents', 'warning', true, ['Agent arrêté', 'Agent stopped'], ['{agent} : {reason}', '{agent}: {reason}'], ['{agent} s’est arrêté.', '{agent} stopped.']),
  d('agent.mandate_revoked', 'agents', 'info', true, ['Mandat révoqué', 'Mandate revoked'],
    ['{agent} : le mandat a été révoqué ; l’agent ne peut plus signer.', '{agent}: the mandate was revoked; the agent can no longer sign.'],
    ['{agent} : mandat révoqué.', '{agent}: mandate revoked.']),
  d('agent.data_stale', 'agents', 'warning', true, ['Agent sans données fraîches', 'Agent without fresh data'],
    ['{agent} n’a pas décidé depuis {bars} barres ({interval}) : données périmées ou incohérentes. Il n’a rien négocié.', '{agent} has not decided for {bars} bars ({interval}): stale or inconsistent data. It did not trade.'],
    ['{agent} : aucune décision depuis {bars} barres.', '{agent}: no decision for {bars} bars.']),
  d('agent.signal_failures', 'agents', 'warning', true, ['Signal de stratégie en échec', 'Strategy signal failing'],
    ['{agent} : {count} signaux invalides de suite ; l’agent conserve ses positions.', '{agent}: {count} invalid signals in a row; the agent is holding.'],
    ['{agent} : {count} signaux invalides de suite.', '{agent}: {count} invalid signals in a row.']),
  // >>> v7 research runtime
  d('agent.research_submitted', 'agents', 'info', true, ['Recherche terminée : stratégie à approuver', 'Research done: strategy awaiting approval'],
    ['{name} : backtest serveur terminé ({count} essais comptés). À approuver ou à rejeter.', '{name}: server-side backtest done ({count} trials counted). Approve or dismiss it.'],
    ['{name} : une stratégie attend votre approbation.', '{name}: a strategy awaits your approval.']),
  d('agent.research_failed', 'agents', 'warning', true, ['Tâche de recherche interrompue', 'Research job stopped'],
    ['{name} : {state} ({reason})', '{name}: {state} ({reason})'], ['{name} : {state}.', '{name}: {state}.']),
  // <<< v7 research runtime
  d('mandate.expiring', 'agents', 'warning', true, ['Mandat bientôt expiré', 'Mandate about to expire'],
    ['Le mandat de {agent} expire dans moins de {hours} h.', 'The mandate of {agent} expires in less than {hours} h.'],
    ['Le mandat de {agent} expire dans moins de {hours} h.', 'The mandate of {agent} expires in less than {hours} h.']),

  // ---- derivatives (paper = simulated, always said)
  d('deriv.paper.filled', 'derivatives', 'info', true, ['Ordre simulé exécuté', 'Simulated order filled'],
    ['{account} (papier, simulé) : {side} {size} {instrument} à {price}.', '{account} (paper, simulated): {side} {size} {instrument} at {price}.'],
    ['{account} (papier, simulé) : {instrument}.', '{account} (paper, simulated): {instrument}.']),
  d('deriv.live.filled', 'derivatives', 'info', true, ['Ordre réel exécuté', 'Live order filled'],
    ['{account} : {side} {size} {instrument} à {price}.', '{account}: {side} {size} {instrument} at {price}.'], ['{account} : {instrument}.', '{account}: {instrument}.']),
  d('deriv.order_rejected', 'derivatives', 'warning', true, ['Ordre refusé', 'Order rejected'],
    ['{account} ({mode}) : {reason}', '{account} ({mode}): {reason}'], ['{account} ({mode}) : {count} ordre(s) refusé(s).', '{account} ({mode}): {count} order(s) rejected.']),
  d('deriv.order_unknown', 'derivatives', 'critical', true, ['Ordre réel dans un état inconnu', 'Live order in an unknown state'],
    ['{account} : l’ordre {clientId} sur {instrument} est sans réponse de la plateforme depuis plus de {seconds} s. Vérifiez sur la plateforme.', '{account}: order {clientId} on {instrument} has had no answer from the venue for more than {seconds} s. Check on the venue.'],
    ['{account} : un ordre sur {instrument} est sans réponse depuis plus de {seconds} s.', '{account}: an order on {instrument} has had no answer for more than {seconds} s.']),
  d('deriv.position_opened', 'derivatives', 'info', false, ['Position ouverte', 'Position opened'],
    ['{account} ({mode}) : {instrument}, {size}.', '{account} ({mode}): {instrument}, {size}.'], ['{account} ({mode}) : {instrument}.', '{account} ({mode}): {instrument}.']),
  d('deriv.position_closed', 'derivatives', 'info', true, ['Position fermée', 'Position closed'],
    ['{account} ({mode}) : {instrument}, PnL réalisé {pnl}.', '{account} ({mode}): {instrument}, realized PnL {pnl}.'], ['{account} ({mode}) : {instrument}.', '{account} ({mode}): {instrument}.']),
  d('deriv.margin_warning', 'derivatives', 'warning', true, ['Alerte de marge', 'Margin warning'],
    ['{account} ({mode}) : {reason}', '{account} ({mode}): {reason}'], ['{account} ({mode}) : la marge de maintien approche des fonds propres.', '{account} ({mode}): maintenance margin is close to equity.']),
  d('deriv.paper.liquidation', 'derivatives', 'warning', true, ['Liquidation simulée', 'Simulated liquidation'],
    ['{account} (papier) : liquidation SIMULÉE, {positions} position(s) fermée(s). Aucun fonds réel touché.', '{account} (paper): SIMULATED liquidation, {positions} position(s) closed. No real funds involved.'],
    ['{account} (papier) : liquidation SIMULÉE. Aucun fonds réel touché.', '{account} (paper): SIMULATED liquidation. No real funds involved.']),
  d('deriv.live.liquidation', 'derivatives', 'critical', true, ['Liquidation', 'Liquidation'],
    ['{account} : la plateforme a liquidé {instrument} ({size} à {price}).', '{account}: the venue liquidated {instrument} ({size} at {price}).'], ['{account} : liquidation sur {instrument}.', '{account}: liquidation on {instrument}.']),
  d('deriv.funding', 'derivatives', 'info', true, ['Paiement de financement', 'Funding payment'],
    ['{account} ({mode}) : {amount} USD sur {instrument}.', '{account} ({mode}): {amount} USD on {instrument}.'], ['{account} ({mode}) : {instrument}.', '{account} ({mode}): {instrument}.']),
  d('deriv.loss_limit', 'derivatives', 'critical', true, ['Limite de perte atteinte', 'Loss limit reached'],
    ['{account} ({mode}) : limite de perte {scope} atteinte ; négociation arrêtée.', '{account} ({mode}): {scope} loss limit reached; trading halted.'],
    ['{account} ({mode}) : limite de perte {scope} atteinte ; négociation arrêtée.', '{account} ({mode}): {scope} loss limit reached; trading halted.']),
  d('deriv.halt', 'derivatives', 'critical', true, ['Arrêt de négociation', 'Trading halt set'],
    ['{account} : arrêt posé. {reason}', '{account}: halt set. {reason}'], ['{account} : arrêt de négociation posé.', '{account}: trading halt set.']),
  d('deriv.divergence', 'derivatives', 'critical', true, ['Écart avec la plateforme', 'Divergence with the venue'],
    ['{account} : l’état de la plateforme et les registres du portefeuille diffèrent. {reason}', '{account}: the venue’s state and the wallet’s records differ. {reason}'],
    ['{account} : l’état de la plateforme et les registres diffèrent ; nouveaux ordres arrêtés.', '{account}: venue state and records differ; new orders are stopped.']),
  d('deriv.divergence_cleared', 'derivatives', 'info', true, ['Écart résorbé', 'Divergence cleared'],
    ['{account} : la plateforme et les registres concordent de nouveau.', '{account}: the venue and the records agree again.'],
    ['{account} : la plateforme et les registres concordent de nouveau.', '{account}: the venue and the records agree again.']),
  d('deriv.asset_table_mismatch', 'derivatives', 'critical', true, ['Table d’actifs modifiée', 'Asset table mismatch'],
    ['La table d’actifs de la plateforme ne correspond plus à la table épinglée : négociation réelle suspendue, rien n’est signé.', 'The venue’s asset table no longer matches the pinned table: live trading is suspended, nothing is signed.'],
    ['Négociation réelle suspendue, rien n’est signé.', 'Live trading is suspended, nothing is signed.']),

  // ---- security
  d('security.passkey_added', 'security', 'critical', true, ['Nouvelle clé d’accès', 'New passkey enrolled'],
    ['Une clé d’accès « {label} » a été ajoutée. Si ce n’est pas vous : arrêt d’urgence.', 'A passkey “{label}” was added. If this was not you: emergency halt.'],
    ['Une clé d’accès a été ajoutée. Si ce n’est pas vous : arrêt d’urgence.', 'A passkey was added. If this was not you: emergency halt.']),
  d('security.new_device', 'security', 'warning', true, ['Connexion depuis un nouvel appareil', 'Sign-in from a new device'],
    ['{device} ({ip}).', '{device} ({ip}).'], ['Un appareil jamais vu a ouvert une session.', 'A device never seen before signed in.']),
  d('security.login_failed', 'security', 'warning', true, ['Connexions refusées', 'Sign-in attempts refused'],
    ['{count} tentative(s) refusée(s), dernière depuis {ip}.', '{count} attempt(s) refused, last from {ip}.'], ['{count} tentative(s) refusée(s).', '{count} attempt(s) refused.']),
  d('security.signer_unreachable', 'security', 'critical', true, ['Signataire injoignable', 'Signer unreachable'],
    ['Le signataire ne répond plus depuis {minutes} min. Rien ne peut être signé.', 'The signer has not answered for {minutes} min. Nothing can be signed.'],
    ['Le signataire ne répond plus depuis {minutes} min. Rien ne peut être signé.', 'The signer has not answered for {minutes} min. Nothing can be signed.']),
  d('security.signer_back', 'security', 'info', true, ['Signataire de nouveau joignable', 'Signer reachable again'],
    ['Le signataire répond de nouveau.', 'The signer answers again.'], ['Le signataire répond de nouveau.', 'The signer answers again.']),
  d('security.signer_halted', 'security', 'critical', true, ['Signataire à l’arrêt', 'Signer halted'],
    ['L’arrêt d’urgence est actif : plus rien n’est signé.', 'The emergency halt is on: nothing is signed any more.'], ['L’arrêt d’urgence est actif.', 'The emergency halt is on.']),
  d('security.signer_unhalted', 'security', 'warning', true, ['Signataire réactivé', 'Signer resumed'],
    ['L’arrêt d’urgence a été levé sur la machine du signataire.', 'The emergency halt was lifted on the signer machine.'], ['L’arrêt d’urgence a été levé.', 'The emergency halt was lifted.']),
  // V11 risk engine: the global kill switch (services/api/src/risk). `what` = who engaged it, `state` = the reason given
  d('risk.kill_switch_on', 'security', 'critical', true, ['Coupe-circuit global activé', 'Global kill switch engaged'],
    ['Plus aucun nouveau risque n’est pris, sur aucune plateforme ({what}). {state} Les annulations et les réductions restent possibles.', 'No new risk is taken on any venue ({what}). {state} Cancels and reductions still pass.'],
    ['Le coupe-circuit global est activé.', 'The global kill switch is engaged.'], true),
  d('risk.kill_switch_off', 'security', 'warning', true, ['Coupe-circuit global levé', 'Global kill switch released'],
    ['Le coupe-circuit global a été levé avec la clé d’accès.', 'The global kill switch was released with the passkey.'], ['Le coupe-circuit global a été levé.', 'The global kill switch was released.']),
  d('security.signer_refused', 'security', 'warning', true, ['Demandes refusées par le signataire', 'Requests refused by the signer'],
    ['{count} refus, dernier : {reason}', '{count} refusal(s), last: {reason}'], ['{count} demande(s) refusée(s).', '{count} request(s) refused.']),
  d('security.pin_mismatch', 'security', 'critical', true, ['Contrat épinglé modifié', 'Pinned contract changed'],
    ['{what} : le code ne correspond plus à la version révisée. Les opérations concernées sont refusées. {reason}', '{what}: the code no longer matches the reviewed version. The operations concerned are refused. {reason}'],
    ['{what} : le code ne correspond plus à la version révisée ; opérations refusées.', '{what}: the code no longer matches the reviewed version; operations refused.']),
  d('security.audit_broken', 'security', 'critical', true, ['Journal d’audit altéré', 'Audit chain broken'],
    ['La chaîne d’audit est rompue à l’événement n° {seq}.', 'The audit chain is broken at event #{seq}.'], ['La chaîne d’audit est rompue.', 'The audit chain is broken.']),
  d('security.policy_changed', 'security', 'warning', true, ['Politique modifiée', 'Policy changed'],
    ['{what} : la politique de limites a changé ({detail}).', '{what}: the limits policy changed ({detail}).'], ['{what} : la politique de limites a changé.', '{what}: the limits policy changed.']),

  // ---- system
  d('system.api_restarted', 'system', 'info', true, ['Service redémarré', 'Service restarted'],
    ['L’API du portefeuille a redémarré.', 'The wallet API restarted.'], ['L’API du portefeuille a redémarré.', 'The wallet API restarted.']),
  d('system.worker_failing', 'system', 'warning', true, ['Tâche de fond en échec', 'Background task failing'],
    ['« {loop} » échoue depuis {count} passes : {reason}', '“{loop}” has failed {count} passes in a row: {reason}'], ['« {loop} » échoue depuis {count} passes.', '“{loop}” has failed {count} passes in a row.']),
  d('system.backup_missing', 'system', 'warning', true, ['Sauvegarde absente', 'Backup missing'],
    ['Aucune sauvegarde de la base depuis {hours} h.', 'No database backup for {hours} h.'], ['Aucune sauvegarde de la base depuis {hours} h.', 'No database backup for {hours} h.']),
  d('system.disk_low', 'system', 'warning', true, ['Espace disque faible', 'Disk space low'],
    ['Il reste {pct} % d’espace libre sur la machine de l’API.', '{pct} % of disk space is left on the API host.'], ['Il reste {pct} % d’espace libre sur la machine de l’API.', '{pct} % of disk space is left on the API host.']),
  // --- v8 hardening: the OS sandbox of strategy code (services/api/src/agents/lab.ts) ---
  d('system.lab_sandbox_unavailable', 'system', 'critical', true, ['Bac à sable des stratégies indisponible', 'Strategy sandbox unavailable'],
    ['Le bac à sable du code de stratégie ne fonctionne pas ({reason}). Aucun signal ni backtest n’est exécuté : les agents restent en attente.', 'The sandbox for strategy code does not work ({reason}). No signal and no backtest is run: agents hold.'],
    ['Le bac à sable du code de stratégie ne fonctionne pas. Aucun signal ni backtest n’est exécuté : les agents restent en attente.', 'The sandbox for strategy code does not work. No signal and no backtest is run: agents hold.']),
  d('system.lab_sandbox_back', 'system', 'info', true, ['Bac à sable des stratégies rétabli', 'Strategy sandbox back'],
    ['Le bac à sable du code de stratégie fonctionne de nouveau.', 'The sandbox for strategy code works again.'], ['Le bac à sable du code de stratégie fonctionne de nouveau.', 'The sandbox for strategy code works again.']),
  d('system.lab_sandbox_off', 'system', 'critical', true, ['Bac à sable des stratégies DÉSACTIVÉ', 'Strategy sandbox turned OFF'],
    ['SPW_LAB_SANDBOX=off : le code de stratégie s’exécute SANS confinement du système. Réglage de développement, à retirer sur une machine qui détient des fonds.', 'SPW_LAB_SANDBOX=off: strategy code runs WITHOUT OS confinement. A development setting: remove it on a machine that holds funds.'],
    ['SPW_LAB_SANDBOX=off : le code de stratégie s’exécute SANS confinement du système.', 'SPW_LAB_SANDBOX=off: strategy code runs WITHOUT OS confinement.']),
  // --- end v8 hardening ---
  d('conn.down', 'system', 'warning', true, ['Source indisponible', 'Source unavailable'],
    ['{name} ne répond plus depuis {minutes} min.', '{name} has not answered for {minutes} min.'], ['{name} ne répond plus depuis {minutes} min.', '{name} has not answered for {minutes} min.']),
  d('conn.up', 'system', 'info', true, ['Source rétablie', 'Source back'],
    ['{name} répond de nouveau.', '{name} answers again.'], ['{name} répond de nouveau.', '{name} answers again.']),
  d('system.alerts_capped', 'system', 'info', true, ['Autres alertes', 'More alerts'],
    ['{count} autre(s) alerte(s) dans l’application (plafond horaire de notifications atteint).', '{count} more alert(s) in the app (hourly notification cap reached).'],
    ['{count} autre(s) alerte(s) dans l’application.', '{count} more alert(s) in the app.'], true),
  d('system.test', 'system', 'info', true, ['Notification de test', 'Test notification'],
    ['Les notifications fonctionnent sur cet appareil.', 'Notifications work on this device.'], ['Les notifications fonctionnent sur cet appareil.', 'Notifications work on this device.'], true),
];

export const ALERT_KINDS: readonly string[] = ALERT_DEFS.map((x) => x.kind);
const BY_KIND = new Map(ALERT_DEFS.map((x) => [x.kind, x]));
export const alertDef = (kind: string): AlertDef | undefined => BY_KIND.get(kind);

/** parameters that may appear on a lock screen and in a webhook without "details" */
export const SAFE_PARAMS: readonly string[] = ['agent', 'account', 'network', 'to', 'what', 'mode', 'scope', 'count', 'minutes', 'hours', 'seconds', 'bars', 'interval', 'instrument', 'name', 'loop', 'pct', 'positions', 'state'];

/** parameter values of the form `@word` are vocabulary, translated where the alert is shown */
const VOCAB: Record<string, Pair> = {
  paper: ['papier, simulé', 'paper, simulated'], live: ['réel', 'live'], transfer: ['Transfert', 'Transfer'], swap: ['Échange', 'Swap'], bridge: ['Transfert inter-réseaux', 'Bridge transfer'],
  buy: ['achat', 'buy'], sell: ['vente', 'sell'], daily: ['quotidienne', 'daily'], total: ['totale', 'total'],
  router: ['Routeur d’échange', 'Swap router'], jupiter: ['Programme Jupiter', 'Jupiter program'], cctp: ['Contrats CCTP (Circle)', 'CCTP contracts (Circle)'],
  signer: ['Signataire', 'Signer'], derivatives: ['Compte de dérivés', 'Derivatives account'],
  signed: ['signé', 'signed'], broadcast: ['diffusé', 'broadcast'], confirming: ['en confirmation', 'confirming'], attesting: ['en attente d’attestation', 'awaiting attestation'], minting: ['en cours de réception', 'minting'],
  market: ['Données de marché', 'Market data'], rpc: ['RPC', 'RPC'], unknown: ['inconnu', 'unknown'],
  failed: ['échec', 'failed'], over_budget: ['budget dépassé', 'over budget'], // v7 research runtime
};
const word = (v: unknown, l: AlertLocale): string => {
  if (v === null || v === undefined || v === '') return '—';
  const s = String(v);
  if (!s.startsWith('@')) return s;
  const w = VOCAB[s.slice(1)];
  return w ? w[l === 'fr' ? 0 : 1] : s.slice(1);
};
const fill = (tpl: string, p: AlertParams, l: AlertLocale): string => tpl.replace(/\{([a-zA-Z]+)\}/g, (_m, k: string) => word(p[k], l)).replace(/\s+/g, ' ').trim();

/** only the parameters that may leave the server without "show details" */
export function safeParams(p: AlertParams): AlertParams {
  const out: AlertParams = {};
  for (const k of SAFE_PARAMS) if (p[k] !== undefined) out[k] = p[k]!;
  return out;
}

/** Title and body of an alert in one language. `detail: false` gives the lock-screen wording (no amount, price, address or reason). */
export function renderAlert(kind: string, params: AlertParams, locale: AlertLocale, detail = true): { title: string; body: string } {
  const def = BY_KIND.get(kind), i = locale === 'fr' ? 0 : 1;
  if (!def) return { title: kind, body: '' };
  const tpl = detail ? def.body : def.priv ?? (['', ''] as const);
  return { title: def.title[i], body: fill(tpl[i], detail ? params : safeParams(params), locale) };
}

/** placeholders used by a template (tests check that `priv` only uses safe parameters) */
export const alertPlaceholders = (tpl: string): string[] => [...tpl.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]!);

/** in-app path opened when the alert (or its notification) is tapped */
export function alertPath(kind: string, subject: AlertSubject | null | undefined): string {
  const g = BY_KIND.get(kind)?.group;
  if (subject?.type === 'agent' && subject.id) return `/agents/${subject.id}`;
  if (subject?.type === 'plan' && subject.id) return `/plan/${subject.id}`; // v7 plans: the plan's progress view
  if (subject?.type === 'account') return '/futures?v=accounts';
  if (subject?.type === 'proposal' || subject?.type === 'deposit') return '/activity';
  if (g === 'security') return '/security';
  if (g === 'system') return '/monitor';
  if (g === 'agents') return '/agents';
  if (g === 'derivatives') return '/futures?v=accounts';
  if (g === 'transfers') return '/activity';
  return '/alerts';
}
