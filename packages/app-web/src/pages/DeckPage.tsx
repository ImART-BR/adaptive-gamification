import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { del, get, patch, post } from '../api.ts';
import { GameElement } from '../GameElement.tsx';
import type { DeckDetail, GroupSummary, Suggestion } from '../types.ts';

export function DeckPage({ deckId }: { deckId: number }) {
  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [editFront, setEditFront] = useState('');
  const [editBack, setEditBack] = useState('');
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [groupId, setGroupId] = useState('');
  const [pending, setPending] = useState<Suggestion[]>([]);
  const [suggesting, setSuggesting] = useState<number | null>(null);
  const [sFront, setSFront] = useState('');
  const [sBack, setSBack] = useState('');
  const [sNote, setSNote] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await get<DeckDetail>(`/api/decks/${deckId}`);
      setDeck(d);
      if (d.mine) {
        setGroups(await get<GroupSummary[]>('/api/groups'));
        setPending(await get<Suggestion[]>(`/api/decks/${deckId}/suggestions`));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'erro');
    }
  }, [deckId]);
  useEffect(() => {
    void load();
  }, [load]);

  const wrap = async (fn: () => Promise<unknown>, ok = '') => {
    setError('');
    setMsg('');
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'erro');
    }
  };

  if (error && !deck) return <p className="error">{error}</p>;
  if (!deck) return <p className="muted">Carregando…</p>;

  const addCard = (e: FormEvent) => {
    e.preventDefault();
    void wrap(async () => {
      await post(`/api/decks/${deckId}/cards`, { front, back });
      setFront('');
      setBack('');
    });
  };

  const sendSuggestion = (cardId: number) =>
    wrap(async () => {
      await post(`/api/cards/${cardId}/suggestions`, { front: sFront, back: sBack, note: sNote || undefined });
      setSuggesting(null);
    }, 'Sugestão enviada. Obrigada por ajudar a melhorar o baralho!');

  const cardsList = (
    <div className="cardlist">
      <h2>Cartões</h2>
      {deck.cards.length === 0 && <p className="muted">Este baralho ainda não tem cartões.</p>}
      {deck.cards.map((c) => (
        <div key={c.id} className="item">
          {editing === c.id ? (
            <div className="stack">
              <textarea aria-label="Frente" rows={2} value={editFront} onChange={(e) => setEditFront(e.target.value)} />
              <textarea aria-label="Verso" rows={2} value={editBack} onChange={(e) => setEditBack(e.target.value)} />
              <div className="row">
                <button className="btn primary" onClick={() => void wrap(async () => { await patch(`/api/cards/${c.id}`, { front: editFront, back: editBack }); setEditing(null); })}>Salvar</button>
                <button className="btn" onClick={() => setEditing(null)}>Cancelar</button>
              </div>
            </div>
          ) : suggesting === c.id ? (
            <div className="stack">
              <p className="small muted">Altere o que estiver errado. A pessoa que cuida do baralho decide se aceita.</p>
              <textarea aria-label="Frente sugerida" rows={2} value={sFront} onChange={(e) => setSFront(e.target.value)} />
              <textarea aria-label="Verso sugerido" rows={2} value={sBack} onChange={(e) => setSBack(e.target.value)} />
              <input aria-label="Por que mudar? (opcional)" placeholder="Por que mudar? (opcional)" value={sNote} maxLength={300} onChange={(e) => setSNote(e.target.value)} />
              <div className="row">
                <button className="btn primary" onClick={() => void sendSuggestion(c.id)}>Enviar sugestão</button>
                <button className="btn" onClick={() => setSuggesting(null)}>Cancelar</button>
              </div>
            </div>
          ) : (
            <div className="row spread">
              <div><b>{c.front}</b><div className="muted">{c.back}</div></div>
              <div className="row">
                {deck.mine ? (
                  <>
                    <button className="btn" onClick={() => { setEditing(c.id); setEditFront(c.front); setEditBack(c.back); }}>Editar</button>
                    <button className="btn danger" onClick={() => void wrap(() => del(`/api/cards/${c.id}`))}>Apagar</button>
                  </>
                ) : (
                  <button className="btn" onClick={() => { setSuggesting(c.id); setSFront(c.front); setSBack(c.back); setSNote(''); }}>Sugerir edição</button>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="stack">
      <p><a href="#/biblioteca">← Biblioteca</a></p>
      <div className="card stack">
        <h1>{deck.title}</h1>
        {deck.description && <p className="muted">{deck.description}</p>}
        <p className="muted small">{deck.cards.length} cartões · {deck.mine ? (deck.isPublic ? 'público' : 'privado') : `de ${deck.ownerNickname ?? 'a equipe'}`}{deck.sourceDeckId ? ' · remix' : ''}</p>
        <div className="row">
          {deck.mine ? (
            <button className="btn danger" onClick={() => { if (window.confirm('Apagar este baralho e todos os seus cartões?')) void del(`/api/decks/${deckId}`).then(() => { window.location.hash = '/biblioteca'; }).catch((e: Error) => setError(e.message)); }}>Apagar baralho</button>
          ) : (
            <>
              {deck.inLibrary ? (
                <button className="btn" onClick={() => void wrap(() => del(`/api/decks/${deckId}/library`))}>Remover da biblioteca</button>
              ) : (
                <button className="btn primary" onClick={() => void wrap(() => post(`/api/decks/${deckId}/library`))}>Adicionar à biblioteca</button>
              )}
              <button className="btn" onClick={() => void post<{ id: number }>(`/api/decks/${deckId}/remix`).then((r) => { window.location.hash = `/baralho/${r.id}`; }).catch((e: Error) => setError(e.message))}>Remixar</button>
            </>
          )}
        </div>
        {msg && <p role="status">{msg}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>

      {deck.mine && (
        <GameElement id="share_decks">
          <h2>Compartilhar</h2>
          <p className="muted small">Ajude os colegas: publique o baralho no catálogo ou compartilhe com um dos seus grupos.</p>
          <div className="row">
            <button className="btn" onClick={() => void wrap(() => patch(`/api/decks/${deckId}`, { isPublic: !deck.isPublic }), deck.isPublic ? 'O baralho agora é privado.' : 'Baralho publicado no catálogo.')}>
              {deck.isPublic ? 'Tornar privado' : 'Publicar no catálogo'}
            </button>
          </div>
          {groups.length > 0 && (
            <div className="row" style={{ marginTop: 8 }}>
              <select aria-label="Grupo" value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ flex: 1, minWidth: 160 }}>
                <option value="">Compartilhar com um grupo…</option>
                {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <button className="btn" disabled={!groupId} onClick={() => void wrap(() => post(`/api/groups/${groupId}/decks`, { deckId }), 'Baralho compartilhado com o grupo.')}>Compartilhar</button>
            </div>
          )}
        </GameElement>
      )}

      {deck.mine && (
        <form className="card stack" onSubmit={addCard}>
          <h2>Novo cartão</h2>
          <div><label htmlFor="front">Frente</label><textarea id="front" rows={2} value={front} onChange={(e) => setFront(e.target.value)} required /></div>
          <div><label htmlFor="back">Verso</label><textarea id="back" rows={2} value={back} onChange={(e) => setBack(e.target.value)} required /></div>
          <button className="btn primary">Adicionar cartão</button>
        </form>
      )}

      {deck.mine && pending.length > 0 && (
        <GameElement id="suggest_edits">
          <h2>Sugestões de edição ({pending.length})</h2>
          <div className="cardlist">
            {pending.map((s) => (
              <div key={s.id} className="item stack">
                <div className="small"><b>{s.user.nickname}</b> sugere mudar “{s.currentFront}”:</div>
                {s.newFront !== null && s.newFront !== s.currentFront && <div className="small">Frente: <s>{s.currentFront}</s> → <b>{s.newFront}</b></div>}
                {s.newBack !== null && s.newBack !== s.currentBack && <div className="small">Verso: <s>{s.currentBack}</s> → <b>{s.newBack}</b></div>}
                {s.note && <div className="muted small">“{s.note}”</div>}
                <div className="row">
                  <button className="btn primary" onClick={() => void wrap(() => post(`/api/suggestions/${s.id}/accept`), 'Sugestão aceita.')}>Aceitar</button>
                  <button className="btn" onClick={() => void wrap(() => post(`/api/suggestions/${s.id}/reject`), 'Sugestão recusada.')}>Recusar</button>
                </div>
              </div>
            ))}
          </div>
        </GameElement>
      )}

      {deck.mine ? <div className="card">{cardsList}</div> : <GameElement id="suggest_edits">{cardsList}</GameElement>}
    </div>
  );
}
