import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from '../api.ts';
import type { DeckQueue, QueueCard, QueueResponse, ReviewResult } from '../types.ts';

const GRADES = [
  { grade: 0, label: 'Errei', key: '1' },
  { grade: 1, label: 'Difícil', key: '2' },
  { grade: 2, label: 'Bom', key: '3' },
  { grade: 3, label: 'Fácil', key: '4' },
];

const STORAGE_KEY = 'ga.study.decks';

function savedSelection(): number[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

function saveSelection(ids: number[]) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // The selection is a convenience; ignore storage failures.
  }
}

/** Step 1: choose which decks to study today. Step 2: the cards, with the deck title in evidence. */
export function StudyPage() {
  const [decks, setDecks] = useState<DeckQueue[] | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [phase, setPhase] = useState<'choose' | 'study'>('choose');
  const [error, setError] = useState('');

  const loadDecks = useCallback(async () => {
    const list = await get<DeckQueue[]>('/api/review/decks');
    setDecks(list);
    const pending = list.filter((d) => d.pending > 0).map((d) => d.deckId);
    const saved = savedSelection().filter((id) => pending.includes(id));
    setSelected(saved.length > 0 ? saved : pending);
  }, []);

  useEffect(() => {
    loadDecks().catch((e: Error) => setError(e.message));
  }, [loadDecks]);

  if (error) return <p className="error">{error}</p>;
  if (!decks) return <p className="muted">Carregando…</p>;

  if (decks.length === 0) {
    return (
      <div className="study card stack">
        <h1>Nada para revisar hoje</h1>
        <p>Adicione um baralho à sua biblioteca para receber cartões.</p>
        <a className="btn primary" href="#/biblioteca" style={{ textDecoration: 'none' }}>Ir à biblioteca</a>
      </div>
    );
  }

  if (phase === 'choose') {
    return (
      <ChooseDecks
        decks={decks}
        selected={selected}
        onChange={setSelected}
        onStart={() => {
          saveSelection(selected);
          setPhase('study');
        }}
      />
    );
  }

  return (
    <StudyCards
      deckIds={selected}
      onBack={() => {
        void loadDecks().then(() => setPhase('choose'));
      }}
    />
  );
}

function ChooseDecks({ decks, selected, onChange, onStart }: { decks: DeckQueue[]; selected: number[]; onChange: (ids: number[]) => void; onStart: () => void }) {
  const pendingDecks = decks.filter((d) => d.pending > 0);
  const cardCount = decks.filter((d) => selected.includes(d.deckId)).reduce((n, d) => n + d.pending, 0);
  const toggle = (id: number) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  if (pendingDecks.length === 0) {
    return (
      <div className="study card stack">
        <h1>Fila de hoje concluída 🎉</h1>
        <p>Todos os baralhos estão em dia. Volte amanhã para as próximas revisões.</p>
        <a className="btn primary" href="#/" style={{ textDecoration: 'none' }}>Voltar ao início</a>
      </div>
    );
  }

  return (
    <div className="study stack">
      <div>
        <h1>O que você quer estudar?</h1>
        <p className="muted">Escolha um ou mais baralhos para começar.</p>
      </div>
      <div className="deck-choices" role="group" aria-label="Baralhos disponíveis">
        {decks.map((d) => {
          const done = d.pending === 0;
          const on = selected.includes(d.deckId);
          return (
            <label key={d.deckId} className={`deck-choice ${on ? 'on' : ''} ${done ? 'done' : ''}`}>
              <input type="checkbox" checked={on} disabled={done} onChange={() => toggle(d.deckId)} />
              <span className="deck-choice-text">
                <b>{d.title}</b>
                <span className="muted small">
                  {done ? 'Concluído hoje ✅' : `${d.pending} ${d.pending === 1 ? 'cartão' : 'cartões'}${d.fresh > 0 ? ` · ${d.fresh} ${d.fresh === 1 ? 'novo' : 'novos'}` : ''}`}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <div className="row">
        <button className="btn primary big" disabled={selected.length === 0} onClick={onStart}>
          {selected.length === 0 ? 'Escolha um baralho' : `Começar (${cardCount} ${cardCount === 1 ? 'cartão' : 'cartões'})`}
        </button>
        {pendingDecks.length > 1 && (
          <button className="btn" onClick={() => onChange(selected.length === pendingDecks.length ? [] : pendingDecks.map((d) => d.deckId))}>
            {selected.length === pendingDecks.length ? 'Limpar escolha' : 'Escolher todos'}
          </button>
        )}
      </div>
    </div>
  );
}

function StudyCards({ deckIds, onBack }: { deckIds: number[]; onBack: () => void }) {
  const [cards, setCards] = useState<QueueCard[] | null>(null);
  const [sel, setSel] = useState({ total: 0, done: 0 });
  const [revealed, setRevealed] = useState(false);
  const [toast, setToast] = useState('');
  const [points, setPoints] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    const q = await get<QueueResponse>(`/api/review/queue?decks=${deckIds.join(',')}`);
    setCards(q.cards);
    setSel(q.selected);
    setRevealed(false);
  }, [deckIds]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3500);
  };

  const ask = async (card: QueueCard) => {
    try {
      await post('/api/questions', { deckId: card.deckId, cardId: card.id, text: question });
      setAsking(false);
      showToast('Dúvida publicada. Os colegas poderão responder.');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'erro');
    }
  };

  const answer = useCallback(
    async (grade: number) => {
      if (!cards || cards.length === 0 || busy) return;
      setBusy(true);
      try {
        const card = cards[0]!;
        const r = await post<ReviewResult>('/api/review', { cardId: card.id, grade });
        setPoints(r.totalPoints);
        const done = grade >= 1 ? sel.done + 1 : sel.done;
        setSel({ total: sel.total, done });
        const parts: string[] = [];
        if (r.pointsGained > 0) parts.push(`+${r.pointsGained} pontos`);
        if (r.levelAfter > r.levelBefore) parts.push(`⬆️ nível ${r.levelAfter}!`);
        r.challengesDone.forEach((c) => parts.push(`🎯 ${c.title} (+${c.reward})`));
        r.newAchievements.forEach((a) => parts.push(`🏅 ${a.title} (+${a.bonus})`));
        if (r.pairBonus > 0) parts.push(`👥 Bônus da dupla (+${r.pairBonus})`);
        if (parts.length > 0) showToast(parts.join(' · '));
        const rest = cards.slice(1);
        const next = grade === 0 ? [...rest, card] : rest;
        setRevealed(false);
        setAsking(false);
        if (next.length === 0) await load();
        else setCards(next);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'erro');
      } finally {
        setBusy(false);
      }
    },
    [cards, busy, load, sel],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed) {
        const g = GRADES.find((x) => x.key === e.key);
        if (g) void answer(g.grade);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealed, answer]);

  if (error) return <p className="error">{error}</p>;
  if (!cards) return <p className="muted">Carregando…</p>;

  if (cards.length === 0) {
    return (
      <div className="study card stack">
        <h1>Você terminou os baralhos escolhidos 🎉</h1>
        <p>{sel.done} de {sel.total} cartões feitos.{points !== null ? ` Total de pontos: ${points}.` : ''}</p>
        <div className="row">
          <button className="btn primary" onClick={onBack}>Escolher outros baralhos</button>
          <a className="btn" href="#/" style={{ textDecoration: 'none' }}>Voltar ao início</a>
        </div>
      </div>
    );
  }

  const card = cards[0]!;
  return (
    <div className="study stack">
      <div className="row spread">
        <button className="btn" onClick={onBack}>← Baralhos</button>
        {points !== null && <span className="muted">{points} pts</span>}
      </div>
      <div>
        <p className="eyebrow">Baralho{card.isNew ? ' · cartão novo' : ''}</p>
        <h1 className="deck-title">{card.deckTitle}</h1>
      </div>
      <div className="bar good" role="progressbar" aria-label="Progresso nos baralhos escolhidos" aria-valuenow={sel.done} aria-valuemin={0} aria-valuemax={sel.total}>
        <span style={{ width: `${(100 * sel.done) / Math.max(1, sel.total)}%` }} />
      </div>
      <p className="muted small" style={{ margin: 0 }}>{sel.done} de {sel.total} feitos</p>
      <div className="card flash" onClick={() => setRevealed(true)} role="button" tabIndex={0} aria-label="Mostrar a resposta">
        <div>
          <div>{card.front}</div>
          {revealed && <div className="answer">{card.back}</div>}
          {!revealed && <p className="muted small">Clique ou aperte espaço para ver a resposta</p>}
        </div>
      </div>
      <div className="row">
        {!asking ? (
          <button className="btn" onClick={() => { setAsking(true); setQuestion(''); }}>🙋 Tenho uma dúvida sobre este cartão</button>
        ) : (
          <form className="row" style={{ width: '100%' }} onSubmit={(e) => { e.preventDefault(); void ask(card); }}>
            <input aria-label="Sua dúvida" autoFocus value={question} maxLength={500} onChange={(e) => setQuestion(e.target.value)} placeholder="Qual é a sua dúvida?" style={{ flex: 1, minWidth: 200 }} required />
            <button className="btn primary">Perguntar</button>
            <button type="button" className="btn" onClick={() => setAsking(false)}>Cancelar</button>
          </form>
        )}
      </div>
      {revealed && (
        <div className="grades">
          {GRADES.map((g) => (
            <button key={g.grade} className="btn" disabled={busy} onClick={() => void answer(g.grade)}>
              {g.label}
              <div className="muted small">({g.key})</div>
            </button>
          ))}
        </div>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
