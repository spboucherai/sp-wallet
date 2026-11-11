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

export const JURISDICTION_ACK: Record<'hyperliquid', Record<AckLocale, string>> = {
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
};

export interface JurisdictionAck { venue: 'hyperliquid'; locale: AckLocale; text: string; sha256: string; version: string; source: string }

export function jurisdictionAck(venue: 'hyperliquid', locale: AckLocale): JurisdictionAck {
  const text = JURISDICTION_ACK[venue][locale];
  return { venue, locale, text, sha256: hex(sha256(new TextEncoder().encode(text))), version: JURISDICTION_ACK_VERSION, source: JURISDICTION_ACK_SOURCE };
}
/** which displayed text a hash stands for; null when it is none of them */
export function jurisdictionAckOf(venue: 'hyperliquid', sha: string): JurisdictionAck | null {
  for (const locale of ['fr', 'en'] as const) { const a = jurisdictionAck(venue, locale); if (a.sha256 === sha) return a; }
  return null;
}
