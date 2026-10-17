import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one } from '../src/db.ts';
import { exportEventsCsv } from '../src/events.ts';
import { seedContent } from '../src/seed.ts';
import { newCardState, schedule } from '../src/srs.ts';
import { dayNumber, weekStartDay } from '../src/time.ts';
import { levelFromPoints } from '../src/gamification.ts';
import { DAY, MIN, T0, setup } from './helpers.ts';
// ---- auth ------------------------------------------------------------------------------------------------

test('register requires consent, then /api/me works; logout closes it', async () => {
  const { client } = setup();
  const c = client();
  assert.equal((await c.post('/api/auth/register', {})).status, 400);
  assert.equal((await c.get('/api/me')).status, 401);
  const r = await c.post('/api/auth/register', { consent: true });
  assert.equal(r.status, 200);
  assert.match(r.json.code, /^[a-z-]+-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal((await c.get('/api/me')).status, 200);
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/me')).status, 401);
});

test('login by code; with password the wrong one is rejected', async () => {
  const { client, newUser } = setup();
  const { code } = await newUser('segredo123');
  const c = client();
  assert.equal((await c.post('/api/auth/login', { code, password: 'errada' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { code })).status, 401);
  assert.equal((await c.post('/api/auth/login', { code: 'nao-existe-XXXX-YYYY', password: 'x' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { code, password: 'segredo123' })).status, 200);
  assert.equal((await c.get('/api/me')).status, 200);
  const { code: c2 } = await newUser();
  const d = client();
  assert.equal((await d.post('/api/auth/login', { code: c2 })).status, 200);
});

test('short password is rejected; no password stored for passwordless users', async () => {
  const { client, db, newUser } = setup();
  assert.equal((await client().post('/api/auth/register', { consent: true, password: '123' })).status, 400);
  await newUser();
  assert.equal(one<{ pass_hash: string | null }>(db, 'SELECT pass_hash FROM users LIMIT 1')?.pass_hash, null);
});

test('data endpoints require login', async () => {
  const { client } = setup();
  const c = client();
  for (const p of ['/api/home', '/api/decks', '/api/catalog', '/api/review/queue', '/api/paths']) assert.equal((await c.get(p)).status, 401, p);
  assert.equal((await c.post('/api/events', { events: [] })).status, 401);
});

// ---- spaced repetition -------------------------------------------------------------------------------------

test('srs: intervals grow with good answers and reset with again', () => {
  const day = 20000;
  let s = newCardState(day);
  s = schedule(s, 2, day);
  assert.equal(s.interval, 1);
  s = schedule(s, 2, day + 1);
  assert.equal(s.interval, 3);
  s = schedule(s, 2, day + 4);
  assert.ok(s.interval >= 7, `interval ${s.interval}`);
  const grown = s.interval;
  const lapsed = schedule(s, 0, day + 20);
  assert.equal(lapsed.interval, 0);
  assert.equal(lapsed.due, day + 20);
  assert.equal(lapsed.lapses, 1);
  assert.ok(lapsed.ease < s.ease);
  const easy = schedule(s, 3, day + 20);
  assert.ok(easy.interval > schedule(s, 2, day + 20).interval);
  assert.ok(grown > 3);
});

test('time helpers: day numbers use UTC-3 and weeks start on Monday', () => {
  assert.equal(dayNumber(Date.UTC(2026, 9, 19, 2, 59)), dayNumber(Date.UTC(2026, 9, 18, 12, 0)));
  assert.notEqual(dayNumber(Date.UTC(2026, 9, 19, 3, 1)), dayNumber(Date.UTC(2026, 9, 18, 12, 0)));
  const monday = dayNumber(T0);
  assert.equal(weekStartDay(monday), monday);
  assert.equal(weekStartDay(monday + 6), monday);
  assert.equal(weekStartDay(monday + 7), monday + 7);
});

// ---- daily queue, outcome, points ----------------------------------------------------------------------------

test('daily queue: up to 10 new cards; good answers mark done and log the outcome for the first session', async () => {
  const { c } = await (async () => {
    const s = setup();
    const u = await s.newUser();
    await s.withDeckInLibrary(u.c);
    return { c: u.c, ...s };
  })();
  const q = await c.get('/api/review/queue');
  assert.equal(q.json.total, 10);
  assert.equal(q.json.done, 0);
  assert.equal(q.json.cards.length, 10);
  assert.ok(q.json.cards.every((x: any) => x.isNew));
  const r = await c.post('/api/review', { cardId: q.json.cards[0].id, grade: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.json.pointsGained, 10);
  assert.equal(r.json.queueDone, 1);
});

test('outcome events: value = done/total, credited to the first session of the day; "again" does not count', async () => {
  const s = setup();
  const { c } = await s.newUser();
  await s.withDeckInLibrary(c);
  const q = await c.get('/api/review/queue');
  const first = (await c.get('/api/me')).json.sessionId as string;

  const a = await c.post('/api/review', { cardId: q.json.cards[0].id, grade: 0 });
  assert.equal(a.json.queueDone, 0);
  assert.equal(a.json.pointsGained, 0);
  assert.equal(all(s.db, "SELECT * FROM events WHERE type = 'outcome'").length, 0);

  await c.post('/api/review', { cardId: q.json.cards[1].id, grade: 2 });
  s.clock.advance(45 * MIN); // new session, same day
  const q2 = await c.get('/api/review/queue');
  assert.equal(q2.json.done, 1);
  await c.post('/api/review', { cardId: q2.json.cards.find((x: any) => x.id !== q.json.cards[0].id && x.id !== q.json.cards[1].id).id, grade: 3 });

  const outcomes = all<{ session_id: string; value: number; kind: string }>(s.db, "SELECT session_id, value, kind FROM events WHERE type = 'outcome' ORDER BY id");
  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes.map((o) => o.value), [0.1, 0.2]);
  assert.ok(outcomes.every((o) => o.session_id === first && o.kind === 'target'));
  const second = (await c.get('/api/me')).json.sessionId as string;
  assert.notEqual(second, first);
});

test('a card answered "again" stays in the queue and finishing it later counts once', async () => {
  const s = setup();
  const { c } = await s.newUser();
  await s.withDeckInLibrary(c);
  const q = await c.get('/api/review/queue');
  const id = q.json.cards[0].id;
  await c.post('/api/review', { cardId: id, grade: 0 });
  const q2 = await c.get('/api/review/queue');
  assert.ok(q2.json.cards.some((x: any) => x.id === id));
  assert.equal(q2.json.cards.at(-1).id, id, 'the card answered "again" goes to the end');
  const r = await c.post('/api/review', { cardId: id, grade: 2 });
  assert.equal(r.json.queueDone, 1);
});

test('cannot review a card that is not in today\'s queue; invalid grade rejected', async () => {
  const s = setup();
  const { c } = await s.newUser();
  await s.withDeckInLibrary(c);
  const q = await c.get('/api/review/queue');
  assert.equal((await c.post('/api/review', { cardId: 999999, grade: 2 })).status, 400);
  assert.equal((await c.post('/api/review', { cardId: q.json.cards[0].id, grade: 7 })).status, 400);
  assert.equal((await c.post('/api/review', { grade: 2 })).status, 400);
});

test('next day: a card answered "good" is due again after its interval, not before', async () => {
  const s = setup();
  const { c } = await s.newUser();
  await s.withDeckInLibrary(c);
  const q = await c.get('/api/review/queue');
  const id = q.json.cards[0].id;
  for (const card of q.json.cards) await c.post('/api/review', { cardId: card.id, grade: 2 });
  s.clock.advance(DAY);
  const q2 = await c.get('/api/review/queue');
  assert.ok(q2.json.cards.some((x: any) => x.id === id && !x.isNew), 'interval 1 day: due tomorrow');
  assert.equal(q2.json.cards.filter((x: any) => !x.isNew).length, 10);
  assert.equal(q2.json.cards.filter((x: any) => x.isNew).length, 5, 'only 5 cards of the deck were still new');
});

// ---- choosing decks to study ----------------------------------------------------------------------------------------

async function twoDecks(s: ReturnType<typeof setup>) {
  const { c } = await s.newUser();
  const a = await s.withDeckInLibrary(c, 'Capitais do Brasil'); // 15 cards
  const b = await s.withDeckInLibrary(c, 'Química: elementos'); // 12 cards
  return { c, a, b };
}

test('new cards are spread across the library decks, so every deck is available to study', async () => {
  const s = setup();
  const { c, a, b } = await twoDecks(s);
  const decks = (await c.get('/api/review/decks')).json;
  assert.deepEqual(decks.map((d: any) => d.deckId), [a, b], 'library order');
  assert.deepEqual(decks.map((d: any) => d.total), [5, 5]);
  assert.deepEqual(decks.map((d: any) => d.pending), [5, 5]);
  assert.deepEqual(decks.map((d: any) => d.fresh), [5, 5]);
  assert.equal(decks[0].title, 'Capitais do Brasil');
  assert.equal((await c.get('/api/review/queue')).json.total, 10, 'still 10 new cards per day in total');
});

test('queue can be limited to chosen decks; the day\'s totals do not change, only the selection', async () => {
  const s = setup();
  const { c, a, b } = await twoDecks(s);
  const all = (await c.get('/api/review/queue')).json;
  const onlyB = (await c.get(`/api/review/queue?decks=${b}`)).json;
  assert.equal(all.cards.length, 10);
  assert.equal(onlyB.cards.length, 5);
  assert.ok(onlyB.cards.every((x: any) => x.deckId === b && x.deckTitle === 'Química: elementos'));
  assert.equal(onlyB.total, 10, 'whole-day total is unchanged');
  assert.deepEqual(onlyB.selected, { total: 5, done: 0 });
  const both = (await c.get(`/api/review/queue?decks=${a},${b}`)).json;
  assert.equal(both.cards.length, 10);
  const order = both.cards.map((x: any) => x.deckId);
  assert.deepEqual(order, [a, a, a, a, a, b, b, b, b, b], 'one deck at a time, in library order');
  assert.deepEqual((await c.get('/api/review/queue?decks=99999')).json.cards, []);
  assert.equal((await c.get('/api/review/queue?decks=abc')).status, 400);
  assert.equal((await c.get('/api/review/queue?decks=1,-3')).status, 400);
});

test('studying one chosen deck counts toward the whole day: outcome = done / whole queue', async () => {
  const s = setup();
  const { c, b } = await twoDecks(s);
  const q = (await c.get(`/api/review/queue?decks=${b}`)).json;
  for (const card of q.cards) await c.post('/api/review', { cardId: card.id, grade: 2 });
  const last = all<{ value: number }>(s.db, "SELECT value FROM events WHERE type = 'outcome' ORDER BY id DESC LIMIT 1")[0]!;
  assert.equal(last.value, 0.5, '5 of the day\'s 10 cards');
  const after = (await c.get(`/api/review/queue?decks=${b}`)).json;
  assert.deepEqual(after.selected, { total: 5, done: 5 });
  assert.equal(after.cards.length, 0);
  const decks = (await c.get('/api/review/decks')).json;
  assert.deepEqual(decks.map((d: any) => d.pending), [5, 0]);
  const home = (await c.get('/api/home')).json;
  assert.deepEqual(home.today.decks.map((d: any) => d.title), ['Capitais do Brasil'], 'home lists only decks that still have cards');
  assert.equal(home.today.decks[0].pending, 5);
});

test('empty queue is rebuilt when a deck is added later the same day', async () => {
  const s = setup();
  const { c } = await s.newUser();
  assert.equal((await c.get('/api/review/queue')).json.total, 0);
  await s.withDeckInLibrary(c);
  assert.equal((await c.get('/api/review/queue')).json.total, 10);
});

// ---- gamification (fixed) --------------------------------------------------------------------------------------

test('points, levels and achievements: first review unlocks once with a bonus', async () => {
  const s = setup();
  const { c } = await s.newUser();
  await s.withDeckInLibrary(c);
  const q = await c.get('/api/review/queue');
  const r = await c.post('/api/review', { cardId: q.json.cards[0].id, grade: 2 });
  assert.deepEqual(r.json.newAchievements.map((a: any) => a.key), ['first_review']);
  // 15 (explorer bonus, granted when the deck entered the library) + 10 (review) + 10 (first_review bonus)
  assert.equal(r.json.totalPoints, 15 + 10 + 10);
  const r2 = await c.post('/api/review', { cardId: q.json.cards[1].id, grade: 2 });
  assert.deepEqual(r2.json.newAchievements, []);
  assert.equal(levelFromPoints(0), 1);
  assert.equal(levelFromPoints(40), 2);
  assert.equal(levelFromPoints(160), 3);
});

test('daily challenges pay once: 10 reviews, a run of 5 and the full queue', async () => {
  const s = setup();
  const { c } = await s.newUser();
  await s.withDeckInLibrary(c);
  const q = await c.get('/api/review/queue');
  const done: string[] = [];
  let last: any;
  for (const card of q.json.cards) {
    last = await c.post('/api/review', { cardId: card.id, grade: 2 });
    done.push(...last.json.challengesDone.map((x: any) => x.key));
  }
  assert.deepEqual(done.sort(), ['daily_10', 'daily_queue', 'daily_run_5']);
  assert.ok(last.json.newAchievements.some((a: any) => a.key === 'perfect_day'));
  const home = (await c.get('/api/home')).json;
  assert.ok(home.challenges.every((x: any) => x.claimed));
  const extra = await c.post('/api/decks', { title: 'Qualquer' });
  assert.equal(extra.status, 201);
  assert.equal(all(s.db, "SELECT * FROM challenge_claims").length, 3);
});

test('home exposes mastery, level, challenges, achievements, leaderboard and cosmetics', async () => {
  const s = setup();
  const { c } = await s.newUser();
  await s.withDeckInLibrary(c);
  const h = (await c.get('/api/home')).json;
  assert.equal(h.today.queueTotal, 10);
  assert.equal(h.level.level, 1);
  assert.equal(h.mastery.length, 1);
  assert.equal(h.mastery[0].masteryPct, 0);
  assert.equal(h.challenges.length, 3);
  assert.ok(h.achievements.length >= 10);
  assert.equal(h.cosmetics.themes.find((t: any) => t.key === 'padrao').unlocked, true);
  assert.equal(h.cosmetics.themes.find((t: any) => t.key === 'noite').unlocked, false);
});

test('leaderboard ranks the week by points and marks the current user', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  await s.withDeckInLibrary(a.c);
  await s.withDeckInLibrary(b.c);
  const qa = await a.c.get('/api/review/queue');
  const qb = await b.c.get('/api/review/queue');
  for (const card of qa.json.cards.slice(0, 5)) await a.c.post('/api/review', { cardId: card.id, grade: 3 });
  await b.c.post('/api/review', { cardId: qb.json.cards[0].id, grade: 2 });
  const lb = (await b.c.get('/api/home')).json.leaderboard;
  assert.equal(lb.participants, 2);
  assert.equal(lb.top[0].me, false);
  assert.equal(lb.me.rank, 2);
});

test('profile: avatar must be valid; locked themes are refused until the level is reached', async () => {
  const s = setup();
  const { c } = await s.newUser();
  assert.equal((await c.patch('/api/me', { avatar: '💩' })).status, 400);
  assert.equal((await c.patch('/api/me', { avatar: '🦊', nickname: 'Rapha' })).status, 200);
  assert.equal((await c.patch('/api/me', { theme: 'noite' })).status, 403);
  assert.equal((await c.patch('/api/me', { theme: 'inexistente' })).status, 400);
  assert.equal((await c.patch('/api/me', { nickname: 'x' })).status, 400);
  s.db.exec(`INSERT INTO point_events (user_id, at, day, points, reason) VALUES (1, ${T0}, ${dayNumber(T0)}, 100, 'teste')`);
  assert.equal((await c.patch('/api/me', { theme: 'noite' })).status, 200);
  assert.equal((await c.get('/api/me')).json.theme, 'noite');
});

// ---- library --------------------------------------------------------------------------------------------------

test('create deck and cards (creator achievement); other users cannot edit it', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const d = await a.c.post('/api/decks', { title: 'Meu baralho', isPublic: true });
  assert.equal(d.status, 201);
  const card = await a.c.post(`/api/decks/${d.json.id}/cards`, { front: 'P', back: 'R' });
  assert.equal(card.status, 201);
  assert.equal((await a.c.post(`/api/decks/${d.json.id}/cards`, { front: '', back: 'R' })).status, 400);
  assert.equal((await b.c.post(`/api/decks/${d.json.id}/cards`, { front: 'x', back: 'y' })).status, 404);
  assert.equal((await b.c.patch(`/api/cards/${card.json.id}`, { front: 'hack' })).status, 404);
  assert.equal((await b.c.del(`/api/decks/${d.json.id}`)).status, 404);
  assert.ok((await a.c.get('/api/home')).json.achievements.find((x: any) => x.key === 'deck_creator').unlockedAt);
  assert.equal((await a.c.patch(`/api/cards/${card.json.id}`, { back: 'R2' })).status, 200);
});

test('private decks are hidden from other users; public ones appear in the catalog', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const priv = await a.c.post('/api/decks', { title: 'Segredo' });
  const pub = await a.c.post('/api/decks', { title: 'Aberto', isPublic: true });
  assert.equal((await b.c.get(`/api/decks/${priv.json.id}`)).status, 404);
  assert.equal((await b.c.get(`/api/decks/${pub.json.id}`)).status, 200);
  const titles = (await b.c.get('/api/catalog')).json.map((x: any) => x.title);
  assert.ok(titles.includes('Aberto'));
  assert.ok(!titles.includes('Segredo'));
  assert.deepEqual((await b.c.get('/api/catalog?q=Abert')).json.map((x: any) => x.title), ['Aberto']);
});

test('explore and remix: library gets the deck; remix copies the cards and is editable', async () => {
  const s = setup();
  const { c } = await s.newUser();
  const deckId = await s.withDeckInLibrary(c, 'Química: elementos');
  const h1 = (await c.get('/api/home')).json;
  assert.ok(h1.achievements.find((x: any) => x.key === 'explorer').unlockedAt);
  const rx = await c.post(`/api/decks/${deckId}/remix`);
  assert.equal(rx.status, 201);
  const copy = (await c.get(`/api/decks/${rx.json.id}`)).json;
  assert.equal(copy.mine, true);
  assert.equal(copy.sourceDeckId, deckId);
  assert.equal(copy.cards.length, 12);
  assert.equal((await c.patch(`/api/cards/${copy.cards[0].id}`, { back: 'editado' })).status, 200);
  const orig = (await c.get(`/api/decks/${deckId}`)).json;
  assert.notEqual(orig.cards[0].back, 'editado');
  assert.ok(rx.json.progress.newAchievements.some((a: any) => a.key === 'remixer'));
});

test('removing a followed deck from the library; owner deleting a deck others follow only hides it', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const d = await a.c.post('/api/decks', { title: 'Compartilhado', isPublic: true });
  await b.c.post(`/api/decks/${d.json.id}/library`);
  assert.equal((await a.c.del(`/api/decks/${d.json.id}/library`)).status, 400, 'owner cannot "remove" own deck');
  assert.equal((await a.c.del(`/api/decks/${d.json.id}`)).status, 200);
  assert.equal((await b.c.get(`/api/decks/${d.json.id}`)).status, 200, 'follower keeps access');
  assert.ok(!(await b.c.get('/api/catalog')).json.some((x: any) => x.title === 'Compartilhado'), 'hidden from the catalog');
  assert.equal((await b.c.del(`/api/decks/${d.json.id}/library`)).status, 200);
});

test('paths list decks with library and mastery state', async () => {
  const s = setup();
  const { c } = await s.newUser();
  await s.withDeckInLibrary(c, 'Estatística básica');
  const ps = (await c.get('/api/paths')).json;
  const dados = ps.find((p: any) => p.key === 'dados');
  assert.equal(dados.decks.length, 2);
  assert.equal(dados.decks.find((d: any) => d.title === 'Estatística básica').inLibrary, true);
  assert.equal(dados.decks.find((d: any) => d.title === 'Python: o básico').inLibrary, false);
});

test('seed is idempotent', () => {
  const { db } = setup();
  seedContent(db, T0);
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM paths')?.n, 3);
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM decks')?.n, 6);
});

// ---- sessions and research events ------------------------------------------------------------------------------

test('sessions: reused within 30 minutes of inactivity, new after', async () => {
  const s = setup();
  const { c } = await s.newUser();
  const id1 = (await c.get('/api/me')).json.sessionId;
  s.clock.advance(29 * MIN);
  assert.equal((await c.get('/api/me')).json.sessionId, id1);
  s.clock.advance(29 * MIN); // still within 30 min of the last activity
  assert.equal((await c.get('/api/me')).json.sessionId, id1);
  s.clock.advance(31 * MIN);
  assert.notEqual((await c.get('/api/me')).json.sessionId, id1);
});

test('client events: exposure/interaction are stored with server-stamped session and time', async () => {
  const s = setup();
  const { c } = await s.newUser();
  const sid = (await c.get('/api/me')).json.sessionId;
  const r = await c.post('/api/events', { events: [{ type: 'exposure', elementId: 'levels', prominence: 1 }, { type: 'interaction', elementId: 'levels' }] });
  assert.equal(r.status, 200);
  assert.equal(r.json.stored, 2);
  const rows = all<{ session_id: string; at: number; type: string; element_id: string; prominence: number | null }>(s.db, 'SELECT session_id, at, type, element_id, prominence FROM events ORDER BY id');
  assert.deepEqual(rows.map((x) => x.type), ['exposure', 'interaction']);
  assert.ok(rows.every((x) => x.session_id === sid && x.at === s.clock.get()));
  assert.equal(rows[0]!.prominence, 0.5, 'the server stores the weight it decided (uniform here), not the number the client sent');
});

test('client events: the client cannot forge identity, time, outcomes or unknown elements', async () => {
  const s = setup();
  const { c } = await s.newUser();
  const bad = [
    [{ type: 'outcome', elementId: 'levels', value: 1 }],
    [{ type: 'exposure', elementId: 'nao_existe', prominence: 1 }],
    [{ type: 'exposure', elementId: 'levels', prominence: 2 }],
    [{ type: 'exposure', elementId: 'levels' }],
    [{ type: 'click', elementId: 'levels' }],
    ['texto'],
  ];
  for (const events of bad) assert.equal((await c.post('/api/events', { events })).status, 400, JSON.stringify(events));
  assert.equal((await c.post('/api/events', { events: 'x' })).status, 400);
  assert.equal((await c.post('/api/events', { events: Array.from({ length: 101 }, () => ({ type: 'interaction', elementId: 'levels' })) })).status, 400);
  // extra fields (userId/sessionId/at) from the client are ignored, not stored
  await c.post('/api/events', { events: [{ type: 'interaction', elementId: 'points', userId: 'u999', sessionId: 'forjado', at: 5 }] });
  const row = one<{ user_id: number; session_id: string; at: number }>(s.db, 'SELECT user_id, session_id, at FROM events');
  assert.equal(row?.user_id, 1);
  assert.notEqual(row?.session_id, 'forjado');
  assert.equal(row?.at, s.clock.get());
  assert.equal(all(s.db, 'SELECT * FROM events').length, 1, 'a rejected batch stores nothing');
});

test('exported CSV is anonymized: no code, nickname or password material', async () => {
  const s = setup();
  const { c, code } = await s.newUser('segredo123');
  await c.post('/api/events', { events: [{ type: 'exposure', elementId: 'points', prominence: 1 }] });
  const csv = exportEventsCsv(s.db);
  assert.match(csv, /^userId,group,sessionId,type,at,elementId,prominence,kind,value\n/);
  assert.match(csv, /\nu1,,s_[0-9a-f]{12},exposure,\d+,points,0\.5,,\n/);
  assert.ok(!csv.includes(code));
  assert.ok(!csv.includes('Estudante'));
});
