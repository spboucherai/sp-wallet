/**
 * =============================================================================
 *                  SP BOUCHER | SOFTWARE & RESEARCH
 *             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
 * =============================================================================
 *
 * Project          : SP Wallet
 * File             : apps/web/src/derivatives/LiveAgentNote.tsx
 * Module           : derivatives
 * Repository       : https://git.spboucher.ai/sp-wallet
 * Project Website  : https://wallet.spboucher.ai
 * Created          : 2026-11-11
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

/**
 * v7 perp live — a venue account that an agent trades under a derivative mandate says so wherever the owner could place a
 * manual order on it (Futures → Accounts, the terminal's order panel), with what a manual order then does to the agent.
 */
import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { useT } from '../i18n';
import { Icon, Notice } from '../ui';
import type { LiveSummary } from './live';

export function AgentOnAccount({ account }: { account: Pick<LiveSummary, 'mandate'> }) {
  const t = useT();
  const m = account.mandate, on = !!m && m.phase !== 'ended';
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => get<{ agents: { id: string; name: string }[] }>('/agents'), enabled: on, staleTime: 30_000, retry: 0 });
  if (!m || !on) return null;
  const name = agents.data?.agents.find((a) => a.id === m.agentId)?.name ?? m.agentId;
  return <Notice tone="warn"><div data-testid="agent-on-account" data-phase={m.phase}>
    <b className="flex items-start gap-1.5 font-semibold"><Icon n="robot" className="mt-0.5 h-4 w-4 shrink-0" />{t('plUsedBy', { name })}</b>
    <span className="mt-0.5 block text-[0.8125rem]">{t(m.phase === 'active' ? 'plMandateOn' : 'plMandateWinding')}</span>
    {m.phase === 'active' && <span className="mt-1 block text-[0.8125rem] leading-snug">{t('plManualWarn')}</span>}
    <a href={`/agents/${encodeURIComponent(m.agentId)}`} className="mt-1 inline-flex min-h-11 items-center gap-1 text-[0.84375rem] font-semibold underline underline-offset-2">{t('plUsedByOpen')}<Icon n="chev" className="h-3.5 w-3.5" /></a>
  </div></Notice>;
}
