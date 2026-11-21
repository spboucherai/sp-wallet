#!/usr/bin/env python3
# =============================================================================
#                  SP BOUCHER | SOFTWARE & RESEARCH
#             ARTIFICIAL INTELLIGENCE • FINANCE • ENGINEERING
# =============================================================================
#
# PROJECT METADATA
# -----------------------------------------------------------------------------
# Project          : SP Wallet
# File             : scripts/merge-registries.py
# Description      : Resolve the predictable conflicts produced when two
#                    chain-family branches both extend the registries.
# Module           : scripts
# Repository       : https://git.spboucher.ai/sp-wallet
# Project Website  : https://wallet.spboucher.ai
# Created          : 2026-11-10
# Last Modified    : 2026-11-10
#
# =============================================================================
# AUTHOR & PROFESSIONAL AFFILIATION
# =============================================================================
#
# Author           : Simon-Pierre Boucher
# Position         : Professor of Finance
# Institution      : Université du Québec en Outaouais (UQO)
# Department       : Département des sciences administratives
# Organization     : SP Boucher
#
# Website          : https://spboucher.ai
# Git              : https://git.spboucher.ai
#
# =============================================================================
# OFFICIAL CONTACT DIRECTORY
# =============================================================================
#
# General          : info@spboucher.ai
# Professional     : contact@spboucher.ai
# Direct           : simon@spboucher.ai
# Research         : research@spboucher.ai
# Development      : dev@spboucher.ai
# Support          : support@spboucher.ai
# Security/Admin   : admin@spboucher.ai
# Notifications    : notifications@spboucher.ai
#
# Preferred Contact: support@spboucher.ai
#
# =============================================================================
# COPYRIGHT & INTELLECTUAL PROPERTY
# =============================================================================
#
# Copyright (c) 2026
# Simon-Pierre Boucher
#
# All rights reserved where applicable.
#
# This file is governed by the applicable project license,
# copyright notices, institutional agreements and relevant law.
#
# Unless expressly authorized by the applicable license or
# rights holder, copying, redistribution, sublicensing,
# publication and commercial exploitation are not permitted.
#
# Existing third-party rights and notices remain unaffected.
#
# =============================================================================
# CONFIDENTIALITY & SECURITY
# =============================================================================
#
# Classification   : Public
# Distribution     : Public repository; use is governed by the project license
# Security Contact : admin@spboucher.ai
#
# Access to this source does not independently grant permission
# to redistribute or disclose confidential materials.
#
# Do not embed credentials, private keys, access tokens,
# certificates or confidential personal information.
#
# =============================================================================
# LICENSE & MAINTENANCE
# =============================================================================
#
# License          : None specified (no license file in this repository)
# Maintainer       : Simon-Pierre Boucher
# Technical Contact: dev@spboucher.ai
#
# =============================================================================
# END OF SP BOUCHER SOURCE HEADER
# =============================================================================

"""Resolve the predictable conflicts produced when two chain-family branches both extend the registries.
Rule: keep both sides. Run after `git merge <branch>` reports conflicts, then `pnpm install`, typecheck and test."""
import os, re, subprocess
R = re.compile(r"<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> [^\n]+\n", re.S)
ENTRY = re.compile(r"([A-Za-z_][A-Za-z0-9_]*): ('[^']*'|[A-Za-z0-9_]+)")
def union_entries(a, b):
    """Two versions of `k: v, k: v, …` lines: HEAD's text plus the entries only the other side has, as extra lines."""
    have = {k for k, _ in ENTRY.findall(a)}
    extra = [ln for ln in b.splitlines() if any(k not in have for k, _ in ENTRY.findall(ln.split('//')[0]))]
    out = a
    for ln in extra:
        new = [(k, v) for k, v in ENTRY.findall(ln.split('//')[0]) if k not in have]
        comment = ('  //' + ln.split('//', 1)[1]) if '//' in ln and len(new) == len(ENTRY.findall(ln.split('//')[0])) else ''
        out += '  ' + ', '.join(f"{k}: {v}" for k, v in new) + ',' + comment + '\n'
    return out
def fix(path, fn):
    s = open(path).read()
    if '<<<<<<< HEAD' not in s: return
    open(path, 'w').write(R.sub(fn, s)); print('resolved', path)
def networks(m):
    a, b = m.group(1), m.group(2)
    if re.search(r"^\s+id: '", a, re.M) and re.search(r"^\s+id: '", b, re.M): return a + "  },\n" + b  # two network entries
    return a + ''.join(ln + '\n' for ln in b.splitlines() if ln not in a.splitlines())                    # comment lines
fix('packages/core/src/networks.ts', networks)
fix('packages/core/src/policy.ts', lambda m: union_entries(m.group(1), m.group(2)))
fix('services/api/src/server.ts', lambda m: union_entries(m.group(1), m.group(2)))
fix('apps/web/src/i18n.ts', lambda m: m.group(1) + m.group(2))
fix('scripts/smoke-chains.mts', lambda m: m.group(1))
fix('package.json', lambda m: ''.join(sorted(set((m.group(1) + m.group(2)).splitlines(True)))))  # devDependencies: keep both, sorted
# registries that are pure functions of the files present: regenerate
plug = sorted(f[:-3] for f in os.listdir('packages/core/src/plugins') if f.endswith('.ts') and f != 'index.ts')
open('packages/core/src/plugins/index.ts', 'w').write("// Chain family plugins. Importing this module registers every plugin with the registry in families.ts.\nimport { registerFamily } from '../families.ts';\n"
    + ''.join(f"import {{ {p}Plugin }} from './{p}.ts';\n" for p in plug) + f"\nfor (const p of [{', '.join(p + 'Plugin' for p in plug)}]) registerFamily(p);\n\n" + ''.join(f"export * from './{p}.ts';\n" for p in plug))
p = 'services/api/src/chains/index.ts'; s = open(p).read()
fams = sorted(set(plug))
s = R.sub(lambda m: m.group(1), s)
s = re.sub(r"(import \{ [a-z]+Adapter \} from '\./[a-z]+\.ts';\n)+", ''.join(f"import {{ {f}Adapter }} from './{f}.ts';\n" for f in sorted(['btc', 'evm', 'sol'] + fams)), s, count=1)
s = re.sub(r"export const ADAPTER_FACTORIES: Record<string, \(n: NetworkDef\) => Adapter> = \{[^}]*\};",
    "export const ADAPTER_FACTORIES: Record<string, (n: NetworkDef) => Adapter> = { " + ', '.join(f"{f}: {f}Adapter" for f in ['evm', 'btc', 'sol'] + fams) + " };", s)
open(p, 'w').write(s)
# swap provider registry: regenerate from the adapter files present (each exports create<Name>Provider)
pdir = 'packages/swap/src/providers'
if os.path.isdir(pdir):
    facs = []
    for f in sorted(os.listdir(pdir)):
        if not f.endswith('.ts') or f == 'index.ts': continue
        names = re.findall(r"export (?:function|const) (create[A-Za-z0-9]+Provider)\b", open(os.path.join(pdir, f)).read())
        # the factory named after the file (create<File>Provider); helper factories exported by the same file are not providers
        own = [x for x in names if x.lower() == 'create' + f[:-3].replace('-', '').lower() + 'provider']
        if own: facs.append((f, own[0]))
    open(os.path.join(pdir, 'index.ts'), 'w').write("// Provider registry (regenerated by scripts/merge-registries.py). One file per provider; each exports a factory returning a SwapProvider.\n// Odos is deliberately absent: its API was permanently shut down on 2026-07-30 (docs/swap/providers/odos.md).\nimport type { SwapProvider } from '../types.ts';\n"
        + ''.join(f"import {{ {fn} }} from './{f}';\n" for f, fn in facs)
        + "\nexport interface ProviderEnv { [key: string]: string | undefined }\n/** Every real provider adapter, in a fixed order. A provider that needs a key reports `configured: false` without one. */\nexport function createProviders(env: ProviderEnv = {}): SwapProvider[] {\n  return ["
        + ', '.join(f"{fn}(env)" for _, fn in facs) + "];\n}\n")
subprocess.run(['git', 'checkout', '--theirs', 'pnpm-lock.yaml'], capture_output=True)
left = subprocess.run("git diff --name-only --diff-filter=U", shell=True, capture_output=True, text=True).stdout.split()
bad = [f for f in left if f != 'pnpm-lock.yaml' and '<<<<<<<' in open(f).read()]
print('still conflicted:', bad or 'none')
