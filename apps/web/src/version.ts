// NEXT W5 — the version shown in Settings comes from the BUILD: the package version and the short commit, injected by Vite's
// `define` (vite.config.ts). Outside a Vite build (unit tests) the constant does not exist: « dev ».
declare const __SPW_VERSION__: string | undefined;
export const APP_VERSION: string = typeof __SPW_VERSION__ === 'string' && __SPW_VERSION__ ? __SPW_VERSION__ : 'dev';
