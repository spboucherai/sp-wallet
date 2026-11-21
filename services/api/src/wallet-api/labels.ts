/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : services/api/src/wallet-api/labels.ts
 * Module           : wallet-api
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-19
 * Last Modified    : 2026-11-19
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

// NEXT — two small things shared by the activity feed, the CSV exports, analytics and search:
// the address-book label of a counterparty, and the escaping of a CSV cell.
import { sql } from '../db.ts';

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** EVM addresses are stored checksummed in the address book and arrive lower-cased from logs: they are compared without case.
 *  Every other address format is case-sensitive (base58, bech32 payloads…) and is compared exactly. */
const key = (network: string, address: string): string => `${network}\n${HEX_ADDRESS.test(address) ? address.toLowerCase() : address}`;
export type Labeler = (network: string, address: string | null | undefined) => string | null;

/** The address book, read once: `(network, address) → label | null`. A label is for the owner's eyes; it never replaces the address. */
export async function contactLabeler(): Promise<Labeler> {
  const rows = await sql<{ network: string; address: string; label: string }[]>`select network, address, label from address_book`;
  const book = new Map(rows.map((r) => [key(r.network, r.address), r.label]));
  return (network, address) => (address ? book.get(key(network, address)) ?? null : null);
}

/** No control character (PostgreSQL refuses a NUL in a text value, and none belongs in a network id, an asset id or a search). */
export const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

/** One CSV cell: quoted, quotes doubled, and a leading = + - @ (or tab / carriage return) neutralised with an apostrophe so
 *  that a spreadsheet never evaluates a cell — a contact label and a note are text the owner (or a sender) chose. */
export const csvCell = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@\t\r])/, "'$1")}"`;
