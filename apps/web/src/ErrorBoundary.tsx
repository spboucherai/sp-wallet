/**
 * NEXT W3 — what the owner sees when the interface itself fails, instead of a blank page.
 *
 *  - A render error anywhere under a boundary: a message, "retry" (draw again), "reload", and — for a screen — the rest of the
 *    app (navigation, lock) stays usable. The message says what is true: an error of the display started no operation.
 *  - A lazy chunk that cannot be fetched (typically right after a new version was installed: the old file names are gone):
 *    ONE automatic reload, guarded against loops by a time stamp in sessionStorage; if the chunk still fails, the message
 *    with a manual reload. `vite:preloadError` (a background preload failing) never reloads by itself — a reload in the
 *    middle of an approval would lose the screen that says what happened; only a screen that really cannot be drawn does.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useT } from './i18n';
import { Btn, EmptyState, Icon } from './ui';

const RELOAD_KEY = 'spw-chunk-reload', RELOAD_GUARD_MS = 120_000;
/** the messages browsers give for a dynamic import that could not be fetched or evaluated (Chromium, WebKit, Gecko, Vite's preload helper) */
export const isChunkError = (e: unknown): boolean => /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|is not a valid JavaScript MIME type|ChunkLoadError/i.test(String((e as { message?: unknown } | null)?.message ?? e ?? ''));
/** May the app reload by itself for a failed chunk? Once: not if it already did so in the last two minutes (pure: tested). */
export function mayAutoReload(last: string | null, now: number): boolean { const t = Number(last); return !(Number.isFinite(t) && t > 0 && now - t < RELOAD_GUARD_MS); }
/** Reload once for a failed chunk. Returns false when the guard refuses (already reloaded) or storage is unavailable. */
export function reloadForChunk(): boolean {
  try {
    if (!mayAutoReload(sessionStorage.getItem(RELOAD_KEY), Date.now())) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch { return false; }   // no storage: no way to guard against a loop, so no automatic reload
  location.reload(); return true;
}
/** the errors Vite's preload helper reported (`vite:preloadError`): remembered — the screen that throws one of them failed for a chunk — never acted upon alone */
const preloadErrors = new WeakSet<object>();
export function watchChunkErrors(): void { addEventListener('vite:preloadError', (e) => { const p = (e as Event & { payload?: unknown }).payload; if (p && typeof p === 'object') preloadErrors.add(p); }); }
const chunkFailure = (e: unknown): boolean => isChunkError(e) || (!!e && typeof e === 'object' && preloadErrors.has(e));

function Crash({ chunk, scope, onRetry }: { chunk: boolean; scope: 'app' | 'screen'; onRetry: () => void }) {
  const t = useT();
  const body = <EmptyState icon={chunk ? 'cloudOff' : 'warn'} title={t(chunk ? 'nxChunkTitle' : 'nxCrashTitle')}
    action={<div className="flex flex-wrap justify-center gap-2.5">
      {!chunk && <Btn kind="soft" onClick={onRetry} data-testid="crash-retry"><Icon n="refresh" className="h-4 w-4" />{t('retry')}</Btn>}
      <Btn kind={chunk ? 'primary' : 'ghost'} onClick={() => location.reload()} data-testid="crash-reload">{t('nxReload')}</Btn></div>}>{t(chunk ? 'nxChunkBody' : 'nxCrashBody')}</EmptyState>;
  return <div role="alert" data-testid="crash" data-kind={chunk ? 'chunk' : 'error'} className={scope === 'app' ? 'safe-t safe-b mx-auto grid h-full max-w-sm place-items-center px-6' : 'pt-4'}><div className="w-full">{body}</div></div>;
}

interface Props { children: ReactNode; scope: 'app' | 'screen'; /** a change of this value clears the error (a screen boundary: the route) */ resetKey?: string }
interface State { error: unknown; reloading: boolean; key: string | undefined }
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, reloading: false, key: this.props.resetKey };
  static getDerivedStateFromError(error: unknown): Partial<State> { return { error }; }
  static getDerivedStateFromProps(p: Props, s: State): Partial<State> | null { return p.resetKey !== s.key ? { key: p.resetKey, error: null, reloading: false } : null; }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[spw] render error', error, info.componentStack);
    if (chunkFailure(error) && reloadForChunk()) this.setState({ reloading: true });
  }
  override render(): ReactNode {
    const { error, reloading } = this.state;
    if (error === null) return this.props.children;
    if (reloading) return null;
    return <Crash chunk={chunkFailure(error)} scope={this.props.scope} onRetry={() => this.setState({ error: null })} />;
  }
}
