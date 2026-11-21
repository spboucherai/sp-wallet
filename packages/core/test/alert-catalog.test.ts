/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : packages/core/test/alert-catalog.test.ts
 * Module           : core
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

// Every alert kind renders in French and in English, with and without details; the lock-screen wording never needs a sensitive
// parameter; every kind the rules can produce is in the catalogue and every catalogue kind is produced somewhere.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALERT_DEFS, ALERT_KINDS, alertDef, alertPath, alertPlaceholders, renderAlert, SAFE_PARAMS, safeParams } from '../src/alert-catalog.ts';

const RULES = new URL('../../../services/api/src/alerts/', import.meta.url);
const source = readdirSync(RULES).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(new URL(f, RULES), 'utf8')).join('\n');
/** a value for every placeholder; the sensitive ones are recognisable */
const sample = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, SAFE_PARAMS.includes(k) ? (['count', 'minutes', 'hours', 'seconds', 'bars', 'positions', 'pct'].includes(k) ? 3 : `safe-${k}`) : `SECRET-${k}`]));

describe('alert catalogue', () => {
  it('has unique kinds, a severity, a group and both languages for every entry', () => {
    expect(new Set(ALERT_KINDS).size).toBe(ALERT_KINDS.length);
    expect(ALERT_KINDS.length).toBeGreaterThanOrEqual(48);
    for (const d of ALERT_DEFS) {
      expect(['info', 'warning', 'critical'], d.kind).toContain(d.severity);
      expect(['transfers', 'agents', 'derivatives', 'security', 'system'], d.kind).toContain(d.group);
      for (const pair of [d.title, d.body, ...(d.priv ? [d.priv] : [])]) { expect(pair, d.kind).toHaveLength(2); for (const s of pair) expect(s.trim().length, d.kind).toBeGreaterThan(3); }
      expect(d.title[0], d.kind).not.toBe(d.title[1] === 'Liquidation' ? '' : d.title[1]);                       // translated, not copied
      expect(alertPlaceholders(d.body[0]).sort(), `${d.kind}: same parameters in both languages`).toEqual(alertPlaceholders(d.body[1]).sort());
      if (d.priv) expect(alertPlaceholders(d.priv[0]).sort(), d.kind).toEqual(alertPlaceholders(d.priv[1]).sort());
      if (d.severity === 'critical') expect(d.on, `${d.kind}: criticals are on by default`).toBe(true);
    }
  });

  it('renders every kind in FR and EN with no missing key and no leftover placeholder', () => {
    for (const d of ALERT_DEFS) for (const locale of ['fr', 'en'] as const) {
      const keys = [...new Set([...alertPlaceholders(d.body[0]), ...alertPlaceholders(d.priv?.[0] ?? '')])], p = sample(keys);
      const full = renderAlert(d.kind, p, locale, true), priv = renderAlert(d.kind, p, locale, false);
      for (const t of [full.title, full.body, priv.title, priv.body]) expect(t, `${d.kind} ${locale}`).not.toMatch(/[{}]|undefined|null|—/);
      expect(full.title.length, d.kind).toBeGreaterThan(3);
      expect(full.body.length, d.kind).toBeGreaterThan(3);
      for (const k of alertPlaceholders(d.body[locale === 'fr' ? 0 : 1])) expect(full.body, `${d.kind} ${locale} uses {${k}}`).toContain(String(p[k]));
    }
    expect(renderAlert('transfer.confirmed', { amount: '25', symbol: 'USDC', network: 'Base' }, 'fr')).toEqual({ title: 'Transfert confirmé', body: '25 USDC envoyés sur Base.' });
    expect(renderAlert('transfer.confirmed', { amount: '25', symbol: 'USDC', network: 'Base' }, 'en')).toEqual({ title: 'Transfer confirmed', body: '25 USDC sent on Base.' });
    expect(renderAlert('deriv.loss_limit', { account: 'HL', mode: '@paper', scope: '@daily' }, 'fr').body).toBe('HL (papier, simulé) : limite de perte quotidienne atteinte ; négociation arrêtée.');
    expect(renderAlert('deriv.loss_limit', { account: 'HL', mode: '@live', scope: '@total' }, 'en').body).toBe('HL (live): total loss limit reached; trading halted.');
    expect(renderAlert('deriv.paper.liquidation', { account: 'P', positions: 2 }, 'en').body).toContain('SIMULATED');
    expect(renderAlert('deriv.paper.liquidation', { account: 'P', positions: 2 }, 'fr').body).toContain('SIMULÉE');
    expect(renderAlert('transfer.failed', { network: 'Base' }, 'en').body).toBe('— — on Base: —');   // a missing parameter is a dash, never a crash
    expect(renderAlert('no.such.kind', {}, 'en')).toEqual({ title: 'no.such.kind', body: '' });
  });

  it('the lock-screen wording uses safe parameters only: no amount, price, address or reason can appear', () => {
    for (const d of ALERT_DEFS) {
      for (const tpl of d.priv ?? []) for (const k of alertPlaceholders(tpl)) expect(SAFE_PARAMS, `${d.kind}: {${k}} in the private wording`).toContain(k);
      const keys = alertPlaceholders(d.body[0]), p = sample(keys);
      for (const locale of ['fr', 'en'] as const) expect(renderAlert(d.kind, p, locale, false).body, d.kind).not.toContain('SECRET-');
    }
    for (const s of ['amount', 'symbol', 'price', 'size', 'pnl', 'reason', 'ip', 'txid', 'address', 'label', 'device', 'clientId', 'detail']) expect(SAFE_PARAMS).not.toContain(s);
    expect(safeParams({ amount: '25', symbol: 'USDC', network: 'Base', reason: 'x', count: 2 })).toEqual({ network: 'Base', count: 2 });
  });

  it('the rules only produce catalogued kinds, and every catalogued kind is produced', () => {
    const produced = new Set([...source.matchAll(/'((?:transfer|swap|bridge|deposit|agent|mandate|deriv|security|system|conn|plan)\.[a-z_.]+)'/g)].map((m) => m[1]!));
    const eventTypes = /^(transfer\.(finalized|failed)|bridge\.(done|mint_reverted)|deposit\.seen|agent\.(order_refused|fill)|mandate\.revoked|deriv\.(paper|live)\.(fill|reset|halt|order_filled|order_rejected|policy_replaced|order_)|deriv\.rejected|agent\.fill|signer\.(down|up|halt|policy)|conn\.(down|up)|device\.added)$/;
    for (const k of ALERT_KINDS) expect(produced, `${k} is never produced`).toContain(k);
    for (const k of produced) if (!alertDef(k)) expect(k, `${k} is produced by a rule but is not in the catalogue`).toMatch(eventTypes);
    // vocabulary words used by the rules are translated
    for (const m of source.matchAll(/'@([a-z]+)'/g)) expect(renderAlert('security.pin_mismatch', { what: `@${m[1]}` }, 'fr', false).body, m[1]).not.toContain(`${m[1]} :`);
  });

  it('a tap leads to the right screen', () => {
    expect(alertPath('agent.stopped', { type: 'agent', id: 'abc' })).toBe('/agents/abc');
    expect(alertPath('deriv.halt', { type: 'account', id: 'x' })).toBe('/futures?v=accounts');
    expect(alertPath('transfer.confirmed', { type: 'proposal', id: 'p' })).toBe('/activity');
    expect(alertPath('deposit.received', { type: 'deposit', id: 't' })).toBe('/activity');
    expect(alertPath('security.signer_halted', null)).toBe('/security');
    expect(alertPath('conn.down', { type: 'network', network: 'base' })).toBe('/monitor');
    expect(alertPath('system.test', undefined)).toBe('/monitor');
  });
});
