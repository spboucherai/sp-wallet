// NEXT — what the owner arranges, kept on the server so that the three clients agree: hidden and favourite assets, and an
// address book that can be edited. Nothing here touches a signature: the signer never reads these tables. A contact is a
// label for the owner's eyes; the destination the owner approves is always the full address shown on the review.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAsset, getNetwork, normalizeAddress } from '@spw/core';
import { UserError } from './config.ts';
import { audit, sql } from './db.ts';

export const PREFS_SCHEMA = `
create table if not exists asset_prefs (
  network text not null, asset text not null, hidden boolean not null default false, favorite boolean not null default false,
  updated_at timestamptz not null default now(), primary key (network, asset));
alter table address_book add column if not exists note text not null default '';
alter table address_book add column if not exists favorite boolean not null default false;
alter table address_book add column if not exists updated_at timestamptz;
`;

const contact = (r: Record<string, unknown>) => ({ id: r.id, network: r.network, address: r.address, label: r.label, note: r.note, favorite: r.favorite, created_at: r.created_at, updatedAt: r.updated_at ?? null });

export function prefsRoutes(app: FastifyInstance): void {
  // ── assets: hidden / favourite ─────────────────────────────────────────────────────────────────────────────────────
  // Hiding is display only: a hidden asset keeps being read, counted in the total (a client says "including hidden assets")
  // and announced when it is received. It can always be sent from its own page.
  app.get('/api/v1/assets/prefs', async () => ({ prefs: await sql`select network, asset, hidden, favorite, updated_at as "updatedAt" from asset_prefs where hidden or favorite order by network, asset` }));
  app.put('/api/v1/assets/prefs/:network/:asset', async (req) => {
    const { network, asset } = req.params as { network: string; asset: string };
    const b = z.strictObject({ hidden: z.boolean().optional(), favorite: z.boolean().optional() }).refine((v) => v.hidden !== undefined || v.favorite !== undefined, 'nothing to change').parse(req.body);
    try { getAsset(getNetwork(network).id, asset); } catch { throw new UserError('unsupported_asset', 'asset is not supported on this network', 404); }
    const [r] = await sql`insert into asset_prefs (network, asset, hidden, favorite) values (${network}, ${asset}, ${b.hidden ?? false}, ${b.favorite ?? false})
      on conflict (network, asset) do update set hidden = coalesce(${b.hidden ?? null}, asset_prefs.hidden), favorite = coalesce(${b.favorite ?? null}, asset_prefs.favorite), updated_at = now()
      returning network, asset, hidden, favorite, updated_at as "updatedAt"`;
    await audit('settings.asset_pref', 'owner', { network, asset, hidden: r!.hidden, favorite: r!.favorite });
    return r;
  });

  // ── address book: read with the new fields, edit ───────────────────────────────────────────────────────────────────
  app.get('/api/v1/contacts', async () => ({ contacts: (await sql`select * from address_book order by favorite desc, lower(label)`).map(contact) }));
  app.patch('/api/v1/addressbook/:id', async (req) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const b = z.strictObject({ label: z.string().min(1).max(40).optional(), note: z.string().max(200).optional(), favorite: z.boolean().optional(),
      /** changing where a contact points: the client must send the address it believes is current (a stale screen cannot overwrite) */
      address: z.string().max(110).optional(), currentAddress: z.string().max(110).optional() }).parse(req.body);
    const [cur] = await sql<{ id: string; network: string; address: string; label: string }[]>`select id, network, address, label from address_book where id = ${id}`;
    if (!cur) throw new UserError('not_found', 'contact not found', 404);
    let address = cur.address;
    if (b.address !== undefined) {
      try { address = normalizeAddress(getNetwork(cur.network).id, b.address); } catch (e) { throw new UserError('bad_address', (e as Error).message); }
      if (address !== cur.address) {
        if (b.currentAddress === undefined || b.currentAddress !== cur.address) throw new UserError('stale_contact', 'the contact changed since it was read; reload before changing its address', 409);
        const [clash] = await sql`select id from address_book where network = ${cur.network} and address = ${address} and id <> ${id}`;
        if (clash) throw new UserError('duplicate_contact', 'another contact already has this address', 409);
      }
    }
    const [r] = await sql`update address_book set label = ${b.label ?? cur.label}, note = coalesce(${b.note ?? null}, note), favorite = coalesce(${b.favorite ?? null}, favorite), address = ${address}, updated_at = now()
      where id = ${id} returning *`;
    // a contact that now points elsewhere is a security event (the label a payment will be made under changed target)
    if (address !== cur.address) await audit('security.contact_address_changed', 'owner', { id, network: cur.network, label: r!.label, from: cur.address, to: address });
    else await audit('addressbook.saved', 'owner', { network: cur.network, address, label: r!.label });
    return contact(r!);
  });
}
