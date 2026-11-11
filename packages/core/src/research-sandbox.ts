// V7 research runtime — the macOS sandbox profile (SBPL, for /usr/bin/sandbox-exec) under which the coding agent of a research
// job runs, and under which the API runs the laboratory on a SUBMITTED (untrusted) strategy. Pure: builds a string.
//
// Shape: `(deny default)`, then only what a Python / Node toolchain needs.
//   files    read: the system's own libraries and binaries, the toolchain directories the caller lists, the job directory;
//            write: the job directory only. The user's home, every other project, /opt/homebrew/etc and var, /Volumes, /tmp
//            at large and every device except null/random are not readable — they are simply not in the list.
//   network  outbound TCP to the listed ports of the loopback interface only (the runner's model gateway). No other host, no
//            other local port (the wallet API, the signer, PostgreSQL), no Unix socket (PostgreSQL's /tmp/.s.PGSQL.*, ssh-agent,
//            Docker), no DNS (mDNSResponder is a Mach service: not allowed), no inbound.
//   IPC      no Mach service lookup at all: no keychain (securityd), no AppleEvents, no pasteboard, no launchd job control.
//   process  fork/exec of readable binaries; children inherit the sandbox and can never leave it. Signals only inside the sandbox.
// SBPL can only filter network destinations as `localhost:<port>` or `*:<port>`: a per-host allow-list does not exist at this
// layer, which is why the only door is a loopback port owned by the runner, and the runner decides what is behind it.

export interface SandboxSpec {
  /** canonical absolute paths the process may read AND write (the job directory) */
  writable: string[];
  /** canonical absolute paths it may only read (the laboratory's virtualenv, the interpreter, the agent CLI) */
  readable: string[];
  /** loopback TCP ports it may connect to; empty = no network at all */
  localPorts: number[];
}

/** read-only system locations every dynamically linked program needs; nothing here belongs to the user */
export const SYSTEM_READ = [
  '/usr/lib', '/usr/bin', '/usr/sbin', '/usr/share', '/usr/libexec', '/bin', '/sbin',
  '/System/Library', '/System/Cryptexes', '/System/Volumes/Preboot/Cryptexes', '/Library/Apple', '/Library/Preferences/Logging',
  '/private/var/db/timezone', '/private/var/db/dyld', '/private/var/select', '/private/etc/localtime', '/private/etc/ssl', '/private/etc/shells',
] as const;
/** Homebrew's programs and libraries (never its etc/ or var/, where services keep configuration and data) */
export const HOMEBREW_READ = ['/opt/homebrew/bin', '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/lib', '/opt/homebrew/share',
  '/usr/local/bin', '/usr/local/lib', '/usr/local/Cellar', '/usr/local/opt'] as const;
const DEVICES_RW = ['/dev/null', '/dev/zero', '/dev/dtracehelper'] as const;
const DEVICES_R = ['/dev/urandom', '/dev/random'] as const;

const q = (p: string): string => {
  if (!p.startsWith('/') || /["\\\n\r\0]/.test(p) || p.includes('/../') || p.endsWith('/..')) throw new Error(`sandbox: not a plain absolute path: ${JSON.stringify(p)}`);
  return `"${p.length > 1 ? p.replace(/\/+$/, '') : p}"`;
};
const ancestors = (p: string): string[] => { const out: string[] = []; let cur = p.replace(/\/+$/, ''); for (;;) { const i = cur.lastIndexOf('/'); if (i <= 0) break; cur = cur.slice(0, i); out.push(cur); } return out; };

/** The profile text. Paths must already be canonical (realpath: /tmp is /private/tmp on macOS) — the kernel matches real paths. */
export function sandboxProfile(spec: SandboxSpec): string {
  for (const port of spec.localPorts) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('sandbox: bad port');
  if (!spec.writable.length) throw new Error('sandbox: a job directory is required');
  const read = [...SYSTEM_READ, ...HOMEBREW_READ, ...spec.readable], all = [...read, ...spec.writable];
  // stat() of the directories on the way to an allowed path (realpath, getcwd): metadata only, never their content or listing
  const walk = [...new Set(['/', ...all.flatMap(ancestors)])];
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec*)',
    '(allow signal (target same-sandbox))',
    // v8: `(deny default)` does NOT cover process-info on macOS 27 (proc_pidpath / proc_listallpids of other processes
    // answered), and a blanket sysctl-read lets the job read `kern.procargs2.<pid>` — the argv AND ENVIRONMENT of any
    // process of the same user (the runner's own secrets). Both are closed here; a process still sees itself.
    ...PROCESS_PRIVACY,
    `(allow file-read-metadata ${walk.map((p) => `(literal ${q(p)})`).join(' ')})`,
    `(allow file-read* (literal "/") ${read.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    // OpenSSL's configuration and the CA bundle of Homebrew builds of node / python (read at start-up)
    '(allow file-read* (regex #"^/opt/homebrew/etc/(openssl@[0-9.]+|ca-certificates)(/|$)") (regex #"^/usr/local/etc/(openssl@[0-9.]+|ca-certificates)(/|$)"))',
    `(allow file-read* ${[...DEVICES_R, ...DEVICES_RW].map((p) => `(literal ${q(p)})`).join(' ')} (subpath "/dev/fd"))`,
    `(allow file-write* ${DEVICES_RW.map((p) => `(literal ${q(p)})`).join(' ')})`,
    `(allow file-ioctl ${DEVICES_RW.map((p) => `(literal ${q(p)})`).join(' ')})`,
    `(allow file-read* file-write* ${spec.writable.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    ...(spec.localPorts.length ? [`(allow network-outbound ${spec.localPorts.map((p) => `(remote ip "localhost:${p}")`).join(' ')})`] : []),
  ];
  return lines.join('\n') + '\n';
}

// ---- v8 hardening ------------------------------------------------------------------------------------------------------
/** Other processes are invisible: no proc_info on them, no `kern.proc*` sysctl (kern.procargs2 = their environment). */
const PROCESS_PRIVACY = [
  '(deny process-info*)',
  '(allow process-info* (target same-sandbox))',
  '(allow sysctl-read)',
  '(deny sysctl-read (sysctl-name-prefix "kern.proc"))',
] as const;

/** v8 — the profile of a process that RUNS STRATEGY CODE inside the wallet API (signals, backtests, describe, the research
 *  evaluation). Stricter than the research job's profile, because such a process is one Python interpreter and nothing else:
 *    - no network rule at all (no loopback port either), no Unix socket, no Mach lookup;
 *    - NO `process-fork`: fork(), posix_spawn() and subprocess all fail, so nothing can outlive the call (the `setsid`
 *      escape of a forking job does not exist here) and no other program (curl, sh, ps) can be started;
 *    - `process-exec` only for the interpreter itself (sandbox-exec must exec it once);
 *    - read: the OS libraries, the interpreter's own install prefix, the laboratory's code + virtualenv, the ONE strategy
 *      directory of the call, the caller's read-only data; no Homebrew, no /usr/bin, no /etc, no home directory;
 *    - write: one scratch directory. */
export interface LabSandboxSpec {
  /** canonical path of the scratch directory (the only writable place, and the cwd) */
  scratch: string;
  /** canonical read-only paths: laboratory code, virtualenv, interpreter prefix, the strategy directory, data */
  readable: string[];
  /** canonical paths sandbox-exec may exec: the interpreter (its real path, and the symlink it is started through) */
  exec: string[];
  /** the interpreter is a Homebrew build: its dylibs live under the Homebrew prefix */
  homebrew?: boolean;
}
/** what a dynamically linked interpreter may need from the OS. Measured on macOS 27 arm64 with a standalone CPython 3.12 +
 *  numpy/pandas/scipy/statsmodels/arch/scikit-learn: NONE of these is opened (everything comes from the dyld shared cache);
 *  they are kept because dyld falls back to them when a library is not in the cache. Nothing here belongs to the user. */
export const LAB_SYSTEM_READ = ['/usr/lib', '/System/Library', '/private/var/db/dyld', '/private/var/db/timezone', '/private/etc/localtime'] as const;

export function labSandboxProfile(spec: LabSandboxSpec): string {
  if (!spec.scratch) throw new Error('sandbox: a scratch directory is required');
  if (!spec.exec.length) throw new Error('sandbox: the interpreter path is required');
  const read = [...LAB_SYSTEM_READ, ...(spec.homebrew ? HOMEBREW_READ : []), ...spec.readable];
  const walk = [...new Set(['/', ...[...read, spec.scratch, ...spec.exec].flatMap(ancestors)])];
  return [
    '(version 1)',
    '(deny default)',
    `(allow process-exec* ${spec.exec.map((p) => `(literal ${q(p)})`).join(' ')})`,
    '(allow signal (target self))',
    '(deny process-info*)',
    '(allow process-info* (target self))',
    '(allow sysctl-read)',
    '(deny sysctl-read (sysctl-name-prefix "kern.proc"))',
    `(allow file-read-metadata ${walk.map((p) => `(literal ${q(p)})`).join(' ')})`,
    `(allow file-read* (literal "/") ${read.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    `(allow file-read* ${[...DEVICES_R, '/dev/null'].map((p) => `(literal ${q(p)})`).join(' ')})`,
    '(allow file-write* (literal "/dev/null"))',
    `(allow file-read* file-write* (subpath ${q(spec.scratch)}))`,
  ].join('\n') + '\n';
}
// ---- end v8 ------------------------------------------------------------------------------------------------------------

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** argv prefix that runs a command under the profile */
export const sandboxArgv = (profilePath: string, argv: string[]): string[] => [SANDBOX_EXEC, '-f', profilePath, ...argv];
