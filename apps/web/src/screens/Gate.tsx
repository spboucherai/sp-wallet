import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useState } from 'react';
import { post } from '../api';
import { errText, useT } from '../i18n';
import { Btn, Field, Icon, inputCls, Notice } from '../ui';

export function Gate({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false), [err, setErr] = useState(''), [token, setToken] = useState('');
  const supported = browserSupportsWebAuthn();
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr('');
    try { await fn(); onDone(); } catch (e) { setErr(errText(t, e)); } finally { setBusy(false); }
  };
  const login = () => run(async () => {
    const o = await post('/auth/login/options');
    const response = await startAuthentication({ optionsJSON: o.options });
    await post('/auth/login/verify', { challengeId: o.challengeId, response });
  });
  const doSetup = () => run(async () => {
    const o = await post('/auth/setup/options');
    const response = await startRegistration({ optionsJSON: o.options });
    await post('/auth/setup/verify', { challengeId: o.challengeId, response, setupToken: token.trim(), label: navigator.platform || 'Passkey' });
  });
  return (
    <main className="safe-t safe-b mx-auto flex min-h-full max-w-sm flex-col justify-center px-6">
      <div className="rise">
        <img src="/icon.svg" alt="" className="mb-6 h-16 w-16 rounded-2xl" />
        <h1 className="text-3xl font-semibold tracking-tight">SP Wallet</h1>
        <p className="mt-1 text-mute">{t('tagline')}</p>
        <div className="mt-8 space-y-4">
          {!supported && <Notice tone="danger">{t('noWebauthn')}</Notice>}
          {setup ? (<>
            <Notice tone="info"><b>{t('setupTitle')}</b><br />{t('setupBody')}</Notice>
            <Field label={t('setupToken')}><input className={`${inputCls} font-mono`} value={token} onChange={(e) => setToken(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" /></Field>
            <Btn full busy={busy} disabled={!supported || token.trim().length < 8} onClick={doSetup}><Icon n="key" />{t('createPasskey')}</Btn>
          </>) : (<>
            <Btn full busy={busy} disabled={!supported} onClick={login}><Icon n="lock" />{t('unlock')}</Btn>
            <p className="text-center text-[13px] text-mute">{t('unlockHint')}</p>
          </>)}
          {err && <Notice tone="danger">{err}</Notice>}
        </div>
        <p className="mt-10 flex items-center justify-center gap-1.5 text-xs text-mute"><Icon n="shield" className="h-3.5 w-3.5" />{t('privateAccess')}</p>
      </div>
    </main>
  );
}
