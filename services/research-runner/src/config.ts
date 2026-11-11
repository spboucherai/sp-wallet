// Configuration of the research runner. It runs on a research node, NOT next to the wallet API: it needs no wallet secret,
// no database URL and no signer address — only the API's public URL, its own shared secret, a laboratory checkout with its
// Python environment, and (for the real coding agent) a model credential that stays in THIS process.
import { homedir } from 'node:os';
import path from 'node:path';

export interface AgentConfig {
  /** 'claude': Claude Code CLI, headless. 'command': any argv — the deterministic fake agent of the tests. */
  kind: 'claude' | 'command';
  /** claude: path of the CLI */
  bin: string;
  model: string | null;
  /** command: the argv; `{work}`, `{ro}` and `{prompt}` are replaced */
  argv: string[];
}
export interface RunnerConfig {
  apiUrl: string;
  /** shared secret of the runner endpoints (never the owner session, never the signer secret) */
  secret: string;
  runnerId: string;
  /** job directories are created here; must be outside every application checkout */
  jobsRoot: string;
  /** the runner's own state (ledger copies, sandbox profiles): never readable or writable by a job */
  stateRoot: string;
  /** a checkout of the laboratory (the `research/` directory) */
  labDir: string;
  /** 'commit': the job directory gets `git archive <commit>` of the laboratory; 'worktree': a copy of the directory as it is (development) */
  labPin: 'commit' | 'worktree';
  /** interpreter of the laboratory's prepared virtualenv */
  python: string;
  /** more read-only toolchain paths for the sandbox */
  readable: string[];
  agent: AgentConfig;
  /** 'required': refuse to run a job when the OS sandbox is not available. 'off' exists for platforms without one and says so in every result. */
  sandbox: 'required' | 'off';
  model: { upstream: string; credential: [name: string, value: string] | null };
  pollMs: number; tickMs: number; logFlushMs: number;
  keepJobs: boolean;
}

const need = (env: NodeJS.ProcessEnv, k: string): string => { const v = env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const home = path.resolve(env.SPW_RUNNER_HOME ?? path.join(homedir(), 'sp-wallet-research'));
  const labDir = path.resolve(need(env, 'SPW_RUNNER_LAB_DIR'));
  const secret = need(env, 'SPW_RUNNER_SECRET');
  if (secret.length < 32) throw new Error('SPW_RUNNER_SECRET must be at least 32 characters');
  const kind = (env.SPW_RUNNER_AGENT ?? 'claude') === 'command' ? 'command' : 'claude';
  // the model credential: read here once, handed to the gateway, and removed from the environment children could inherit
  const credential: [string, string] | null = env.ANTHROPIC_API_KEY ? ['x-api-key', env.ANTHROPIC_API_KEY]
    : env.CLAUDE_CODE_OAUTH_TOKEN ? ['authorization', `Bearer ${env.CLAUDE_CODE_OAUTH_TOKEN}`] : null;
  if (kind === 'claude' && !credential) throw new Error('the Claude Code agent needs ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) in the RUNNER\'s environment; the job never sees it');
  delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return {
    apiUrl: need(env, 'SPW_RUNNER_API_URL').replace(/\/+$/, ''), secret, runnerId: (env.SPW_RUNNER_ID ?? 'runner').slice(0, 40),
    jobsRoot: path.join(home, 'jobs'), stateRoot: path.join(home, 'state'), labDir,
    labPin: env.SPW_RUNNER_LAB_PIN === 'worktree' ? 'worktree' : 'commit',
    python: path.resolve(env.SPW_RUNNER_PYTHON ?? path.join(labDir, '.venv/bin/python')),
    readable: (env.SPW_RUNNER_READABLE ?? '').split(':').filter(Boolean),
    agent: { kind, bin: env.SPW_RUNNER_CLAUDE_BIN ?? '/opt/homebrew/bin/claude', model: env.SPW_RUNNER_MODEL ?? null, argv: kind === 'command' ? (JSON.parse(need(env, 'SPW_RUNNER_AGENT_CMD')) as string[]) : [] },
    sandbox: env.SPW_RUNNER_SANDBOX === 'off' ? 'off' : 'required',
    model: { upstream: env.SPW_RUNNER_MODEL_UPSTREAM ?? 'https://api.anthropic.com', credential },
    pollMs: Number(env.SPW_RUNNER_POLL_MS ?? 5000), tickMs: 500, logFlushMs: 2000, keepJobs: env.SPW_RUNNER_KEEP_JOBS === '1',
  };
}
