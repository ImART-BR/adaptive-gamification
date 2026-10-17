import { useState } from 'react';
import { post } from '../api.ts';
import { Avatar } from '../Avatar.tsx';
import { GameElement } from '../GameElement.tsx';
import type { FeedItem, GiftInfo, Impact, PairInfo, PublicUser, SocialSummary } from '../types.ts';

export function feedText(i: FeedItem): string {
  const p = i.payload;
  switch (i.type) {
    case 'queue_done': return 'concluiu a fila do dia';
    case 'level_up': return `chegou ao nível ${p.level}`;
    case 'achievement': return `desbloqueou “${p.title}”`;
    case 'deck_shared': return p.groupName ? `compartilhou “${p.deckTitle}” no grupo ${p.groupName}` : `publicou o baralho “${p.deckTitle}”`;
    case 'helpful_answer': return 'teve uma resposta marcada como útil';
    case 'gift': return i.toMe ? 'presenteou você 🎁' : `presenteou ${p.toNickname} 🎁`;
    case 'joined_group': return `entrou no grupo ${p.groupName}`;
    case 'pair_formed': return 'formou uma dupla de estudo';
    case 'pair_goal': return 'e a dupla concluíram a fila de hoje';
    case 'suggestion_accepted': return `teve uma sugestão aceita em “${p.deckTitle}”`;
    default: return 'fez algo novo';
  }
}

export function timeAgo(at: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - at) / 60000));
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

export function FeedCard({ items }: { items: FeedItem[] | null }) {
  return (
    <GameElement id="activity_feed">
      <h2>Atividade dos colegas</h2>
      {items === null ? (
        <p className="muted">Carregando…</p>
      ) : items.length === 0 ? (
        <p className="muted">Nada por aqui ainda. Entre em um <a href="#/comunidade/grupos">grupo</a> ou forme uma dupla para ver o que os colegas estão fazendo.</p>
      ) : (
        <ul className="feed">
          {items.slice(0, 8).map((i) => (
            <li key={i.id}>
              <Avatar avatar={i.user.avatar} frame={i.user.frame} /> <b>{i.user.nickname}</b> {feedText(i)} <span className="muted small">· {timeAgo(i.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </GameElement>
  );
}

export function GroupsCard({ summary }: { summary: SocialSummary | null }) {
  return (
    <GameElement id="study_groups">
      <h2>Grupos de estudo</h2>
      {!summary ? (
        <p className="muted">Carregando…</p>
      ) : summary.groups.length === 0 ? (
        <p className="muted">Você ainda não está em nenhum grupo. Crie um ou entre com um código.</p>
      ) : (
        <div className="stack">
          {summary.groups.map((g) => (
            <div key={g.id}>
              <div className="row spread small">
                <a href={`#/comunidade/grupo/${g.id}`}>{g.name}</a>
                <span className="muted">{g.memberCount} pessoas · {g.weekReviews}/{g.weekGoal} revisões na semana</span>
              </div>
              <div className="bar good"><span style={{ width: `${Math.min(100, (100 * g.weekReviews) / Math.max(1, g.weekGoal))}%` }} /></div>
            </div>
          ))}
        </div>
      )}
      <p><a href="#/comunidade/grupos">Abrir grupos</a></p>
    </GameElement>
  );
}

export function PairCard({ info }: { info: PairInfo | null }) {
  const pair = info?.pair ?? null;
  return (
    <GameElement id="pair_study">
      <h2>Estudo em dupla</h2>
      {!info ? (
        <p className="muted">Carregando…</p>
      ) : !pair ? (
        <p className="muted">Estude junto com alguém: quando vocês dois concluírem a fila do dia, cada um ganha pontos extras.</p>
      ) : (
        <div className="stack">
          <div className="row"><Avatar avatar={pair.partner.avatar} frame={pair.partner.frame} /> <b>{pair.partner.nickname}</b></div>
          <p className="small">
            {pair.partnerToday === null ? 'Ainda não abriu o app hoje.' : `Hoje: ${pair.partnerToday.done} de ${pair.partnerToday.total} cartões.`}
          </p>
          <p className="small muted">
            {pair.bonusToday ? `✅ Bônus de ${pair.bonusPoints} pontos recebido hoje.` : `Quando os dois concluírem a fila de hoje: +${pair.bonusPoints} pontos para cada um.`}
          </p>
        </div>
      )}
      <p><a href="#/comunidade/dupla">Gerenciar dupla</a></p>
    </GameElement>
  );
}

export function ImpactCard({ impact }: { impact: Impact | null }) {
  return (
    <GameElement id="share_decks">
      <h2>Seu impacto</h2>
      {!impact ? (
        <p className="muted">Carregando…</p>
      ) : (
        <>
          <ul className="plain">
            <li><b>{impact.adopters}</b> {impact.adopters === 1 ? 'pessoa adicionou' : 'pessoas adicionaram'} baralhos seus</li>
            <li><b>{impact.remixers}</b> {impact.remixers === 1 ? 'pessoa remixou' : 'pessoas remixaram'} baralhos seus</li>
            <li><b>{impact.helpfulAnswers}</b> {impact.helpfulAnswers === 1 ? 'resposta sua foi útil' : 'respostas suas foram úteis'}</li>
          </ul>
          <p className="muted small">Compartilhe um baralho (abra-o e use “Compartilhar”) para ajudar mais gente.</p>
        </>
      )}
    </GameElement>
  );
}

export function QuestionsTeaser({ count }: { count: number | null }) {
  return (
    <GameElement id="answer_peers">
      <h2>Dúvidas dos colegas</h2>
      {count === null ? (
        <p className="muted">Carregando…</p>
      ) : count === 0 ? (
        <p className="muted">Nenhuma dúvida em aberto agora.</p>
      ) : (
        <p><b>{count}</b> {count === 1 ? 'dúvida espera' : 'dúvidas esperam'} por uma resposta.</p>
      )}
      <a href="#/comunidade/duvidas">Ver e responder</a>
    </GameElement>
  );
}

/** Lets the user send a small gift of points to someone from their groups or study pair. */
export function GiftCard({ connections, gifts, onSent }: { connections: PublicUser[]; gifts: GiftInfo | null; onSent: () => void }) {
  const [handle, setHandle] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const send = async () => {
    setError('');
    setMsg('');
    try {
      await post('/api/gifts', { handle });
      setMsg('Presente enviado! 🎁');
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'erro');
    }
  };

  return (
    <GameElement id="gifting">
      <h2>Presentear um colega</h2>
      {connections.length === 0 ? (
        <p className="muted">Para presentear alguém, entre em um grupo ou forme uma dupla.</p>
      ) : (
        <div className="stack">
          <p className="small muted">Cada presente dá {gifts?.giftPoints ?? 5} pontos a quem recebe. Restam {gifts?.remainingToday ?? '…'} hoje.</p>
          <div className="row">
            <select aria-label="Quem presentear" value={handle} onChange={(e) => setHandle(e.target.value)} style={{ flex: 1, minWidth: 160 }}>
              <option value="">Escolha alguém…</option>
              {connections.map((u) => <option key={u.handle} value={u.handle}>{u.avatar} {u.nickname}</option>)}
            </select>
            <button className="btn primary" disabled={!handle || gifts?.remainingToday === 0} onClick={() => void send()}>Enviar presente</button>
          </div>
          {msg && <p role="status">{msg}</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      )}
    </GameElement>
  );
}
