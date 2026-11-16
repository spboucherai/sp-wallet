// v11 interface (docs/v11/UI-ARCHITECTURE.md) — the FIVE areas of the navigation, the same on the phone's tab bar and in the
// desktop sidebar: [area, icon, i18n key of its label]. A module of its own because the shell (App.tsx, first chunk) and the
// lazily loaded part of the shell (shell-more.tsx) both read it, and neither may import the other's code.
import type { Key } from './i18n';

export type Area = 'home' | 'markets' | 'trade' | 'agents' | 'activity';
export const AREAS: readonly (readonly [Area, string, Key])[] = [['home', 'home', 'home'], ['markets', 'chart', 'mkTab'], ['trade', 'swap', 'v11NavTrade'], ['agents', 'robot', 'agents'], ['activity', 'list', 'activity']];
