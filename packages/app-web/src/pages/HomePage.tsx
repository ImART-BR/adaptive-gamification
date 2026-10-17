import { useEffect, useState } from 'react';
import { get } from '../api.ts';
import { Avatar } from '../Avatar.tsx';
import { GameElement } from '../GameElement.tsx';
import type { Home } from '../types.ts';

const MASTERY_SHOWN = 3;
const RANKING_SHOWN = 5;
const RECENT_BADGES = 4;

/** Home = the user's own progress. The community elements (feed, groups, pair, impact, questions, gifts) live in /comunidade. */
export function HomePage() {
  const [h, setH] = useState<Home | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get<Home>('/api/home').then(setH).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!h) return <p className="muted">Carregando…</p>;

  const remaining = h.today.queueTotal - h.today.queueDone;
  const nextDeck = h.today.decks[0];
  const moreDecks = remaining > 0 ? Math.max(0, h.today.decks.length - 1) : 0;
  const nextUnlock = [...h.cosmetics.themes, ...h.cosmetics.frames].filter((x) => !x.unlocked).sort((a, b) => a.level - b.level)[0];
  const unlocked = h.achievements.filter((a) => a.unlockedAt).sort((a, b) => (b.unlockedAt as number) - (a.unlockedAt as number));
  const rank = h.leaderboard;
  const shownRank = rank.top.slice(0, RANKING_SHOWN);
  const meOutside = rank.me && rank.me.rank > RANKING_SHOWN ? rank.me : null;

  return (
    <div className="stack">
      <section className="card hero">
        <div>
          <p className="eyebrow">Hoje</p>
          {h.today.queueTotal === 0 ? (
            <h1>Nenhum baralho para estudar</h1>
          ) : remaining === 0 || nextDeck === undefined ? (
            <h1>Fila de hoje concluída 🎉</h1>
          ) : (
            <h1>{nextDeck.title}</h1>
          )}
          {moreDecks > 0 && <p className="muted">e mais {moreDecks} {moreDecks === 1 ? 'baralho' : 'baralhos'}</p>}
          {h.today.queueTotal > 0 && (
            <div className="bar good" role="progressbar" aria-valuenow={h.today.queueDone} aria-valuemin={0} aria-valuemax={h.today.queueTotal} style={{ marginTop: 12, maxWidth: 420 }}>
              <span style={{ width: `${(100 * h.today.queueDone) / h.today.queueTotal}%` }} />
            </div>
          )}
        </div>
        <a className="btn primary big" href={h.today.queueTotal === 0 ? '#/biblioteca' : '#/estudar'}>
          {h.today.queueTotal === 0 ? 'Ir à biblioteca' : remaining === 0 ? 'Revisar mais' : 'Estudar agora'}
        </a>
      </section>

      <div className="grid">
        <GameElement id="points">
          <h2>Pontos</h2>
          <div className="big-number">{h.points.total}</div>
          <p className="muted small">{h.points.weekly} nesta semana · {h.streakDays} {h.streakDays === 1 ? 'dia' : 'dias'} seguidos</p>
        </GameElement>

        <GameElement id="levels">
          <h2>Nível {h.level.level}</h2>
          <div className="bar" role="progressbar" aria-valuenow={h.level.into} aria-valuemin={0} aria-valuemax={h.level.needed}>
            <span style={{ width: `${Math.min(100, (100 * h.level.into) / h.level.needed)}%` }} />
          </div>
          <p className="muted small">Faltam {h.level.needed - h.level.into} pontos para o nível {h.level.level + 1}</p>
        </GameElement>

        <GameElement id="cosmetic_rewards">
          <h2>Recompensas</h2>
          {nextUnlock ? (
            <p>Próxima: <b>{nextUnlock.label}</b>, no nível {nextUnlock.level}.</p>
          ) : (
            <p>Você desbloqueou todas as recompensas visuais. 🏅</p>
          )}
          <a href="#/perfil">Personalizar</a>
        </GameElement>

        <GameElement id="challenges">
          <h2>Desafios de hoje</h2>
          <div className="stack">
            {h.challenges.map((c) => (
              <div key={c.key}>
                <div className="row spread small">
                  <span>{c.claimed ? '✅ ' : ''}{c.title}</span>
                  <span className="muted">+{c.reward}</span>
                </div>
                <div className="bar" role="progressbar" aria-valuenow={c.progress} aria-valuemin={0} aria-valuemax={c.target}>
                  <span style={{ width: `${Math.min(100, (100 * c.progress) / Math.max(1, c.target))}%` }} />
                </div>
              </div>
            ))}
          </div>
        </GameElement>

        <GameElement id="mastery_bar">
          <h2>Domínio por baralho</h2>
          {h.mastery.length === 0 ? (
            <p className="muted">Você ainda não tem baralhos.</p>
          ) : (
            <div className="stack">
              {h.mastery.slice(0, MASTERY_SHOWN).map((m) => (
                <div key={m.deckId}>
                  <div className="row spread small">
                    <a href={`#/baralho/${m.deckId}`}>{m.title}</a>
                    <span className="muted">{m.masteryPct}%</span>
                  </div>
                  <div className="bar good" role="progressbar" aria-valuenow={m.masteryPct} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: `${m.masteryPct}%` }} />
                  </div>
                </div>
              ))}
              {h.mastery.length > MASTERY_SHOWN && <a className="small" href="#/biblioteca">Ver todos os {h.mastery.length} baralhos</a>}
            </div>
          )}
        </GameElement>

        <GameElement id="leaderboard">
          <h2>Ranking da semana</h2>
          {shownRank.length === 0 ? (
            <p className="muted">Ninguém pontuou ainda esta semana. Seja o primeiro!</p>
          ) : (
            <div>
              {shownRank.map((r) => (
                <div key={r.rank} className={`rank-row ${r.me ? 'me' : ''}`}>
                  <span className="rank">{r.rank}º</span>
                  <Avatar avatar={r.avatar} frame={r.frame} />
                  <span className="name">{r.nickname}{r.me ? ' (você)' : ''}</span>
                  <b>{r.points}</b>
                </div>
              ))}
              {meOutside && (
                <div className="rank-row me">
                  <span className="rank">{meOutside.rank}º</span>
                  <Avatar avatar={meOutside.avatar} frame={meOutside.frame} />
                  <span className="name">{meOutside.nickname} (você)</span>
                  <b>{meOutside.points}</b>
                </div>
              )}
            </div>
          )}
        </GameElement>

        <GameElement id="achievements" className="wide">
          <div className="row spread">
            <h2>Conquistas</h2>
            <span className="muted small">{unlocked.length} de {h.achievements.length}</span>
          </div>
          <div className="bar"><span style={{ width: `${(100 * unlocked.length) / h.achievements.length}%` }} /></div>
          {unlocked.length > 0 && (
            <div className="chips">
              {unlocked.slice(0, RECENT_BADGES).map((a) => <span key={a.key} className="chip" title={a.description}>🏅 {a.title}</span>)}
            </div>
          )}
          <details className="more">
            <summary>Ver todas as conquistas</summary>
            <div className="badge-grid">
              {h.achievements.map((a) => (
                <div key={a.key} className={`badge ${a.unlockedAt ? '' : 'locked'}`}>
                  <b>{a.unlockedAt ? '🏅' : '🔒'} {a.title}</b>
                  <span className="muted">{a.description}</span>
                </div>
              ))}
            </div>
          </details>
        </GameElement>
      </div>

      <a className="card link-card" href="#/comunidade">
        <span><b>Comunidade</b><span className="muted"> · grupos, dupla, dúvidas e atividade dos colegas</span></span>
        <span aria-hidden="true">→</span>
      </a>
    </div>
  );
}
