import { useEffect, useState } from 'react';
import { get, patch } from '../api.ts';
import { Avatar } from '../Avatar.tsx';
import { GameElement } from '../GameElement.tsx';
import type { Me } from '../App.tsx';
import type { Home } from '../types.ts';

export function ProfilePage({ me, onChange, onLogout }: { me: Me; onChange: () => Promise<void>; onLogout: () => Promise<void> }) {
  const [cos, setCos] = useState<Home['cosmetics'] | null>(null);
  const [level, setLevel] = useState(1);
  const [nickname, setNickname] = useState(me.nickname);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    get<Home>('/api/home').then((h) => { setCos(h.cosmetics); setLevel(h.level.level); }).catch((e: Error) => setError(e.message));
  }, [me]);

  const save = async (body: Record<string, string>) => {
    setError('');
    try {
      await patch('/api/me', body);
      await onChange();
      setSaved('Salvo.');
      window.setTimeout(() => setSaved(''), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'erro');
    }
  };

  if (!cos) return <p className={error ? 'error' : 'muted'}>{error || 'Carregando…'}</p>;

  return (
    <div className="grid">
      <section className="card wide row spread">
        <div className="row">
          <Avatar avatar={me.avatar} frame={me.frame} big />
          <div><h1>{me.nickname}</h1><span className="muted">Nível {level}</span></div>
        </div>
        <button className="btn" onClick={() => void onLogout()}>Sair</button>
      </section>
      {error && <p className="error wide" role="alert">{error}</p>}
      {saved && <p role="status">{saved}</p>}

      <GameElement id="avatar_theme">
        <h2>Seu avatar</h2>
        <div className="stack">
          <div>
            <label htmlFor="nick">Apelido (aparece no ranking)</label>
            <div className="row">
              <input id="nick" value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={24} style={{ flex: 1 }} />
              <button className="btn" onClick={() => void save({ nickname })}>Salvar</button>
            </div>
          </div>
          <div className="row" role="group" aria-label="Escolher avatar">
            {cos.avatars.map((a) => (
              <button key={a} className="btn" aria-pressed={me.avatar === a} style={me.avatar === a ? { borderColor: 'var(--accent)' } : undefined} onClick={() => void save({ avatar: a })}>
                <span style={{ fontSize: '1.5rem' }}>{a}</span>
              </button>
            ))}
          </div>
        </div>
      </GameElement>

      <GameElement id="cosmetic_rewards">
        <h2>Recompensas visuais</h2>
        <p className="muted small">Desbloqueadas ao subir de nível.</p>
        <h3>Temas</h3>
        <div className="row">
          {cos.themes.map((t) => (
            <button key={t.key} className="btn" disabled={!t.unlocked} aria-pressed={me.theme === t.key} style={me.theme === t.key ? { borderColor: 'var(--accent)' } : undefined} onClick={() => void save({ theme: t.key })}>
              {t.label}{!t.unlocked && ` 🔒 nível ${t.level}`}
            </button>
          ))}
        </div>
        <h3 style={{ marginTop: 12 }}>Molduras</h3>
        <div className="row">
          {cos.frames.map((f) => (
            <button key={f.key} className="btn" disabled={!f.unlocked} aria-pressed={me.frame === f.key} style={me.frame === f.key ? { borderColor: 'var(--accent)' } : undefined} onClick={() => void save({ frame: f.key })}>
              {f.label}{!f.unlocked && ` 🔒 nível ${f.level}`}
            </button>
          ))}
        </div>
      </GameElement>
    </div>
  );
}
