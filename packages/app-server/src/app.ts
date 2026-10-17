import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { generateCode, hashPassword, newToken, revokeToken, userIdForToken, verifyPassword } from './auth.ts';
import { randomHandle } from './ids.ts';
import { one, run } from './db.ts';
import type { Db } from './db.ts';
import * as community from './community.ts';
import { recordClientEvents } from './events.ts';
import { assignGroup, createExperiment, ensureDay } from './experiment.ts';
import type { ExperimentOptions } from './experiment.ts';
import * as lib from './library.ts';
import { HttpError } from './library.ts';
import * as social from './social.ts';
import * as study from './study.ts';

export const CONSENT_VERSION = 'rascunho-0';
const COOKIE = 'ga_token';

interface Vars {
  userId: number;
  sessionId: string;
  now: number;
  weights: Record<string, number>;
}

export interface AppOptions {
  /** Injectable clock (ms), for tests. */
  clock?: () => number;
  secureCookies?: boolean;
  /** The A/B experiment. Off by default: nobody is assigned a group and the core never runs. */
  experiment?: ExperimentOptions;
  /** Injectable randomness for group assignment, for tests. */
  random?: () => number;
}

export function createApp(db: Db, options: AppOptions = {}) {
  const clock = options.clock ?? (() => Date.now());
  const experiment = createExperiment(options.experiment ?? { enabled: false });
  const app = new Hono<{ Variables: Vars }>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    console.error('[app] erro inesperado:', err);
    return c.json({ error: 'erro interno' }, 500);
  });

  const body = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const intParam = (c: Context, name: string): number => {
    const n = Number(c.req.param(name));
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} inválido`);
    return n;
  };

  // ---- auth (public) ----------------------------------------------------------------------------------------
  app.post('/api/auth/register', async (c) => {
    const b = await body(c);
    if (b.consent !== true) throw new HttpError(400, 'é preciso aceitar o termo de consentimento');
    const now = clock();
    let password: string | null = null;
    if (b.password !== undefined && b.password !== '') {
      if (typeof b.password !== 'string' || b.password.length < 6 || b.password.length > 200) throw new HttpError(400, 'a senha precisa ter de 6 a 200 caracteres');
      password = b.password;
    }
    let code = generateCode();
    for (let i = 0; i < 5 && one(db, 'SELECT 1 AS x FROM users WHERE code = ?', code); i++) code = generateCode();
    const nickname = `Estudante ${code.slice(-4)}`;
    let handle = randomHandle();
    while (one(db, 'SELECT 1 AS x FROM users WHERE handle = ?', handle)) handle = randomHandle();
    const grp = experiment.enabled ? assignGroup(db, options.random) : null;
    const { id } = run(db, 'INSERT INTO users (handle, code, pass_hash, nickname, created_at, consented_at, consent_version, grp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', handle, code, password ? hashPassword(password) : null, nickname, now, now, CONSENT_VERSION, grp);
    const token = newToken(db, id, now);
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', secure: options.secureCookies ?? false, maxAge: 60 * 60 * 24 * 90 });
    return c.json({ code, nickname });
  });

  app.post('/api/auth/login', async (c) => {
    const b = await body(c);
    const code = typeof b.code === 'string' ? b.code.trim() : '';
    const u = one<{ id: number; pass_hash: string | null }>(db, 'SELECT id, pass_hash FROM users WHERE code = ?', code);
    // Same message for unknown code and wrong password.
    if (!u || (u.pass_hash && (typeof b.password !== 'string' || !verifyPassword(b.password, u.pass_hash)))) throw new HttpError(401, 'código ou senha incorretos');
    const token = newToken(db, u.id, clock());
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', secure: options.secureCookies ?? false, maxAge: 60 * 60 * 24 * 90 });
    return c.json({ ok: true });
  });

  app.post('/api/auth/logout', (c) => {
    const t = getCookie(c, COOKIE);
    if (t) revokeToken(db, t);
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ---- everything below needs a logged-in user ---------------------------------------------------------------
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) return next();
    const t = getCookie(c, COOKIE);
    const userId = t ? userIdForToken(db, t) : undefined;
    if (!userId) throw new HttpError(401, 'faça login');
    const now = clock();
    c.set('userId', userId);
    c.set('now', now);
    c.set('sessionId', study.touchSession(db, userId, now));
    c.set('weights', ensureDay(db, experiment, userId, now));
    await next();
  });

  const U = (c: Context) => c.get('userId' as never) as number;
  const NOW = (c: Context) => c.get('now' as never) as number;
  const SID = (c: Context) => c.get('sessionId' as never) as string;
  const WEIGHTS = (c: Context) => c.get('weights' as never) as Record<string, number>;

  // `weights` is what the interface applies today. The user's group is never sent to the client.
  app.get('/api/me', (c) => {
    const u = study.userRow(db, U(c))!;
    return c.json({ nickname: u.nickname, avatar: u.avatar, theme: u.theme, frame: u.frame, sessionId: SID(c), weights: WEIGHTS(c) });
  });
  app.patch('/api/me', async (c) => c.json(study.updateProfile(db, U(c), await body(c))));
  app.get('/api/home', (c) => c.json(study.home(db, U(c), NOW(c), SID(c))));

  // ---- library -----------------------------------------------------------------------------------------------
  app.get('/api/decks', (c) => c.json(study.masteryByDeck(db, U(c))));
  app.post('/api/decks', async (c) => {
    const d = lib.createDeck(db, U(c), NOW(c), (await body(c)) as { title: unknown; description?: unknown; isPublic?: unknown });
    study.refreshProgress(db, U(c), NOW(c));
    return c.json({ id: d.id }, 201);
  });
  app.get('/api/decks/:id', (c) => c.json(lib.deckWithCards(db, U(c), intParam(c, 'id'))));
  app.patch('/api/decks/:id', async (c) => {
    const id = intParam(c, 'id');
    const before = lib.getDeck(db, id);
    const d = lib.updateDeck(db, U(c), id, await body(c));
    if (before && before.is_public === 0 && d.is_public === 1) social.onDeckPublished(db, U(c), NOW(c), id);
    return c.json({ id: d.id, progress: study.refreshProgress(db, U(c), NOW(c)) });
  });
  app.delete('/api/decks/:id', (c) => {
    lib.deleteDeck(db, U(c), intParam(c, 'id'));
    return c.json({ ok: true });
  });
  app.post('/api/decks/:id/cards', async (c) => c.json(lib.addCard(db, U(c), NOW(c), intParam(c, 'id'), (await body(c)) as { front: unknown; back: unknown }), 201));
  app.patch('/api/cards/:id', async (c) => c.json(lib.updateCard(db, U(c), intParam(c, 'id'), await body(c))));
  app.delete('/api/cards/:id', (c) => {
    lib.deleteCard(db, U(c), intParam(c, 'id'));
    return c.json({ ok: true });
  });
  app.post('/api/decks/:id/library', (c) => {
    const id = intParam(c, 'id');
    lib.addToLibrary(db, U(c), NOW(c), id);
    social.onDeckAdopted(db, U(c), NOW(c), id);
    return c.json({ progress: study.refreshProgress(db, U(c), NOW(c)) });
  });
  app.delete('/api/decks/:id/library', (c) => {
    lib.removeFromLibrary(db, U(c), intParam(c, 'id'));
    return c.json({ ok: true });
  });
  app.post('/api/decks/:id/remix', (c) => {
    const srcId = intParam(c, 'id');
    const d = lib.remixDeck(db, U(c), NOW(c), srcId);
    social.onDeckAdopted(db, U(c), NOW(c), srcId);
    return c.json({ id: d.id, progress: study.refreshProgress(db, U(c), NOW(c)) }, 201);
  });
  app.get('/api/catalog', (c) => c.json(lib.catalog(db, U(c), c.req.query('q') ?? undefined)));
  app.get('/api/paths', (c) => c.json(lib.paths(db, U(c))));

  // ---- study -----------------------------------------------------------------------------------------------
  app.get('/api/review/decks', (c) => c.json(study.queueDecks(db, U(c), NOW(c), SID(c))));
  app.get('/api/review/queue', (c) => {
    // ?decks=1,2,3 limits the cards to the chosen decks (without it, all decks of the day's queue)
    const raw = c.req.query('decks');
    const ids = raw ? raw.split(',').map(Number) : undefined;
    if (ids && ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new HttpError(400, 'decks inválido');
    return c.json(study.nextCards(db, U(c), NOW(c), SID(c), 20, ids));
  });
  app.post('/api/review', async (c) => {
    const b = await body(c);
    return c.json(study.answerReview(db, U(c), NOW(c), SID(c), b.cardId, b.grade));
  });

  // ---- social: groups, pair, feed, gifts, impact -------------------------------------------------------------------
  const progress = (c: Context) => study.refreshProgress(db, U(c), NOW(c));

  app.get('/api/social/summary', (c) => {
    const u = U(c);
    const now = NOW(c);
    return c.json({
      groups: social.myGroups(db, u, now),
      pair: social.getPair(db, u, now),
      impact: social.impact(db, u),
      gifts: social.giftInfo(db, u, now),
      connections: social.connections(db, u),
      openQuestions: community.listQuestions(db, u, 'open').length,
    });
  });
  app.get('/api/groups', (c) => c.json(social.myGroups(db, U(c), NOW(c))));
  app.post('/api/groups', async (c) => {
    const g = social.createGroup(db, U(c), NOW(c), (await body(c)).name);
    return c.json({ ...g, progress: progress(c) }, 201);
  });
  app.post('/api/groups/join', async (c) => {
    const g = social.joinGroup(db, U(c), NOW(c), (await body(c)).code);
    return c.json({ ...g, progress: progress(c) });
  });
  app.get('/api/groups/:id', (c) => c.json(social.groupDetail(db, U(c), NOW(c), intParam(c, 'id'))));
  app.delete('/api/groups/:id/members/me', (c) => {
    social.leaveGroup(db, U(c), intParam(c, 'id'));
    return c.json({ ok: true });
  });
  app.post('/api/groups/:id/decks', async (c) => {
    social.shareDeckToGroup(db, U(c), NOW(c), intParam(c, 'id'), Number((await body(c)).deckId));
    return c.json({ progress: progress(c) });
  });

  app.get('/api/pair', (c) => c.json(social.getPair(db, U(c), NOW(c))));
  app.post('/api/pair/invite', (c) => c.json(social.createPairInvite(db, U(c), NOW(c))));
  app.post('/api/pair/accept', async (c) => {
    social.acceptPairInvite(db, U(c), NOW(c), (await body(c)).code);
    return c.json({ progress: progress(c) });
  });
  app.delete('/api/pair', (c) => {
    social.endPair(db, U(c), NOW(c));
    return c.json({ ok: true });
  });

  app.get('/api/feed', (c) => c.json(social.feed(db, U(c), NOW(c))));
  app.get('/api/connections', (c) => c.json(social.connections(db, U(c))));
  app.get('/api/gifts', (c) => c.json(social.giftInfo(db, U(c), NOW(c))));
  app.post('/api/gifts', async (c) => {
    const info = social.sendGift(db, U(c), NOW(c), (await body(c)).handle);
    return c.json({ ...info, progress: progress(c) });
  });
  app.get('/api/impact', (c) => c.json(social.impact(db, U(c))));

  // ---- community: questions, ideas, edit suggestions --------------------------------------------------------------
  app.get('/api/questions', (c) => {
    const deckId = c.req.query('deckId');
    return c.json(community.listQuestions(db, U(c), c.req.query('scope') ?? 'open', deckId ? Number(deckId) : undefined));
  });
  app.post('/api/questions', async (c) => {
    const q = community.askQuestion(db, U(c), NOW(c), await body(c));
    return c.json({ ...q, progress: progress(c) }, 201);
  });
  app.get('/api/questions/:id', (c) => c.json(community.getQuestion(db, U(c), intParam(c, 'id'))));
  app.post('/api/questions/:id/answers', async (c) => c.json(community.answerQuestion(db, U(c), NOW(c), intParam(c, 'id'), (await body(c)).text), 201));
  app.post('/api/answers/:id/helpful', (c) => {
    const r = community.markHelpful(db, U(c), NOW(c), intParam(c, 'id'));
    study.refreshProgress(db, r.answererId, NOW(c)); // the answerer may unlock "Ajudante" or a level
    return c.json({ answererPoints: r.answererPoints });
  });
  app.post('/api/reports', async (c) => {
    const b = await body(c);
    return c.json(community.report(db, U(c), NOW(c), b.kind, b.id));
  });

  app.get('/api/proposals', (c) => c.json(community.listProposals(db, U(c))));
  app.post('/api/proposals', async (c) => c.json(community.addProposal(db, U(c), NOW(c), await body(c)), 201));
  app.post('/api/proposals/:id/vote', (c) => {
    const r = community.toggleVote(db, U(c), NOW(c), intParam(c, 'id'));
    return c.json({ ...r, progress: progress(c) });
  });

  app.post('/api/cards/:id/suggestions', async (c) => c.json(community.suggestEdit(db, U(c), NOW(c), intParam(c, 'id'), await body(c)), 201));
  app.get('/api/decks/:id/suggestions', (c) => c.json(community.pendingForDeck(db, U(c), intParam(c, 'id'))));
  app.get('/api/suggestions/mine', (c) => c.json(community.mySuggestions(db, U(c))));
  app.post('/api/suggestions/:id/accept', (c) => {
    const { suggesterId } = community.decideSuggestion(db, U(c), NOW(c), intParam(c, 'id'), true);
    study.refreshProgress(db, suggesterId, NOW(c)); // the suggester may unlock "Editor"
    return c.json({ ok: true });
  });
  app.post('/api/suggestions/:id/reject', (c) => {
    community.decideSuggestion(db, U(c), NOW(c), intParam(c, 'id'), false);
    return c.json({ ok: true });
  });

  // ---- research events -----------------------------------------------------------------------------------------
  app.post('/api/events', async (c) => {
    const b = await body(c);
    return c.json({ stored: recordClientEvents(db, U(c), SID(c), NOW(c), b.events, WEIGHTS(c)) });
  });

  return app;
}
