import { useCallback, useEffect, useState } from 'react';
import { ApiError, get, post } from './api.ts';
import { AuthPage } from './pages/AuthPage.tsx';
import { CommunityPage } from './pages/CommunityPage.tsx';
import { DeckPage } from './pages/DeckPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { LibraryPage } from './pages/LibraryPage.tsx';
import { ProfilePage } from './pages/ProfilePage.tsx';
import { StudyPage } from './pages/StudyPage.tsx';
import { Avatar } from './Avatar.tsx';
import { WeightsContext } from './GameElement.tsx';

export interface Me {
  nickname: string;
  avatar: string;
  theme: string;
  frame: string;
  /** What the interface applies today to each game element. */
  weights: Record<string, number>;
}

function useHash(): string {
  const [h, setH] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setH(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return h;
}

export function App() {
  const route = useHash();
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await get<Me>('/api/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else throw e;
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  // The weights are decided once a day, on the first visit. If the tab stays open past midnight, pick up the new day's.
  useEffect(() => {
    const on = () => {
      if (document.visibilityState === 'visible') void refreshMe();
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [refreshMe]);

  useEffect(() => {
    document.documentElement.dataset.theme = me?.theme ?? 'padrao';
  }, [me?.theme]);

  if (me === undefined) return <div className="shell"><p className="muted">Carregando…</p></div>;
  if (me === null) return <AuthPage onDone={refreshMe} />;

  const logout = async () => {
    await post('/api/auth/logout');
    window.location.hash = '/';
    setMe(null);
  };

  const link = (to: string, label: string) => (
    <a href={`#${to}`} aria-current={route === to || (to !== '/' && route.startsWith(to)) ? 'page' : undefined}>{label}</a>
  );

  let page;
  if (route === '/estudar') page = <StudyPage />;
  else if (route.startsWith('/biblioteca')) page = <LibraryPage />;
  else if (route.startsWith('/comunidade')) page = <CommunityPage route={route} />;
  else if (route.startsWith('/baralho/')) page = <DeckPage deckId={Number(route.split('/')[2])} />;
  else if (route === '/perfil') page = <ProfilePage me={me} onChange={refreshMe} onLogout={logout} />;
  else page = <HomePage />;

  return (
    <WeightsContext.Provider value={me.weights}>
    <div className="shell">
      <header className="topbar">
        <strong>📚 Estudo com cartões</strong>
        <nav aria-label="principal">
          {link('/', 'Início')}
          {link('/estudar', 'Estudar')}
          {link('/biblioteca', 'Biblioteca')}
          {link('/comunidade', 'Comunidade')}
        </nav>
        <a className="me" href="#/perfil" aria-label="Perfil">
          <Avatar avatar={me.avatar} frame={me.frame} />
          <span>{me.nickname}</span>
        </a>
      </header>
      <main>{page}</main>
    </div>
    </WeightsContext.Provider>
  );
}
