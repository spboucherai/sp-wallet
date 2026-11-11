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
    <span className="mt-0.5 block text-[13px]">{t(m.phase === 'active' ? 'plMandateOn' : 'plMandateWinding')}</span>
    {m.phase === 'active' && <span className="mt-1 block text-[13px] leading-snug">{t('plManualWarn')}</span>}
    <a href={`/agents/${encodeURIComponent(m.agentId)}`} className="mt-1 inline-flex min-h-11 items-center gap-1 text-[13.5px] font-semibold underline underline-offset-2">{t('plUsedByOpen')}<Icon n="chev" className="h-3.5 w-3.5" /></a>
  </div></Notice>;
}
