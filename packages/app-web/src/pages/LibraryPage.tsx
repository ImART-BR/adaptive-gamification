import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { get, post } from '../api.ts';
import { GameElement } from '../GameElement.tsx';
import type { CatalogDeck, Home, PathInfo } from '../types.ts';

type Tab = 'mine' | 'explore' | 'paths';

export function LibraryPage() {
  const [tab, setTab] = useState<Tab>('mine');
  const [mastery, setMastery] = useState<Home['mastery']>([]);
  const [catalog, setCatalog] = useState<CatalogDeck[]>([]);
  const [paths, setPaths] = useState<PathInfo[]>([]);
  const [q, setQ] = useState('');
  const [title, setTitle] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const loadMine = useCallback(() => get<Home['mastery']>('/api/decks').then(setMastery), []);
  const loadCatalog = useCallback(() => get<CatalogDeck[]>(`/api/catalog${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(setCatalog), [q]);
  const loadPaths = useCallback(() => get<PathInfo[]>('/api/paths').then(setPaths), []);

  useEffect(() => {
    const run = tab === 'mine' ? loadMine : tab === 'explore' ? loadCatalog : loadPaths;
    run().catch((e: Error) => setError(e.message));
  }, [tab, loadMine, loadCatalog, loadPaths]);

  const flash = (text: string) => {
    setMsg(text);
    window.setTimeout(() => setMsg(''), 3000);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await post<{ id: number }>('/api/decks', { title });
      setTitle('');
      window.location.hash = `/baralho/${r.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'erro');
    }
  };

  const addDeck = async (id: number) => {
    try {
      await post(`/api/decks/${id}/library`);
      flash('Baralho adicionado à sua biblioteca.');
      await (tab === 'explore' ? loadCatalog() : loadPaths());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'erro');
    }
  };

  const remix = async (id: number) => {
    try {
      const r = await post<{ id: number }>(`/api/decks/${id}/remix`);
      window.location.hash = `/baralho/${r.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'erro');
    }
  };

  return (
    <div className="stack">
      <h1>Biblioteca</h1>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'mine'} onClick={() => setTab('mine')}>Meus baralhos</button>
        <button role="tab" aria-selected={tab === 'explore'} onClick={() => setTab('explore')}>Explorar</button>
        <button role="tab" aria-selected={tab === 'paths'} onClick={() => setTab('paths')}>Trilhas</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {msg && <p role="status">{msg}</p>}

      {tab === 'mine' && (
        <div className="stack">
          <GameElement id="create_remix_decks">
            <h2>Crie ou remixe baralhos</h2>
            <form onSubmit={create} className="row">
              <input aria-label="Título do novo baralho" placeholder="Título do novo baralho" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1, minWidth: 200 }} required />
              <button className="btn primary">Criar baralho</button>
            </form>
            <p className="muted small">Para remixar, abra a aba Explorar e use “Remixar” em qualquer baralho: você recebe uma cópia para editar do seu jeito.</p>
          </GameElement>
          <div className="card cardlist">
            <h2>Meus baralhos</h2>
            {mastery.length === 0 && <p className="muted">Você ainda não tem baralhos. Crie um ou explore o catálogo.</p>}
            {mastery.map((m) => (
              <div key={m.deckId} className="item row spread">
                <a href={`#/baralho/${m.deckId}`}><b>{m.title}</b></a>
                <span className="muted small">{m.cardCount} cartões · {m.masteryPct}% dominado</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'explore' && (
        <GameElement id="explore_catalog">
          <h2>Catálogo de baralhos</h2>
          <form onSubmit={(e) => { e.preventDefault(); void loadCatalog(); }} className="row">
            <input aria-label="Buscar baralhos" placeholder="Buscar por título ou assunto" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            <button className="btn">Buscar</button>
          </form>
          <div className="cardlist">
            {catalog.length === 0 && <p className="muted">Nenhum baralho encontrado.</p>}
            {catalog.map((d) => (
              <div key={d.id} className="item">
                <div className="row spread">
                  <a href={`#/baralho/${d.id}`}><b>{d.title}</b></a>
                  <span className="muted small">{d.cardCount} cartões{d.owner ? ` · por ${d.owner}` : ''}</span>
                </div>
                <p className="muted small">{d.description}</p>
                <div className="row">
                  {d.inLibrary ? <span className="small">✅ Na sua biblioteca</span> : <button className="btn" onClick={() => void addDeck(d.id)}>Adicionar</button>}
                  <button className="btn" onClick={() => void remix(d.id)}>Remixar</button>
                </div>
              </div>
            ))}
          </div>
        </GameElement>
      )}

      {tab === 'paths' && (
        <GameElement id="nonlinear_paths">
          <h2>Trilhas de estudo</h2>
          <p className="muted small">Cada trilha reúne baralhos. Não há ordem obrigatória: comece por onde quiser.</p>
          <div className="stack">
            {paths.map((p) => (
              <div key={p.key} className="card">
                <h3>{p.title}</h3>
                <p className="muted small">{p.description}</p>
                {p.decks.map((d) => (
                  <div key={d.id} className="item row spread" style={{ borderBottom: '1px solid var(--line)', padding: '8px 0' }}>
                    <span><a href={`#/baralho/${d.id}`}>{d.title}</a> <span className="muted small">· {d.cardCount} cartões · {d.masteryPct}% dominado</span></span>
                    {d.inLibrary ? <span className="small">✅ Na biblioteca</span> : <button className="btn" onClick={() => void addDeck(d.id)}>Começar por aqui</button>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </GameElement>
      )}
    </div>
  );
}
