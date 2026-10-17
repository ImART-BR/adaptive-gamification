import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one } from '../src/db.ts';
import { decideSuggestion, pendingForTeam } from '../src/community.ts';
import { DAY, MIN, setup } from './helpers.ts';
import type { Client } from './helpers.ts';

type S = ReturnType<typeof setup>;

const points = async (c: Client) => (await c.get('/api/home')).json.points.total as number;
const nick = async (c: Client) => (await c.get('/api/me')).json.nickname as string;
const handle = async (s: S, c: Client) => s.handleOf(await nick(c));

async function finishQueue(c: Client) {
  const q = await c.get('/api/review/queue');
  let last: any;
  for (const card of q.json.cards) last = await c.post('/api/review', { cardId: card.id, grade: 2 });
  return last;
}

async function groupWith(s: S, ...users: { c: Client }[]) {
  const g = await users[0]!.c.post('/api/groups', { name: 'Turma de teste' });
  assert.equal(g.status, 201);
  for (const u of users.slice(1)) assert.equal((await u.c.post('/api/groups/join', { code: g.json.code })).status, 200);
  return g.json as { id: number; code: string };
}

// ---- groups ----------------------------------------------------------------------------------------------------

test('groups: create, join by code, detail with weekly points; the API never exposes internal ids', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const g = await groupWith(s, a, b);
  assert.match(g.code, /^[A-Z0-9]{6}$/);
  await s.withDeckInLibrary(a.c);
  await a.c.post('/api/review', { cardId: (await a.c.get('/api/review/queue')).json.cards[0].id, grade: 3 });
  const d = (await b.c.get(`/api/groups/${g.id}`)).json;
  assert.equal(d.members.length, 2);
  assert.equal(d.members[0].weekPoints > d.members[1].weekPoints, true, 'ranked by weekly points');
  assert.equal(d.members.filter((m: any) => m.me).length, 1);
  for (const m of d.members) assert.deepEqual(Object.keys(m).sort(), ['avatar', 'frame', 'handle', 'me', 'nickname', 'weekPoints', 'weekReviews']);
  assert.equal(d.weekGoal, 60);
  assert.equal(d.weekReviews, 1);
  assert.equal((await a.c.get('/api/groups')).json[0].memberCount, 2);
});

test('groups: invalid code, double join, non-members cannot read, caps on groups per user', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  assert.equal((await b.c.post('/api/groups/join', { code: 'ZZZZZZ' })).status, 404);
  const g = await groupWith(s, a, b);
  assert.equal((await b.c.post('/api/groups/join', { code: g.code })).status, 400);
  const outsider = await s.newUser();
  assert.equal((await outsider.c.get(`/api/groups/${g.id}`)).status, 404);
  assert.equal((await outsider.c.post(`/api/groups/${g.id}/decks`, { deckId: 1 })).status, 404);
  for (let i = 0; i < 4; i++) assert.equal((await a.c.post('/api/groups', { name: `G${i}` })).status, 201);
  assert.equal((await a.c.post('/api/groups', { name: 'excedente' })).status, 400);
  assert.equal((await a.c.post('/api/groups', { name: '   ' })).status, 400);
});

test('groups: a full group refuses new members; the last member leaving deletes it; ownership moves', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const g = await groupWith(s, a, b);
  for (let i = 0; i < 18; i++) {
    const r = s.db.prepare("INSERT INTO users (handle, code, nickname, created_at) VALUES (?, ?, 'x', 0)").run(`hfill${i}`, `fill${i}`);
    s.db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, 0)').run(g.id, Number(r.lastInsertRowid));
  }
  const full = await s.newUser();
  const count = one<{ n: number }>(s.db, 'SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', g.id)!.n;
  assert.equal(count, 20);
  assert.equal((await full.c.post('/api/groups/join', { code: g.code })).status, 400);

  const s2 = setup();
  const x = await s2.newUser();
  const y = await s2.newUser();
  const g2 = await groupWith(s2, x, y);
  await x.c.del(`/api/groups/${g2.id}/members/me`);
  assert.equal(one<{ owner_id: number }>(s2.db, 'SELECT owner_id FROM groups WHERE id = ?', g2.id)?.owner_id, 2, 'owner passes to the remaining member');
  await y.c.del(`/api/groups/${g2.id}/members/me`);
  assert.equal(one(s2.db, 'SELECT 1 AS x FROM groups WHERE id = ?', g2.id), undefined);
});

test('share a deck to a group: members see it; the owner gets the sharing reward once', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const g = await groupWith(s, a, b);
  const d = await a.c.post('/api/decks', { title: 'Meu resumo' });
  const before = await points(a.c);
  assert.equal((await a.c.post(`/api/groups/${g.id}/decks`, { deckId: d.json.id })).status, 200);
  assert.equal((await a.c.post(`/api/groups/${g.id}/decks`, { deckId: d.json.id })).status, 200, 'sharing twice is harmless');
  const gained = (await points(a.c)) - before;
  assert.ok(gained >= 5 && gained <= 5 + 20, `gained ${gained}`); // 5 (share) + possible 'sharer' bonus 20
  const detail = (await b.c.get(`/api/groups/${g.id}`)).json;
  assert.equal(detail.decks.length, 1);
  assert.equal(detail.decks[0].title, 'Meu resumo');
  assert.equal(detail.decks[0].inLibrary, false);
  assert.equal((await b.c.post(`/api/decks/${d.json.id}/library`)).status, 404, 'a private deck shared in a group is not added through the catalog route');
  assert.equal(all(s.db, "SELECT * FROM point_events WHERE reason LIKE 'share:%'").length, 1);
});

// ---- study pair ---------------------------------------------------------------------------------------------------

test('pair: invite, accept, rules, bonus when both finish the queue (once per day), end', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  await s.withDeckInLibrary(a.c);
  await s.withDeckInLibrary(b.c);
  const inv = await a.c.post('/api/pair/invite');
  assert.match(inv.json.code, /^[A-Z0-9]{6}$/);
  assert.equal((await a.c.post('/api/pair/accept', { code: inv.json.code })).status, 400, 'own invite');
  assert.equal((await b.c.post('/api/pair/accept', { code: 'ZZZZZZ' })).status, 404);
  assert.equal((await b.c.post('/api/pair/accept', { code: inv.json.code })).status, 200);
  assert.equal((await b.c.post('/api/pair/accept', { code: inv.json.code })).status, 404, 'invite is single use');
  assert.equal((await a.c.post('/api/pair/invite')).status, 400, 'already paired');

  const last = await finishQueue(a.c);
  assert.equal(last.json.pairBonus, 0, 'partner has not finished');
  let p = (await a.c.get('/api/pair')).json.pair;
  assert.equal(p.bothDone, false);
  assert.equal(p.partnerToday, null, 'the partner has not opened the app today');
  await b.c.get('/api/review/queue');
  p = (await a.c.get('/api/pair')).json.pair;
  assert.deepEqual(p.partnerToday, { total: 10, done: 0 });

  const lastB = await finishQueue(b.c);
  assert.equal(lastB.json.pairBonus, 15);
  p = (await a.c.get('/api/pair')).json.pair;
  assert.equal(p.bothDone, true);
  assert.equal(p.bonusToday, true);
  assert.equal(all(s.db, "SELECT * FROM point_events WHERE reason LIKE 'pair:%'").length, 2, 'one payment per partner');

  assert.equal((await b.c.del('/api/pair')).status, 200);
  assert.equal((await a.c.get('/api/pair')).json.pair, null);
  assert.equal((await b.c.del('/api/pair')).status, 404);
});

test('pair: invites expire after 24 hours', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const inv = await a.c.post('/api/pair/invite');
  s.clock.advance(DAY + MIN);
  assert.equal((await b.c.post('/api/pair/accept', { code: inv.json.code })).status, 404);
  assert.equal((await a.c.get('/api/pair')).json.pendingInvite, null);
});

// ---- feed and gifts ---------------------------------------------------------------------------------------------------

test('feed: shows group mates and partner activity, not mine and not strangers', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const stranger = await s.newUser();
  await groupWith(s, a, b);
  await s.withDeckInLibrary(a.c);
  await s.withDeckInLibrary(stranger.c);
  await finishQueue(a.c);
  await finishQueue(stranger.c);
  const fb = (await b.c.get('/api/feed')).json;
  const types = fb.map((x: any) => x.type);
  assert.ok(types.includes('queue_done'));
  assert.ok(types.includes('achievement'));
  assert.ok(fb.every((x: any) => x.user.nickname === 'x' || typeof x.user.handle === 'string'));
  assert.ok(fb.every((x: any) => x.user.nickname !== (undefined as unknown)));
  const names = new Set(fb.map((x: any) => x.user.nickname));
  assert.equal(names.has(await nick(stranger.c)), false);
  assert.equal(names.has(await nick(b.c)), false, 'own activity is not repeated back');
  assert.equal((await stranger.c.get('/api/feed')).json.length, 0);
  for (const item of fb) assert.equal(JSON.stringify(item).includes('toHandle'), false);
});

test('feed ignores old activity (14 days)', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  await groupWith(s, a, b);
  await s.withDeckInLibrary(a.c);
  await finishQueue(a.c);
  assert.ok((await b.c.get('/api/feed')).json.length > 0);
  s.clock.advance(15 * DAY);
  assert.equal((await b.c.get('/api/feed')).json.length, 0);
});

test('gifts: only to connections, +5 points to the receiver, 3 per day, resets next day', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const outsider = await s.newUser();
  const hb = await handle(s, b.c);
  assert.equal((await a.c.post('/api/gifts', { handle: hb })).status, 403, 'not connected yet');
  await groupWith(s, a, b);
  assert.equal((await a.c.post('/api/gifts', { handle: await handle(s, a.c) })).status, 400, 'self');
  assert.equal((await a.c.post('/api/gifts', { handle: 'hnaoexiste' })).status, 400);
  assert.equal((await a.c.post('/api/gifts', { handle: await handle(s, outsider.c) })).status, 403);

  const before = await points(b.c);
  const r1 = await a.c.post('/api/gifts', { handle: hb });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.remainingToday, 2);
  assert.equal((await points(b.c)) - before, 5);
  await a.c.post('/api/gifts', { handle: hb });
  await a.c.post('/api/gifts', { handle: hb });
  assert.equal((await a.c.post('/api/gifts', { handle: hb })).status, 429);
  assert.equal((await b.c.get('/api/gifts')).json.receivedThisWeek, 3);

  const feedB = (await b.c.get('/api/feed')).json;
  assert.ok(feedB.some((x: any) => x.type === 'gift' && x.toMe === true));
  s.clock.advance(DAY);
  assert.equal((await a.c.post('/api/gifts', { handle: hb })).status, 200);
});

test('connections list contains group mates and partner, with handles only', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const c = await s.newUser();
  await groupWith(s, a, b);
  const inv = await a.c.post('/api/pair/invite');
  await c.c.post('/api/pair/accept', { code: inv.json.code });
  const list = (await a.c.get('/api/connections')).json;
  assert.equal(list.length, 2);
  for (const u of list) assert.deepEqual(Object.keys(u).sort(), ['avatar', 'frame', 'handle', 'nickname']);
});

// ---- sharing, adoption, impact ------------------------------------------------------------------------------------------

test('publishing a deck rewards the author once; each adopter rewards once; impact counts people', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const d = await a.c.post('/api/decks', { title: 'Para todos' });
  const p0 = await points(a.c);
  await a.c.patch(`/api/decks/${d.json.id}`, { isPublic: true });
  const p1 = await points(a.c);
  assert.ok(p1 - p0 >= 5, 'share reward');
  await a.c.patch(`/api/decks/${d.json.id}`, { isPublic: false });
  await a.c.patch(`/api/decks/${d.json.id}`, { isPublic: true });
  assert.equal(all(s.db, "SELECT * FROM point_events WHERE reason LIKE 'share:%'").length, 1, 'publishing again pays nothing');

  const p2 = await points(a.c);
  await b.c.post(`/api/decks/${d.json.id}/library`);
  const afterAdd = await points(a.c);
  assert.equal(afterAdd - p2, 5);
  await b.c.del(`/api/decks/${d.json.id}/library`);
  await b.c.post(`/api/decks/${d.json.id}/library`);
  assert.equal(await points(a.c), afterAdd, 'same person again pays nothing');
  await b.c.post(`/api/decks/${d.json.id}/remix`);
  assert.equal(await points(a.c), afterAdd, 'remix by someone who already adopted pays nothing');
  const imp = (await a.c.get('/api/impact')).json;
  assert.equal(imp.adopters, 1);
  assert.equal(imp.remixers, 1);
  assert.equal(imp.sharedDecks, 1);
});

test('adopting your own deck or a team deck pays nobody', async () => {
  const s = setup();
  const a = await s.newUser();
  const d = await a.c.post('/api/decks', { title: 'Meu', isPublic: true });
  const before = await points(a.c);
  await a.c.post(`/api/decks/${d.json.id}/remix`);
  const gain = (await points(a.c)) - before;
  assert.ok(gain <= 20 + 0, `gain ${gain}`); // only the 'remixer' achievement bonus
  assert.equal(all(s.db, "SELECT * FROM point_events WHERE reason LIKE 'adopted:%'").length, 0);
  const b = await s.newUser();
  await s.withDeckInLibrary(b.c);
  assert.equal(all(s.db, "SELECT * FROM point_events WHERE reason LIKE 'adopted:%'").length, 0);
});

// ---- questions and answers -------------------------------------------------------------------------------------------------

test('questions: ask, others answer, only the asker marks "helpful", answerer earns points once', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const deckId = await s.withDeckInLibrary(a.c);
  const cardId = (await a.c.get(`/api/decks/${deckId}`)).json.cards[0].id;
  const q = await a.c.post('/api/questions', { deckId, cardId, text: 'Por que Palmas é a capital?' });
  assert.equal(q.status, 201);
  assert.equal((await a.c.post(`/api/questions/${q.json.id}/answers`, { text: 'eu mesmo' })).status, 400, 'cannot answer own question');

  const open = (await b.c.get('/api/questions?scope=open')).json;
  assert.equal(open.length, 1);
  assert.equal(open[0].cardFront, 'Capital do Acre');
  assert.equal((await a.c.get('/api/questions?scope=open')).json.length, 0, 'own questions are not "open for me"');

  const ans = await b.c.post(`/api/questions/${q.json.id}/answers`, { text: 'Foi planejada em 1988.' });
  assert.equal(ans.status, 201);
  assert.equal((await b.c.post(`/api/answers/${ans.json.id}/helpful`)).status, 404, 'only the asker can mark');
  const before = await points(b.c);
  const r = await a.c.post(`/api/answers/${ans.json.id}/helpful`);
  assert.equal(r.status, 200);
  assert.equal((await points(b.c)) - before >= 15, true);
  assert.equal((await a.c.post(`/api/answers/${ans.json.id}/helpful`)).status, 400);
  assert.equal((await b.c.get('/api/questions?scope=open')).json.length, 0, 'answered questions leave the open list');
  const mine = (await a.c.get('/api/questions?scope=mine')).json;
  assert.equal(mine[0].answered, true);
  assert.equal(mine[0].answers[0].helpful, true);
  assert.equal(all(s.db, "SELECT * FROM point_events WHERE reason LIKE 'helpful:%'").length, 1);
});

test('questions: private decks are invisible to others; validation and daily caps', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  const priv = await a.c.post('/api/decks', { title: 'Privado' });
  const pub = await a.c.post('/api/decks', { title: 'Publico', isPublic: true });
  assert.equal((await b.c.post('/api/questions', { deckId: priv.json.id, text: 'oi?' })).status, 404);
  const q = await a.c.post('/api/questions', { deckId: priv.json.id, text: 'só eu vejo' });
  assert.equal(q.status, 201);
  assert.equal((await b.c.get('/api/questions?scope=open')).json.length, 0);
  assert.equal((await b.c.get(`/api/questions/${q.json.id}`)).status, 404);
  assert.equal((await a.c.post('/api/questions', { deckId: pub.json.id, text: '' })).status, 400);
  assert.equal((await a.c.post('/api/questions', { deckId: pub.json.id, text: 'x'.repeat(501) })).status, 400);
  assert.equal((await a.c.post('/api/questions', { deckId: pub.json.id, cardId: 99999, text: 'oi' })).status, 400);
  for (let i = 0; i < 4; i++) assert.equal((await a.c.post('/api/questions', { deckId: pub.json.id, text: `pergunta ${i}` })).status, 201);
  assert.equal((await a.c.post('/api/questions', { deckId: pub.json.id, text: 'a sexta' })).status, 429);
});

test('moderation: content hidden after 3 distinct reports; one person counts once', async () => {
  const s = setup();
  const a = await s.newUser();
  const others = [await s.newUser(), await s.newUser(), await s.newUser()];
  const pub = await a.c.post('/api/decks', { title: 'Publico', isPublic: true });
  const q = await a.c.post('/api/questions', { deckId: pub.json.id, text: 'pergunta ruim' });
  const viewer = await s.newUser();
  assert.equal((await viewer.c.get('/api/questions?scope=open')).json.length, 1);
  assert.equal((await others[0]!.c.post('/api/reports', { kind: 'question', id: q.json.id })).json.reports, 1);
  assert.equal((await others[0]!.c.post('/api/reports', { kind: 'question', id: q.json.id })).json.reports, 1, 'same person again');
  await others[1]!.c.post('/api/reports', { kind: 'question', id: q.json.id });
  assert.equal((await viewer.c.get('/api/questions?scope=open')).json.length, 1);
  await others[2]!.c.post('/api/reports', { kind: 'question', id: q.json.id });
  assert.equal((await viewer.c.get('/api/questions?scope=open')).json.length, 0);
  assert.equal((await a.c.get('/api/questions?scope=mine')).json.length, 1, 'the author still sees it');
  assert.equal((await viewer.c.post('/api/reports', { kind: 'nada', id: 1 })).status, 400);
  assert.equal((await viewer.c.post('/api/reports', { kind: 'answer', id: 999 })).status, 404);
});

// ---- ideas to vote on --------------------------------------------------------------------------------------------------------

test('proposals: seeded list, toggle vote, 3 votes max, add ideas with a daily cap', async () => {
  const s = setup();
  const a = await s.newUser();
  const list = (await a.c.get('/api/proposals')).json;
  assert.equal(list.proposals.length, 6);
  assert.equal(list.votesLeft, 3);
  const ids = list.proposals.map((p: any) => p.id);
  for (const id of ids.slice(0, 3)) assert.equal((await a.c.post(`/api/proposals/${id}/vote`)).json.voted, true);
  assert.equal((await a.c.post(`/api/proposals/${ids[3]}/vote`)).status, 400);
  assert.equal((await a.c.post(`/api/proposals/${ids[0]}/vote`)).json.voted, false, 'toggle off');
  assert.equal((await a.c.post(`/api/proposals/${ids[3]}/vote`)).json.voted, true);
  const after = (await a.c.get('/api/proposals')).json;
  assert.equal(after.votesLeft, 0);
  assert.equal(after.proposals[0].votes, 1);
  assert.equal((await a.c.post('/api/proposals/9999/vote')).status, 404);
  for (let i = 0; i < 3; i++) assert.equal((await a.c.post('/api/proposals', { title: `Ideia ${i}` })).status, 201);
  assert.equal((await a.c.post('/api/proposals', { title: 'Ideia 4' })).status, 429);
  assert.equal((await a.c.post('/api/proposals', { title: '' })).status, 400);
  assert.ok((await a.c.get('/api/home')).json.achievements.find((x: any) => x.key === 'voter').unlockedAt);
});

// ---- edit suggestions -------------------------------------------------------------------------------------------------------------

test('suggest edits: other users propose, the owner accepts (applies + rewards) or rejects', async () => {
  const s = setup();
  const owner = await s.newUser();
  const fan = await s.newUser();
  const d = await owner.c.post('/api/decks', { title: 'Com erro', isPublic: true });
  const card = await owner.c.post(`/api/decks/${d.json.id}/cards`, { front: 'Capital da França', back: 'Lyon' });
  assert.equal((await owner.c.post(`/api/cards/${card.json.id}/suggestions`, { back: 'Paris' })).status, 400, 'own deck');
  assert.equal((await fan.c.post(`/api/cards/${card.json.id}/suggestions`, {})).status, 400);
  assert.equal((await fan.c.post(`/api/cards/${card.json.id}/suggestions`, { back: 'Lyon' })).status, 400, 'no change');
  const sg = await fan.c.post(`/api/cards/${card.json.id}/suggestions`, { back: 'Paris', note: 'Lyon não é a capital' });
  assert.equal(sg.status, 201);
  assert.equal(sg.json.toTeam, false);
  assert.equal((await fan.c.post(`/api/cards/${card.json.id}/suggestions`, { back: 'Paris!' })).status, 400, 'one pending per card');

  assert.equal((await fan.c.get(`/api/decks/${d.json.id}/suggestions`)).status, 404, 'only the owner lists them');
  const pending = (await owner.c.get(`/api/decks/${d.json.id}/suggestions`)).json;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].newBack, 'Paris');
  assert.equal(pending[0].currentBack, 'Lyon');

  assert.equal((await fan.c.post(`/api/suggestions/${sg.json.id}/accept`)).status, 404);
  const before = await points(fan.c);
  assert.equal((await owner.c.post(`/api/suggestions/${sg.json.id}/accept`)).status, 200);
  assert.equal((await owner.c.post(`/api/suggestions/${sg.json.id}/accept`)).status, 400, 'already decided');
  assert.equal((await owner.c.get(`/api/decks/${d.json.id}`)).json.cards[0].back, 'Paris');
  assert.ok((await points(fan.c)) - before >= 10);
  assert.equal((await fan.c.get('/api/suggestions/mine')).json[0].status, 'accepted');
  assert.ok((await fan.c.get('/api/home')).json.achievements.find((x: any) => x.key === 'editor').unlockedAt);

  const card2 = await owner.c.post(`/api/decks/${d.json.id}/cards`, { front: 'x', back: 'y' });
  const sg2 = await fan.c.post(`/api/cards/${card2.json.id}/suggestions`, { front: 'xx' });
  await owner.c.post(`/api/suggestions/${sg2.json.id}/reject`);
  assert.equal((await owner.c.get(`/api/decks/${d.json.id}`)).json.cards[1].front, 'x');
});

test('suggest edits on team decks go to the research team (admin path)', async () => {
  const s = setup();
  const fan = await s.newUser();
  await s.withDeckInLibrary(fan.c, 'Química: elementos');
  const deck = (await fan.c.get('/api/catalog')).json.find((x: any) => x.title === 'Química: elementos');
  const cardId = (await fan.c.get(`/api/decks/${deck.id}`)).json.cards[0].id;
  const sg = await fan.c.post(`/api/cards/${cardId}/suggestions`, { back: 'Hidrogênio (H)' });
  assert.equal(sg.json.toTeam, true);
  assert.equal(pendingForTeam(s.db).length, 1);
  assert.equal((await fan.c.post(`/api/suggestions/${sg.json.id}/accept`)).status, 404, 'a user cannot accept on team decks');
  decideSuggestion(s.db, null, s.clock.get(), sg.json.id, true);
  assert.equal(pendingForTeam(s.db).length, 0);
  assert.equal((await fan.c.get(`/api/decks/${deck.id}`)).json.cards[0].back, 'Hidrogênio (H)');
});

// ---- achievements and summary ---------------------------------------------------------------------------------------------------------

test('social achievements unlock: group, pair, sharer, curious', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  await groupWith(s, a, b);
  const inv = await a.c.post('/api/pair/invite');
  await b.c.post('/api/pair/accept', { code: inv.json.code });
  const d = await a.c.post('/api/decks', { title: 'Aberto', isPublic: true });
  await a.c.post('/api/questions', { deckId: d.json.id, text: 'alguém aí?' });
  const ach = (await a.c.get('/api/home')).json.achievements;
  for (const key of ['group_member', 'pair_formed', 'sharer', 'curious']) assert.ok(ach.find((x: any) => x.key === key).unlockedAt, key);
});

test('social summary gathers what the home page needs', async () => {
  const s = setup();
  const a = await s.newUser();
  const b = await s.newUser();
  await groupWith(s, a, b);
  const deck = await a.c.post('/api/decks', { title: 'Aberto', isPublic: true });
  await b.c.post('/api/questions', { deckId: deck.json.id, text: 'dúvida' });
  const sum = (await a.c.get('/api/social/summary')).json;
  assert.equal(sum.groups.length, 1);
  assert.equal(sum.pair.pair, null);
  assert.equal(sum.connections.length, 1);
  assert.equal(sum.openQuestions, 1);
  assert.equal(sum.gifts.remainingToday, 3);
  assert.equal(sum.impact.sharedDecks, 1);
});

test('migration adds public handles to users created before slice 2', async () => {
  const { openDb } = await import('../src/db.ts');
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ga-mig-'));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, pass_hash TEXT, nickname TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT 'x', theme TEXT NOT NULL DEFAULT 'padrao', frame TEXT NOT NULL DEFAULT 'nenhuma', created_at INTEGER NOT NULL, consented_at INTEGER, consent_version TEXT, grp TEXT)");
  old.exec("INSERT INTO users (code, nickname, created_at) VALUES ('a-AAAA-AAAA', 'um', 0), ('b-BBBB-BBBB', 'dois', 0)");
  old.close();
  const db = openDb(path);
  const handles = all<{ handle: string }>(db, 'SELECT handle FROM users').map((r) => r.handle);
  assert.equal(handles.length, 2);
  assert.ok(handles.every((h) => /^h[a-z0-9]{8}$/.test(h)));
  assert.notEqual(handles[0], handles[1]);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
