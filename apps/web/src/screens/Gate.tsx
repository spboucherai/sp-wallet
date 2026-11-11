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
    <main className="gate safe-t safe-b relative mx-auto flex min-h-full max-w-sm flex-col justify-center px-6">
      <div className="gate-aura" aria-hidden="true" />
      <div className="rise relative">
        <img src="/icon.svg" alt="" width={84} height={84} className="gate-icon mb-8 h-[84px] w-[84px] rounded-[26px]" />
        <h1 className="t-display text-[44px]">SP Wallet</h1>
        <p className="mt-3 text-[16.5px] text-mute">{t('tagline')}</p>
        <div className="mt-9 space-y-4">
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
