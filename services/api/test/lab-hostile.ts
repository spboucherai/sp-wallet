// Fixtures of the strategy-sandbox tests (lab-sandbox.test.ts): a laboratory copy whose purity lint is DISABLED — so that what
// stops a hostile strategy is the OS layer and nothing else — and the hostile strategy itself.
//
// The hostile strategy attempts every forbidden action twice: at module import (where the laboratory's runtime guard is not
// active at all) and inside target_weights (where it is — so the probes use the low-level entry points the guard does not
// patch: `posix.open`, `_socket.socket`, `posix.fork`, `ctypes`). Each attempt that SUCCEEDS sets a bit; three positive
// controls (it can write its scratch directory, read its own strategy file, import numpy) set bits 28-30 through the same
// primitives, so "no bit set" can never mean "the probe itself was broken".
// The result leaves the sandbox through the only channels a strategy has: its weights (signals) or its error text (backtests).
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './test-db.ts';

export const REAL_LAB = path.join(REPO_ROOT, 'research');
export const REAL_PYTHON = path.join(REAL_LAB, '.venv/bin/python');

/** bit → what a set bit means (a LEAK for 0-27, a working control for 28-30) */
export const PROBES = [
  'read ~/.ssh', 'read ~/.config', 'list the home directory', 'read the application checkout (services/)', 'read a .env-like secret file outside', 'read a canary secret outside',
  'write outside the scratch directory', 'write into the laboratory code', 'write into its own strategy directory', 'TCP to the API port (loopback)', 'TCP to the signer relay port (loopback)',
  'TCP to PostgreSQL (127.0.0.1:5432)', 'TCP to an internet address', 'DNS', 'Unix socket (PostgreSQL / a local service)', 'UDP', 'spawn curl', 'fork', 'posix_spawn /bin/sh',
  'read another process\'s environment (sysctl kern.procargs2)', 'list processes', 'signal another process', 'read the PM2 logs directory', 'read another strategy\'s directory',
  'list /private/tmp', 'listen on a socket', 'read the repository root listing', 'setsid + fork (daemon)',
  'CONTROL write + read the scratch directory', 'CONTROL read its own strategy.py', 'CONTROL import numpy',
] as const;
export const CONTROL_MASK = (1 << 28) | (1 << 29) | (1 << 30);
export const leaks = (mask: number): string[] => PROBES.filter((_, i) => i < 28 && (mask & (1 << i)) !== 0);
export const controlsOk = (mask: number): boolean => (mask & CONTROL_MASK) >>> 0 === CONTROL_MASK >>> 0;

export interface Targets {
  home: string; repo: string; canary: string; envFile: string; outside: string; labSrc: string; otherStrategy: string;
  apiPort: number; signerPort: number; unixSocket: string; envPid: number; envCanary: string;
  /** only local canaries and listeners owned by the test (used for the UNCONFINED control run: nothing of the owner is touched) */
  safeOnly: boolean;
}

const probeSource = (t: Targets): string => `
import json as _json
_T = _json.loads(${JSON.stringify(JSON.stringify(t))})


def _probe():
    import posix, _socket, ctypes
    bits = 0

    def leak(i, f):
        nonlocal bits
        try:
            if f() is not False:
                bits |= 1 << i
        except BaseException:
            pass

    def read(p):
        fd = posix.open(p, posix.O_RDONLY)
        try:
            return posix.read(fd, 64)
        finally:
            posix.close(fd)

    def write(p):
        fd = posix.open(p, posix.O_WRONLY | posix.O_CREAT, 0o600)
        try:
            posix.write(fd, b"x")
        finally:
            posix.close(fd)

    def tcp(host, port, family=_socket.AF_INET):
        s = _socket.socket(family, _socket.SOCK_STREAM)
        try:
            s.settimeout(2.0)
            s.connect((host, port))
        finally:
            s.close()

    def unix(p):
        s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        try:
            s.settimeout(2.0)
            s.connect(p)
        finally:
            s.close()

    def spawn(argv):
        pid = posix.posix_spawn(argv[0], argv, {})
        posix.waitpid(pid, 0)

    def fork(daemon=False):
        pid = posix.fork()
        if pid == 0:
            try:
                if daemon:
                    posix.setsid()
                    write(_T["outside"] + ".daemon")
            finally:
                posix._exit(0)
        posix.waitpid(pid, 0)

    def procenv(pid):
        libc = ctypes.CDLL(None, use_errno=True)
        mib = (ctypes.c_int * 3)(1, 49, pid)
        size = ctypes.c_size_t(0)
        if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0:
            raise OSError("sysctl")
        buf = ctypes.create_string_buffer(size.value)
        if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
            raise OSError("sysctl")
        return _T["envCanary"].encode() in buf.raw[: size.value]

    def listpids():
        libc = ctypes.CDLL(None, use_errno=True)
        return libc.proc_listallpids(None, 0) > 0

    def listen():
        s = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", 0))
            s.listen(1)
        finally:
            s.close()

    def udp():
        s = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        try:
            s.sendto(b"x", ("127.0.0.1", _T["apiPort"]) if _T["safeOnly"] else ("1.1.1.1", 53))
        finally:
            s.close()

    safe = _T["safeOnly"]
    if not safe:
        leak(0, lambda: posix.listdir(_T["home"] + "/.ssh"))
        leak(1, lambda: posix.listdir(_T["home"] + "/.config"))
        leak(2, lambda: posix.listdir(_T["home"]))
        leak(3, lambda: posix.listdir(_T["repo"] + "/services"))
        leak(12, lambda: tcp("1.1.1.1", 443))
        leak(13, lambda: _socket.getaddrinfo("example.com", 443))
        leak(14, lambda: unix("/tmp/.s.PGSQL.5432"))
        leak(11, lambda: tcp("127.0.0.1", 5432))
        leak(16, lambda: spawn(["/usr/bin/curl", "-s", "-m", "3", "http://127.0.0.1:%d/" % _T["apiPort"]]))
        leak(22, lambda: posix.listdir(_T["home"] + "/.pm2/logs"))
        leak(24, lambda: posix.listdir("/private/tmp"))
        leak(26, lambda: posix.listdir(_T["repo"]))
        leak(7, lambda: write(_T["labSrc"] + "/spq/zz_written_by_strategy.py"))
        leak(8, lambda: write(__file__ + ".written"))
    leak(4, lambda: read(_T["envFile"]))
    leak(5, lambda: read(_T["canary"]))
    leak(6, lambda: write(_T["outside"]))
    leak(9, lambda: tcp("127.0.0.1", _T["apiPort"]))
    leak(10, lambda: tcp("127.0.0.1", _T["signerPort"]))
    leak(14, lambda: unix(_T["unixSocket"]))
    leak(15, udp)
    leak(17, fork)
    leak(18, lambda: spawn(["/bin/sh", "-c", "true"]))
    leak(19, lambda: procenv(_T["envPid"]))
    leak(20, listpids)
    leak(21, lambda: posix.kill(_T["envPid"], 0))
    leak(23, lambda: read(_T["otherStrategy"] + "/strategy.py"))
    leak(25, listen)
    leak(27, lambda: fork(True))

    def control_scratch():
        write("zz_scratch_ok.txt")
        return read("zz_scratch_ok.txt") == b"x"

    leak(28, control_scratch)
    leak(29, lambda: len(read(__file__)) > 0)
    leak(30, lambda: __import__("numpy").float64(1.0) == 1.0)
    return bits


_IMPORT_BITS = _probe()
`;

export type HostileBehaviour = 'weights' | 'raise' | 'burn' | 'memory' | 'flood' | 'sleep';
/** A strategy.py. `weights`: the two masks leave as the weights of the first two symbols (mask / 2^32 each). `raise`: they
 *  leave in the error text. The others exhaust a resource instead of returning. */
export function hostileStrategy(o: { name: string; version: string; kind: 'spot' | 'perp'; universe: string[]; behaviour: HostileBehaviour; targets: Targets; lookback?: number }): string {
  const meta = { name: o.name, version: o.version, ...(o.kind === 'perp' ? { kind: 'perp' } : {}), universe: o.universe, interval: '1h', lookback: o.lookback ?? 50,
    ...(o.kind === 'perp' ? { max_leverage: 2.0, max_gross_exposure: 1.0 } : {}), params: {} };
  const body: Record<HostileBehaviour, string> = {
    weights: '    names = list(data)\n    out = {s: 0.0 for s in names}\n    out[names[0]] = _IMPORT_BITS / 4294967296.0\n    out[names[1]] = _probe() / 4294967296.0\n    return out\n',
    raise: '    raise ValueError("PROBE:%x:%x" % (_IMPORT_BITS, _probe()))\n',
    burn: '    while True:\n        pass\n',
    memory: '    blocks = []\n    while True:\n        blocks.append(bytearray(32 * 1024 * 1024))\n',
    flood: '    import sys as _sys\n    while True:\n        _sys.__stdout__.write("x" * 65536)\n        _sys.__stdout__.flush()\n',
    sleep: '    import select as _select\n    _select.select([], [], [], 600)\n    return {s: 0.0 for s in data}\n',
  };
  return `"""Hostile test strategy (sandbox tests). Not a trading rule."""\n${probeSource(o.targets)}\nMETA = ${JSON.stringify(meta, null, 4).replace(/\btrue\b/g, 'True')}\n\n\ndef target_weights(data, params):\n${body[o.behaviour]}`;
}
export const decodeWeights = (w: Record<string, number>, universe: string[]): { importMask: number; callMask: number } =>
  ({ importMask: Math.round(w[universe[0]!]! * 4294967296), callMask: Math.round(w[universe[1]!]! * 4294967296) });
export const decodeError = (text: string): { importMask: number; callMask: number } | null => { const m = /PROBE:([0-9a-f]+):([0-9a-f]+)/.exec(text); return m ? { importMask: parseInt(m[1]!, 16), callMask: parseInt(m[2]!, 16) } : null; };

/** A laboratory directory for tests: the real code (copied) and virtualenv (by reference), its own strategies/ and results/.
 *  `lint: 'off'` appends one line to spq/strategy.py that makes the static purity check accept everything. */
export function fixtureLab(o: { lint: 'off' | 'real' }): { dir: string; python: string; addStrategy(rel: string, source: string): { dir: string; sha256: string; path: string } } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'spw-lab-fixture-')));
  cpSync(path.join(REAL_LAB, 'src'), path.join(dir, 'src'), { recursive: true, filter: (p) => !p.endsWith('__pycache__') && !p.endsWith('.pyc') });
  cpSync(path.join(REAL_LAB, 'schema'), path.join(dir, 'schema'), { recursive: true });
  writeFileSync(path.join(dir, 'pyproject.toml'), readFileSync(path.join(REAL_LAB, 'pyproject.toml')));
  mkdirSync(path.join(dir, 'strategies')); mkdirSync(path.join(dir, 'results'));
  symlinkSync(path.join(REAL_LAB, '.venv'), path.join(dir, '.venv'));
  if (o.lint === 'off') { const f = path.join(dir, 'src/spq/strategy.py');
    writeFileSync(f, `${readFileSync(f, 'utf8')}\n\n# TEST FIXTURE (services/api/test/lab-hostile.ts): the static purity check is disabled so that only the OS sandbox is tested\ndef static_check(source):  # noqa: F811\n    return []\n`); }
  return { dir, python: REAL_PYTHON, addStrategy(rel, source) {
    const d = path.join(dir, 'strategies', rel); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'strategy.py'), source);
    return { dir: d, sha256: sha256(source), path: `strategies/${rel}` }; } };
}
export const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

/** deterministic hourly bars ending at the last closed hour */
export function bars(n: number, seed: number, p0 = 100): { ts: number; open: number; high: number; low: number; close: number; volume: number }[] {
  const H = 3_600_000, end = Math.floor(Date.now() / H) * H - 2 * H; let s = seed >>> 0, close = p0;
  const rnd = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  return Array.from({ length: n }, (_, i) => { const open = close; close = open * Math.exp(0.0001 + 0.01 * (rnd() + rnd() + rnd() - 1.5));
    return { ts: end - (n - 1 - i) * H, open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close, volume: 1 + rnd() }; });
}
