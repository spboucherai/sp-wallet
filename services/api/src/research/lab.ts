// V7 research runtime — how the API runs the laboratory on anything that comes from a research job.
//
// A submitted strategy is code written by an AI agent. Before the owner has approved it, the API executes it only through
// this module. Since v8 it is a thin layer over agents/lab.ts — the same OS sandbox as EVERY process that runs strategy code
// (signals, backtests): no network of any kind, no fork, read access limited to the laboratory and the listed data, write
// access to one scratch directory, no database URL. FAIL CLOSED: without a working sandbox nothing runs (`code: null`, the
// evaluation is refused) unless the explicit development switch SPW_LAB_SANDBOX=off is set, and the result then says
// `sandbox: 'none'` (the UI shows a warning).
import { dropScratch, labExec, labStatus, lastLine, scratchDir } from '../agents/lab.ts';

export interface LabResult { code: number | null; out: string; err: string; sandbox: 'sandbox-exec' | 'none' }
export const labSandboxAvailable = async (): Promise<boolean> => (await labStatus()).ok;

/** Run `python -m <args>` of the laboratory. `scratch` is the only writable directory (and the cwd); `readable` are extra
 *  read-only paths (the job's data, a staging directory); `strategyDir` the one strategy directory it may read. Never throws. */
export function labRun(args: string[], o: { timeoutMs: number; scratch: string; readable?: string[]; strategyDir?: string }): Promise<LabResult> {
  return labExec(args, o).then((r) => ({ code: r.killed ? null : r.code, out: r.out, err: r.killed ? `${r.err}\nkilled: ${r.killed}` : r.err, sandbox: r.sandbox }),
    (e: Error) => ({ code: null, out: '', err: `could not start: ${e.message}`, sandbox: process.env.SPW_LAB_SANDBOX === 'off' ? 'none' as const : 'sandbox-exec' as const }));
}

export { dropScratch, lastLine, scratchDir };
