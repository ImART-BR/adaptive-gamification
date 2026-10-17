import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { del, get, post } from '../api.ts';
import { Avatar } from '../Avatar.tsx';
import { GameElement } from '../GameElement.tsx';
import { FeedCard, GiftCard, GroupsCard, ImpactCard, PairCard, QuestionsTeaser, timeAgo } from '../components/Social.tsx';
import type { FeedItem, GiftInfo, GroupDetail, GroupSummary, Home, PairInfo, Proposals, Question, SocialSummary } from '../types.ts';

type Tab = 'visao' | 'grupos' | 'dupla' | 'duvidas' | 'ideias';

function parse(route: string): { tab: Tab; groupId: number | null } {
  const parts = route.split('/').filter(Boolean); // ['comunidade', ...]
  if (parts[1] === 'grupo' && parts[2]) return { tab: 'grupos', groupId: Number(parts[2]) };
  if (parts[1] === 'grupos') return { tab: 'grupos', groupId: null };
  if (parts[1] === 'dupla') return { tab: 'dupla', groupId: null };
  if (parts[1] === 'duvidas') return { tab: 'duvidas', groupId: null };
  if (parts[1] === 'ideias') return { tab: 'ideias', groupId: null };
  return { tab: 'visao', groupId: null };
}

export function CommunityPage({ route }: { route: string }) {
  const { tab, groupId } = parse(route);
  const link = (to: string, label: string, t: Tab) => (
    <button role="tab" aria-selected={tab === t} onClick={() => { window.location.hash = to; }}>{label}</button>
  );
  return (
    <div className="stack">
      <h1>Comunidade</h1>
      <div className="tabs" role="tablist">
        {link('/comunidade', 'Visão geral', 'visao')}
        {link('/comunidade/grupos', 'Grupos', 'grupos')}
        {link('/comunidade/dupla', 'Dupla', 'dupla')}
        {link('/comunidade/duvidas', 'Dúvidas', 'duvidas')}
        {link('/comunidade/ideias', 'Ideias', 'ideias')}
      </div>
      {tab === 'visao' && <OverviewTab />}
      {tab === 'grupos' && (groupId ? <GroupView groupId={groupId} /> : <GroupsTab />)}
      {tab === 'dupla' && <PairTab />}
      {tab === 'duvidas' && <QuestionsTab />}
      {tab === 'ideias' && <IdeasTab />}
    </div>
  );
}

// ---- overview -------------------------------------------------------------------------------------------------

function OverviewTab() {
  const [social, setSocial] = useState<SocialSummary | null>(null);
  const [feed, setFeed] = useState<FeedItem[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    get<SocialSummary>('/api/social/summary').then(setSocial).catch((e: Error) => setError(e.message));
    get<FeedItem[]>('/api/feed').then(setFeed).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <p className="error">{error}</p>;
  return (
    <div className="grid">
      <FeedCard items={feed} />
      <GroupsCard summary={social} />
      <PairCard info={social?.pair ?? null} />
      <QuestionsTeaser count={social ? social.openQuestions : null} />
      <ImpactCard impact={social?.impact ?? null} />
      <GiftCard connections={social?.connections ?? []} gifts={social?.gifts ?? null} onSent={load} />
    </div>
  );
}

// ---- groups ---------------------------------------------------------------------------------------------------

function GroupsTab() {
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => get<GroupSummary[]>('/api/groups').then(setGroups).catch((e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = (fn: () => Promise<{ id: number }>) => async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const g = await fn();
      window.location.hash = `/comunidade/grupo/${g.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'erro');
    }
  };

  return (
    <GameElement id="study_groups">
      <h2>Grupos de estudo</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {groups === null ? <p className="muted">Carregando…</p> : groups.length === 0 && <p className="muted">Você ainda não está em nenhum grupo.</p>}
      <div className="cardlist">
        {groups?.map((g) => (
          <div key={g.id} className="item">
            <div className="row spread">
              <a href={`#/comunidade/grupo/${g.id}`}><b>{g.name}</b></a>
              <span className="muted small">{g.memberCount} pessoas · código {g.code}</span>
            </div>
            <div className="bar good" style={{ marginTop: 6 }}><span style={{ width: `${Math.min(100, (100 * g.weekReviews) / Math.max(1, g.weekGoal))}%` }} /></div>
            <span className="muted small">{g.weekReviews} de {g.weekGoal} revisões na semana</span>
          </div>
        ))}
      </div>
      <div className="grid" style={{ marginTop: 12 }}>
        <form className="stack" onSubmit={act(() => post<{ id: number }>('/api/groups', { name }))}>
          <label htmlFor="gname">Criar um grupo</label>
          <div className="row"><input id="gname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do grupo" maxLength={40} required style={{ flex: 1 }} /><button className="btn primary">Criar</button></div>
        </form>
        <form className="stack" onSubmit={act(() => post<{ id: number }>('/api/groups/join', { code }))}>
          <label htmlFor="gcode">Entrar com um código</label>
          <div className="row"><input id="gcode" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="CÓDIGO" maxLength={6} required style={{ flex: 1 }} /><button className="btn">Entrar</button></div>
        </form>
      </div>
    </GameElement>
  );
}

function GroupView({ groupId }: { groupId: number }) {
  const [g, setG] = useState<GroupDetail | null>(null);
  const [myDecks, setMyDecks] = useState<Home['mastery']>([]);
  const [gifts, setGifts] = useState<GiftInfo | null>(null);
  const [deckId, setDeckId] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      setG(await get<GroupDetail>(`/api/groups/${groupId}`));
      setMyDecks(await get<Home['mastery']>('/api/decks'));
      setGifts(await get<GiftInfo>('/api/gifts'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'erro');
    }
  }, [groupId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !g) return <p className="error">{error}</p>;
  if (!g) return <p className="muted">Carregando…</p>;

  const share = async () => {
    setError('');
    try {
      await post(`/api/groups/${groupId}/decks`, { deckId: Number(deckId) });
      setMsg('Baralho compartilhado com o grupo.');
      setDeckId('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'erro');
    }
  };

  return (
    <div className="stack">
      <p><a href="#/comunidade/grupos">← Grupos</a></p>
      <GameElement id="study_groups">
        <div className="row spread">
          <h2>{g.name}</h2>
          <span>Código para convidar: <b className="code-box" style={{ fontSize: '1rem', padding: '4px 8px' }}>{g.code}</b></span>
        </div>
        <p className="small muted">Meta da semana: {g.weekReviews} de {g.weekGoal} revisões do grupo.</p>
        <div className="bar good"><span style={{ width: `${Math.min(100, (100 * g.weekReviews) / Math.max(1, g.weekGoal))}%` }} /></div>
        <div style={{ marginTop: 12 }}>
          {g.members.map((m, i) => (
            <div key={m.handle} className={`rank-row ${m.me ? 'me' : ''}`}>
              <span className="rank">{i + 1}º</span>
              <Avatar avatar={m.avatar} frame={m.frame} />
              <span className="name">{m.nickname}{m.me ? ' (você)' : ''}</span>
              <span className="muted small">{m.weekReviews} rev.</span>
              <b>{m.weekPoints}</b>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn danger" onClick={() => { if (window.confirm('Sair deste grupo?')) void del(`/api/groups/${groupId}/members/me`).then(() => { window.location.hash = '/comunidade/grupos'; }); }}>Sair do grupo</button>
        </div>
      </GameElement>

      <GiftCard connections={g.members.filter((m) => !m.me)} gifts={gifts} onSent={() => void load()} />

      <GameElement id="share_decks">
        <h2>Baralhos do grupo</h2>
        {g.decks.length === 0 && <p className="muted">Ninguém compartilhou um baralho ainda.</p>}
        <div className="cardlist">
          {g.decks.map((d) => (
            <div key={d.id} className="item row spread">
              <span><a href={`#/baralho/${d.id}`}>{d.title}</a> <span className="muted small">· {d.cardCount} cartões{d.sharedBy ? ` · por ${d.sharedBy}` : ''}</span></span>
              {d.inLibrary ? <span className="small">✅ Na biblioteca</span> : <button className="btn" onClick={() => void post(`/api/decks/${d.id}/library`).then(load).catch((e: Error) => setError(e.message))}>Adicionar</button>}
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <select aria-label="Baralho para compartilhar" value={deckId} onChange={(e) => setDeckId(e.target.value)} style={{ flex: 1, minWidth: 180 }}>
            <option value="">Escolha um baralho seu…</option>
            {myDecks.map((d) => <option key={d.deckId} value={d.deckId}>{d.title}</option>)}
          </select>
          <button className="btn primary" disabled={!deckId} onClick={() => void share()}>Compartilhar com o grupo</button>
        </div>
        {msg && <p role="status">{msg}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </GameElement>
    </div>
  );
}

// ---- pair ------------------------------------------------------------------------------------------------------

function PairTab() {
  const [info, setInfo] = useState<PairInfo | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => get<PairInfo>('/api/pair').then(setInfo).catch((e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'erro');
    }
  };

  return (
    <div className="stack">
      <PairCard info={info} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="card stack">
        {info?.pair ? (
          <button className="btn danger" onClick={() => { if (window.confirm('Encerrar a dupla de estudo?')) void run(() => del('/api/pair')); }}>Encerrar dupla</button>
        ) : (
          <>
            <h2>Formar uma dupla</h2>
            <p className="muted small">Uma pessoa gera um código e passa para a outra. O código vale por 24 horas.</p>
            <div className="row">
              <button className="btn primary" onClick={() => void run(() => post('/api/pair/invite'))}>Gerar código de convite</button>
              {info?.pendingInvite && <span>Seu código: <b className="code-box" style={{ fontSize: '1rem', padding: '4px 8px' }}>{info.pendingInvite}</b></span>}
            </div>
            <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => post('/api/pair/accept', { code })); }}>
              <input aria-label="Código recebido" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Código que você recebeu" maxLength={6} style={{ flex: 1, minWidth: 180 }} required />
              <button className="btn">Aceitar convite</button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// ---- questions --------------------------------------------------------------------------------------------------

function QuestionsTab() {
  const [open, setOpen] = useState<Question[] | null>(null);
  const [mine, setMine] = useState<Question[] | null>(null);
  const [decks, setDecks] = useState<Home['mastery']>([]);
  const [deckId, setDeckId] = useState('');
  const [text, setText] = useState('');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      setOpen(await get<Question[]>('/api/questions?scope=open'));
      setMine(await get<Question[]>('/api/questions?scope=mine'));
      setDecks(await get<Home['mastery']>('/api/decks'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'erro');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError('');
    setMsg('');
    try {
      await fn();
      setMsg(ok);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'erro');
    }
  };

  const ask = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await post('/api/questions', { deckId: Number(deckId), text });
      setText('');
    }, 'Pergunta publicada.');
  };

  return (
    <GameElement id="answer_peers">
      <h2>Dúvidas da comunidade</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {msg && <p role="status">{msg}</p>}

      <h3>Perguntas em aberto</h3>
      {open === null ? <p className="muted">Carregando…</p> : open.length === 0 && <p className="muted">Nenhuma dúvida em aberto agora.</p>}
      <div className="cardlist">
        {open?.map((q) => (
          <div key={q.id} className="item stack">
            <div><Avatar avatar={q.user.avatar} frame={q.user.frame} /> <b>{q.user.nickname}</b> <span className="muted small">sobre {q.deckTitle}{q.cardFront ? ` · “${q.cardFront}”` : ''} · {timeAgo(q.at)}</span></div>
            <p style={{ margin: 0 }}>{q.text}</p>
            {q.answers.map((a) => <p key={a.id} className="small muted" style={{ margin: 0 }}>↳ {a.user.nickname}: {a.text}</p>)}
            <div className="row">
              <input aria-label="Sua resposta" placeholder="Escreva uma resposta que ajude" value={answers[q.id] ?? ''} maxLength={500} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} style={{ flex: 1, minWidth: 180 }} />
              <button className="btn" disabled={!(answers[q.id] ?? '').trim()} onClick={() => void run(async () => { await post(`/api/questions/${q.id}/answers`, { text: answers[q.id] }); setAnswers({ ...answers, [q.id]: '' }); }, 'Resposta enviada.')}>Responder</button>
              <button className="btn" onClick={() => void run(() => post('/api/reports', { kind: 'question', id: q.id }), 'Obrigada: a pergunta foi sinalizada.')}>Sinalizar</button>
            </div>
          </div>
        ))}
      </div>

      <h3 style={{ marginTop: 16 }}>Fazer uma pergunta</h3>
      <form className="stack" onSubmit={ask}>
        <select aria-label="Baralho da pergunta" value={deckId} onChange={(e) => setDeckId(e.target.value)} required>
          <option value="">Sobre qual baralho?</option>
          {decks.map((d) => <option key={d.deckId} value={d.deckId}>{d.title}</option>)}
        </select>
        <textarea aria-label="Sua pergunta" rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder="Qual é a sua dúvida?" required />
        <button className="btn primary">Perguntar</button>
      </form>

      <h3 style={{ marginTop: 16 }}>Minhas perguntas</h3>
      {mine?.length === 0 && <p className="muted">Você ainda não perguntou nada.</p>}
      <div className="cardlist">
        {mine?.map((q) => (
          <div key={q.id} className="item stack">
            <div><b>{q.text}</b> <span className="muted small">· {q.deckTitle}</span></div>
            {q.answers.length === 0 && <p className="muted small" style={{ margin: 0 }}>Ainda sem respostas.</p>}
            {q.answers.map((a) => (
              <div key={a.id} className="row spread small">
                <span>{a.helpful ? '✅ ' : ''}<b>{a.user.nickname}:</b> {a.text}</span>
                {!q.answered && <button className="btn" onClick={() => void run(() => post(`/api/answers/${a.id}/helpful`), 'Marcada como útil. Obrigada por agradecer!')}>Ajudou</button>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </GameElement>
  );
}

// ---- ideas ----------------------------------------------------------------------------------------------------------

function IdeasTab() {
  const [data, setData] = useState<Proposals | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => get<Proposals>('/api/proposals').then(setData).catch((e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'erro');
    }
  };

  return (
    <GameElement id="vote_features">
      <h2>Ideias para o app</h2>
      <p className="muted small">Vote nas melhorias que você quer ver ou sugira a sua. Você tem {data?.maxVotes ?? 3} votos; toque de novo para retirar um. As ideias mais votadas são lidas pela equipe do estudo.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {data && <p className="small">Votos restantes: <b>{data.votesLeft}</b></p>}
      <div className="cardlist">
        {data?.proposals.map((p) => (
          <div key={p.id} className="item row spread">
            <div><b>{p.title}</b>{p.mine && <span className="muted small"> (sua ideia)</span>}<div className="muted small">{p.description}</div></div>
            <button className={`btn ${p.voted ? 'primary' : ''}`} aria-pressed={p.voted} onClick={() => void run(() => post(`/api/proposals/${p.id}/vote`))}>👍 {p.votes}</button>
          </div>
        ))}
      </div>
      <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); void run(async () => { await post('/api/proposals', { title }); setTitle(''); }); }}>
        <input aria-label="Sua ideia" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Sugira uma melhoria" style={{ flex: 1, minWidth: 200 }} required />
        <button className="btn">Sugerir</button>
      </form>
    </GameElement>
  );
}
