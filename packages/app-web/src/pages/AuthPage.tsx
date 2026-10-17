import { useState } from 'react';
import type { FormEvent } from 'react';
import { post } from '../api.ts';

export function AuthPage({ onDone }: { onDone: () => Promise<void> }) {
  const [mode, setMode] = useState<'enter' | 'create'>('enter');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'enter') {
        await post('/api/auth/login', { code: code.trim(), password: password || undefined });
        await onDone();
      } else {
        const r = await post<{ code: string }>('/api/auth/register', { consent, password: password || undefined });
        setNewCode(r.code);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'algo deu errado');
    } finally {
      setBusy(false);
    }
  };

  if (newCode) {
    return (
      <div className="auth card stack">
        <h1>Sua conta foi criada</h1>
        <p>Este é o seu <b>código de acesso</b>. Anote-o: é a única forma de entrar de novo. Não guardamos e-mail nem nome.</p>
        <div className="code-box">{newCode}</div>
        <div className="row">
          <button className="btn" onClick={() => void navigator.clipboard?.writeText(newCode)}>Copiar código</button>
          <button className="btn primary" onClick={() => void onDone()}>Já anotei, continuar</button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth card stack">
      <h1>📚 Estudo com cartões</h1>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={mode === 'enter'} onClick={() => setMode('enter')}>Entrar</button>
        <button role="tab" aria-selected={mode === 'create'} onClick={() => setMode('create')}>Criar conta</button>
      </div>
      <form onSubmit={submit} className="stack">
        {mode === 'enter' && (
          <div>
            <label htmlFor="code">Seu código de acesso</label>
            <input id="code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="caramelo-XXXX-XXXX" autoComplete="username" required />
          </div>
        )}
        <div>
          <label htmlFor="password">{mode === 'enter' ? 'Senha (se você definiu uma)' : 'Senha (opcional, mínimo de 6 caracteres)'}</label>
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'enter' ? 'current-password' : 'new-password'} />
        </div>
        {mode === 'create' && (
          <div className="stack">
            <div className="card small" style={{ background: 'var(--accent-soft)' }}>
              <b>Termo de consentimento — versão de desenvolvimento.</b> O texto final será definido depois da aprovação do Comitê de Ética em Pesquisa.
              Esta versão de teste registra apenas como você usa o aplicativo, sem seu nome nem e-mail.
            </div>
            <label className="row" style={{ color: 'var(--text)' }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ width: 'auto' }} />
              <span>Li e aceito participar</span>
            </label>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={busy || (mode === 'create' && !consent)}>{mode === 'enter' ? 'Entrar' : 'Criar conta'}</button>
      </form>
    </div>
  );
}
