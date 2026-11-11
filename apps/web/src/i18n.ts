import { createContext, useContext } from 'react';
export type Locale = 'fr' | 'en';
const D = {
  // nav
  home: ['Accueil', 'Home'], receive: ['Recevoir', 'Receive'], send: ['Envoyer', 'Send'], activity: ['Activité', 'Activity'],
  security: ['Sécurité', 'Security'], settings: ['Réglages', 'Settings'],
  // gate
  tagline: ['Portefeuille privé multi-chaînes', 'Private multi-chain wallet'],
  unlock: ['Déverrouiller avec la clé d’accès', 'Unlock with passkey'],
  unlockHint: ['Face ID, Touch ID ou clé de sécurité. Aucun mot de passe.', 'Face ID, Touch ID or security key. No password.'],
  setupTitle: ['Configuration initiale', 'First-time setup'],
  setupBody: ['Cette étape n’est possible qu’une seule fois. Elle lie votre clé d’accès au signataire : elle seule pourra ouvrir le portefeuille et approuver un transfert.',
    'This step is possible only once. It binds your passkey to the signer: only it can open the wallet and approve a transfer.'],
  setupToken: ['Jeton de configuration', 'Setup token'], createPasskey: ['Créer ma clé d’accès', 'Create my passkey'],
  noWebauthn: ['Ce navigateur ne prend pas en charge les clés d’accès.', 'This browser does not support passkeys.'],
  privateAccess: ['Accès privé — propriétaire uniquement', 'Private access — owner only'],
  // home
  totalEstimate: ['Valeur totale estimée', 'Estimated total value'], estimate: ['estimation', 'estimate'],
  assets: ['Actifs', 'Assets'], showZero: ['Afficher les soldes nuls', 'Show zero balances'], hideZero: ['Masquer les soldes nuls', 'Hide zero balances'],
  pending: ['Transferts en cours', 'Transfers in progress'], networks: ['Réseaux', 'Networks'], operational: ['opérationnel', 'operational'],
  degraded: ['dégradé', 'degraded'], block: ['bloc', 'block'], unavailable: ['indisponible', 'unavailable'], on: ['sur', 'on'],
  haltedBanner: ['Arrêt d’urgence actif : aucune signature possible. La consultation reste disponible.', 'Emergency halt active: signing is disabled. Balances remain visible.'],
  hide: ['Masquer les soldes', 'Hide balances'], show: ['Afficher les soldes', 'Show balances'], noPrices: ['Prix désactivés', 'Prices disabled'],
  emptyWallet: ['Portefeuille vide. Utilisez « Recevoir » pour obtenir votre adresse de dépôt.', 'Empty wallet. Use “Receive” to get your deposit address.'],
  // receive
  receiveTitle: ['Recevoir', 'Receive'], network: ['Réseau', 'Network'], asset: ['Actif', 'Asset'], yourAddress: ['Votre adresse', 'Your address'],
  copy: ['Copier', 'Copy'], copied: ['Copié', 'Copied'],
  onlySend: ['Envoyez uniquement {assets} sur le réseau {network}. Un dépôt sur un autre réseau ou d’un autre jeton peut être perdu définitivement.',
    'Only send {assets} on the {network} network. Deposits on another network or of another token may be lost permanently.'],
  evmSame: ['Cette adresse est la même sur tous vos réseaux compatibles Ethereum (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, HyperEVM), mais les fonds ne passent pas d’un réseau à l’autre : vérifiez le réseau choisi par l’expéditeur.',
    'This address is the same on all your Ethereum-compatible networks (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, HyperEVM), but funds do not move between networks: check the network the sender uses.'],
  depositShown: ['Un dépôt apparaît ici une fois confirmé sur la chaîne ({n} confirmations pour la finalité).', 'A deposit shows here once confirmed on-chain ({n} confirmations for finality).'],
  gasNote: ['Pour envoyer des USDC plus tard, il faut aussi un peu de {sym} sur ce réseau pour payer les frais.', 'To send USDC later you also need a little {sym} on this network to pay fees.'],
  addressFromSigner: ['Adresse dérivée par le signataire', 'Address derived by the signer'], explorer: ['Explorateur', 'Explorer'],
  // send
  sendTitle: ['Envoyer', 'Send'], destination: ['Adresse de destination', 'Destination address'], amount: ['Montant', 'Amount'], max: ['Max', 'Max'],
  note: ['Note (privée, facultative)', 'Note (private, optional)'], available: ['Disponible', 'Available'], review: ['Vérifier', 'Review'],
  reviewTitle: ['Vérification', 'Review'], youSend: ['Vous envoyez', 'You send'], to: ['À', 'To'], from: ['De', 'From'], fee: ['Frais réseau estimés', 'Estimated network fee'],
  feeMax: ['Plafond de frais approuvé', 'Approved fee ceiling'], baseUnits: ['unités de base', 'base units'],
  simulated: ['Simulation réussie sur le réseau', 'Simulation succeeded on the network'],
  w_new_destination: ['Nouvelle destination : vous n’avez jamais envoyé à cette adresse. Vérifiez chaque caractère.', 'New destination: you have never sent to this address. Check every character.'],
  w_address_poisoning_suspected: ['ATTENTION : cette adresse ressemble à une adresse connue (mêmes début et fin) mais est différente. Possible empoisonnement d’adresse.',
    'WARNING: this address looks like a known one (same start and end) but differs. Possible address poisoning.'],
  w_contract_destination: ['La destination est un contrat, pas un portefeuille simple.', 'The destination is a contract, not a plain wallet.'],
  w_creates_token_account: ['Le destinataire n’a pas encore de compte USDC : sa création coûte environ 0,00204 SOL en plus.', 'The recipient has no USDC account yet: creating it costs about 0.00204 SOL extra.'],
  w_creates_account: ['Le compte du destinataire n’existe pas encore : ce transfert le crée (au moins 1 XLM, dont 1 XLM reste immobilisé chez lui).', 'The recipient account does not exist yet: this transfer creates it (at least 1 XLM, of which 1 XLM stays locked on their side).'],
  w_memo_numeric_id: ['Le mémo ne contient que des chiffres : il est envoyé comme identifiant numérique (MEMO_ID), le format attendu par les plateformes d’échange.', 'The memo is digits only: it is sent as a numeric id (MEMO_ID), the format exchanges expect.'],
  w_network_congested: ['Réseau très chargé : les frais sont plafonnés, le transfert peut expirer sans être inclus (aucun fonds ne bouge dans ce cas).', 'The network is congested: the fee is capped, so the transfer may expire without being included (no funds move in that case).'],
  iChecked: ['J’ai vérifié l’adresse, le réseau et le montant.', 'I have checked the address, network and amount.'],
  irreversible: ['Un transfert sur chaîne est irréversible.', 'An on-chain transfer is irreversible.'],
  approve: ['Approuver avec la clé d’accès', 'Approve with passkey'], cancel: ['Annuler', 'Cancel'], back: ['Retour', 'Back'],
  approving: ['En attente de la clé d’accès…', 'Waiting for passkey…'], preparing: ['Préparation et simulation…', 'Preparing and simulating…'],
  boundNote: ['Votre clé d’accès signe l’empreinte exacte de ce transfert. Tout changement d’adresse, de montant, de réseau ou de frais l’invalide.',
    'Your passkey signs the exact fingerprint of this transfer. Any change of address, amount, network or fee invalidates it.'],
  fingerprint: ['Empreinte', 'Fingerprint'], expiresIn: ['Expire dans', 'Expires in'], newTransfer: ['Nouveau transfert', 'New transfer'],
  tracking: ['Suivi du transfert', 'Transfer tracking'], addressBook: ['Carnet d’adresses', 'Address book'], saveAddress: ['Enregistrer cette adresse', 'Save this address'],
  label: ['Libellé', 'Label'], save: ['Enregistrer', 'Save'], paste: ['Coller', 'Paste'], noGas: ['Solde nul', 'Zero balance'],
  // states
  s_draft: ['Brouillon', 'Draft'], s_pending_approval: ['En attente d’approbation', 'Awaiting approval'], s_approved: ['Approuvé', 'Approved'],
  s_signed: ['Signé', 'Signed'], s_broadcast: ['Diffusé', 'Broadcast'], s_confirming: ['Confirmation en cours', 'Confirming'], s_finalized: ['Finalisé', 'Finalized'],
  s_failed: ['Échoué', 'Failed'], s_rejected: ['Rejeté', 'Rejected'], s_expired: ['Expiré', 'Expired'], s_replaced: ['Remplacé', 'Replaced'], s_reorged: ['Réorganisé', 'Reorged'],
  broadcastNote: ['Diffusé ne veut pas dire réussi : attendez « Finalisé ».', 'Broadcast does not mean success: wait for “Finalized”.'],
  confirmations: ['confirmations', 'confirmations'],
  // activity
  all: ['Tout', 'All'], sent: ['Envoyés', 'Sent'], received: ['Reçus', 'Received'], noActivity: ['Aucune activité pour l’instant.', 'No activity yet.'],
  viewExplorer: ['Voir dans l’explorateur', 'View in explorer'], txid: ['Identifiant de transaction', 'Transaction id'], status: ['État', 'Status'],
  time: ['Date (locale)', 'Time (local)'], error: ['Erreur', 'Error'], allNetworks: ['Tous les réseaux', 'All networks'],
  // security
  signer: ['Signataire isolé', 'Isolated signer'], reachable: ['joignable', 'reachable'], unreachable: ['injoignable', 'unreachable'], keyId: ['Identifiant de clé', 'Key id'],
  signingOn: ['Signature active', 'Signing enabled'], signingOff: ['Signature arrêtée', 'Signing halted'],
  halt: ['Arrêt d’urgence', 'Emergency halt'], haltConfirm: ['Bloque toute signature immédiatement. La réactivation exige la commande « unhalt » sur la machine du signataire. Tapez STOP pour confirmer.',
    'Blocks all signing immediately. Re-enabling requires the “unhalt” command on the signer machine. Type STOP to confirm.'],
  limits: ['Limites du signataire', 'Signer limits'], perTx: ['Par transfert', 'Per transfer'], perDay: ['Par jour (UTC)', 'Per day (UTC)'], usedToday: ['Utilisé aujourd’hui', 'Used today'],
  limitsNote: ['Les limites sont appliquées par le signataire lui-même et ne se modifient que sur sa machine (policy.json).', 'Limits are enforced by the signer itself and can only be changed on its machine (policy.json).'],
  devices: ['Clés d’accès autorisées', 'Authorized passkeys'], addDevice: ['Ajouter une clé d’accès de secours', 'Add a backup passkey'],
  addDeviceNote: ['Deux étapes : créer la nouvelle clé, puis l’autoriser avec une clé existante.', 'Two steps: create the new passkey, then authorize it with an existing one.'],
  synced: ['synchronisée', 'synced'], deviceBound: ['liée à l’appareil', 'device-bound'], lastUsed: ['dernière utilisation', 'last used'], never: ['jamais', 'never'],
  sessions: ['Sessions actives', 'Active sessions'], revokeAll: ['Fermer toutes les sessions', 'Sign out everywhere'],
  audit: ['Journal d’audit', 'Audit log'], auditIntact: ['Chaîne d’empreintes intacte', 'Hash chain intact'], auditBroken: ['CHAÎNE ROMPUE à l’entrée', 'CHAIN BROKEN at entry'],
  recovery: ['Phrase de récupération', 'Recovery phrase'],
  recoveryBody: ['La phrase de 24 mots n’est jamais affichée ici. Pour la noter sur papier, exécutez vous-même, dans un terminal privé sur la machine du signataire : ',
    'The 24-word phrase is never shown here. To write it on paper, run it yourself in a private terminal on the signer machine: '],
  recoveryWarn: ['Tant qu’elle n’est pas notée hors ligne, une panne du disque du signataire = perte définitive des fonds.', 'Until it is written down offline, a signer disk failure = permanent loss of funds.'],
  entries: ['entrées', 'entries'], signerJournal: ['Journal du signataire', 'Signer journal'],
  // settings
  language: ['Langue', 'Language'], currency: ['Devise d’affichage', 'Display currency'], theme: ['Thème', 'Theme'], dark: ['Sombre', 'Dark'], light: ['Clair', 'Light'],
  prices: ['Prix de marché (CoinGecko)', 'Market prices (CoinGecko)'], pricesNote: ['Seuls les symboles des actifs sont envoyés ; jamais vos adresses ni vos soldes.', 'Only asset symbols are sent; never your addresses or balances.'],
  exportCsv: ['Exporter l’activité (CSV)', 'Export activity (CSV)'], logout: ['Verrouiller', 'Lock'], rpcStatus: ['État des sources RPC', 'RPC source status'],
  version: ['Version', 'Version'], identityOk: ['identité de chaîne vérifiée', 'chain identity verified'], identityKo: ['identité non vérifiée', 'identity not verified'],
  retry: ['Réessayer', 'Retry'], loading: ['Chargement…', 'Loading…'], offline: ['Hors ligne ou serveur injoignable', 'Offline or server unreachable'],
  e_bad_address: ['Adresse invalide pour ce réseau.', 'Invalid address for this network.'],
  e_bad_amount: ['Montant invalide.', 'Invalid amount.'],
  e_insufficient_funds: ['Solde insuffisant.', 'Insufficient balance.'],
  e_insufficient_gas: ['Pas assez de jeton natif sur ce réseau pour payer les frais.', 'Not enough native token on this network to pay the fee.'],
  e_policy: ['Refusé par les limites du signataire.', 'Refused by the signer limits.'],
  e_signer_policy: ['Refusé par les limites du signataire.', 'Refused by the signer limits.'],
  e_rpc_degraded: ['Source de données réseau indisponible : transfert refusé par prudence.', 'Network data source unavailable: transfer refused as a precaution.'],
  e_rpc_disagreement: ['Les sources de données réseau ne concordent pas : transfert refusé par prudence.', 'Network data sources disagree: transfer refused as a precaution.'],
  e_signer_unreachable: ['Signataire injoignable : rien n’a été signé.', 'Signer unreachable: nothing was signed.'],
  e_expired: ['Fenêtre d’approbation expirée. Recommencez.', 'Approval window expired. Start again.'],
  e_halted: ['Arrêt d’urgence actif.', 'Emergency halt is active.'],
  e_pending_tx: ['Une transaction précédente est encore en attente sur ce réseau.', 'A previous transaction is still pending on this network.'],
  e_simulation_failed: ['La simulation a échoué : transfert refusé.', 'Simulation failed: transfer refused.'],
  e_signer_bad_approval: ['Approbation refusée par le signataire.', 'Approval refused by the signer.'],
  e_contract_destination: ['Destination non prise en charge (contrat).', 'Unsupported destination (contract).'],
  e_bad_destination: ['Destination non prise en charge.', 'Unsupported destination.'],
  e_below_rent: ['Montant trop faible pour créer le compte destinataire.', 'Amount too small to create the recipient account.'],
  e_rate_limited: ['Trop de requêtes. Patientez un instant.', 'Too many requests. Wait a moment.'],
  e_offline: ['Hors ligne ou serveur injoignable.', 'Offline or server unreachable.'],
  e_login_failed: ['Clé d’accès non reconnue.', 'Passkey not recognized.'],
  e_signer_forbidden: ['Jeton de configuration invalide.', 'Invalid setup token.'],
  checking: ['Vérification des réseaux…', 'Checking networks…'],
  netsUp: ['{up}/{n} réseaux opérationnels', '{up}/{n} networks operational'],
  sendPaused: ['consultation seule pour l’instant', 'read-only for now'],
  partialNote: ['Une source de données ne répond pas. Les soldes restent visibles ; les envois sur ce réseau reprennent dès son retour.', 'One data source is not answering. Balances stay visible; sends on this network resume when it is back.'],
  more: ['Plus', 'More'], securityLink: ['Sécurité, limites et clés d’accès', 'Security, limits and passkeys'], seeAudit: ['Afficher le journal', 'Show log'], hideAudit: ['Masquer le journal', 'Hide log'],
  remaining: ['restant aujourd’hui', 'left today'], perTxShort: ['max. par transfert', 'max per transfer'],
  price: ['Prix', 'Price'], range: ['Période', 'Range'], r_1: ['sur 24 h', 'past 24 h'], r_7: ['sur 7 jours', 'past 7 days'], r_30: ['sur 30 jours', 'past 30 days'], r_365: ['sur 1 an', 'past year'],
  yourBalance: ['Votre solde', 'Your balance'], otherNetworks: ['{sym} sur vos autres réseaux', '{sym} on your other networks'], marketData: ['Marché', 'Market'],
  change24h: ['Variation 24 h', '24 h change'], change7d: ['Variation 7 j', '7 d change'], marketCap: ['Capitalisation', 'Market cap'], volume24h: ['Volume 24 h', '24 h volume'],
  range24h: ['Bas – haut 24 h', '24 h low – high'], rank: ['Rang', 'Rank'], marketSource: ['Données de marché : CoinGecko, en USD. Indicatif.', 'Market data: CoinGecko, in USD. Indicative.'],
  assetDetails: ['Détails', 'Details'], decimals: ['Décimales', 'Decimals'], contract: ['Contrat du jeton', 'Token contract'], nativeCoin: ['Monnaie native du réseau', 'Native coin of the network'],
  verifiedToken: ['Adresse épinglée dans le portefeuille et revérifiée sur la chaîne (symbole et décimales) à chaque démarrage.', 'Address pinned in the wallet and re-verified on-chain (symbol and decimals) at every start.'],
  allAssets: ['Tous les actifs', 'All assets'], yourAssets: ['Vos actifs', 'Your assets'], search: ['Rechercher un actif ou un réseau', 'Search an asset or network'], today: ['aujourd’hui', 'today'],
  noMatch: ['Aucun actif ne correspond.', 'No matching asset.'], popular: ['Populaires', 'Popular'], tokensCount: ['{n} actifs pris en charge', '{n} supported assets'],
  showAll: ['Tout afficher', 'Show all'], showLess: ['Réduire', 'Show less'],
  memoText: ['Mémo (si le destinataire l’exige)', 'Memo (if the recipient requires one)'], memoTag: ['Étiquette de destination (si le destinataire l’exige)', 'Destination tag (if the recipient requires one)'],
  memoWarn: ['Les plateformes d’échange exigent souvent un mémo ou une étiquette : sans lui, le dépôt peut être perdu.', 'Exchanges often require a memo or tag: without it the deposit can be lost.'],
  memo: ['Mémo / étiquette', 'Memo / tag'],
  activationNote: ['Sur {network}, un compte doit détenir au moins {amount} {sym} pour exister : le premier dépôt doit dépasser ce montant, qui reste ensuite immobilisé.', 'On {network}, an account must hold at least {amount} {sym} to exist: the first deposit must exceed it, and that amount then stays locked.'],
  e_bad_memo: ['Mémo ou étiquette invalide.', 'Invalid memo or tag.'], e_unsupported_network: ['Réseau pas encore activé sur le signataire.', 'Network not yet enabled on the signer.'], e_unsupported_asset: ['Actif non pris en charge.', 'Unsupported asset.'],
  mainnet: ['Réseaux principaux — fonds réels', 'Mainnet — real funds'],
} as const;
export type Key = keyof typeof D;
export const I18n = createContext<{ locale: Locale; setLocale: (l: Locale) => void }>({ locale: 'fr', setLocale: () => {} });
export function useT() {
  const { locale } = useContext(I18n);
  return (k: Key, vars?: Record<string, string | number>) => {
    let s: string = D[k][locale === 'fr' ? 0 : 1];
    if (vars) for (const [a, b] of Object.entries(vars)) s = s.replace(`{${a}}`, String(b));
    return s;
  };
}
/** Localized message for an API error code, followed by the server detail. */
export function errText(t: (k: Key) => string, e: unknown): string {
  const x = e as { code?: string; message?: string; name?: string };
  if (x?.name === 'NotAllowedError') return '';
  const k = `e_${x?.code}`;
  const detail = x?.message && x.message !== 'error' && x.message !== x.code ? x.message : '';
  return k in D ? (detail ? `${t(k as Key)} (${detail})` : t(k as Key)) : detail || String(x?.code ?? 'error');
}
export const stateKey = (s: string) => (`s_${s}` in D ? (`s_${s}` as Key) : 's_draft');
