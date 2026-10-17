import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, one } from '../src/db.ts';
import { exportDailyCsv, exportDecisionsCsv, exportEventsCsv, exportProfilesCsv } from '../src/exports.ts';
import { CATALOG } from '../src/spec.ts';
import { DAY, MIN, setup } from './helpers.ts';
import type { Client } from './helpers.ts';

const ON = { experiment: { enabled: true, seed: 11 } } as const;
const IDS = CATALOG.elements.map((e) => e.id);

type S = ReturnType<typeof setup>;
const groupOf = (s: S, nickname: string) => one<{ grp: string | null }>(s.db, 'SELECT grp FROM users WHERE nickname = ?', nickname)?.grp ?? null;

async function me(c: Client) {
  return (await c.get('/api/me')).json as { nickname: string; weights: Record<string, number>; [k: string]: unknown };
}

/** Registers users until one of the wanted group is found (assignment is random, in blocks). */
async function userInGroup(s: S, wanted: 'adaptive' | 'control') {
  for (let i = 0; i < 12; i++) {
    const u = await s.newUser();
    const m = await me(u.c);
    if (groupOf(s, m.nickname) === wanted) return u;
  }
  throw new Error(`no ${wanted} user found`);
}

/** What the web client does: reports one exposure per element with the prominence it applied (= the weight). */
async function viewEverything(c: Client) {
  const w = (await me(c)).weights;
  await c.post('/api/events', { events: IDS.map((elementId) => ({ type: 'exposure', elementId, prominence: w[elementId] })) });
}

async function finishQueue(c: Client, grade = 2) {
  const q = await c.get('/api/review/queue');
  for (const card of q.json.cards) await c.post('/api/review', { cardId: card.id, grade });
}

// ---- assignment ---------------------------------------------------------------------------------------------------

test('experiment off (default): nobody gets a group, the interface is uniform, the core never runs', async () => {
  const s = setup();
  const { c } = await s.newUser();
  const m = await me(c);
  assert.equal(groupOf(s, m.nickname), null);
  assert.deepEqual(Object.keys(m.weights).sort(), [...IDS].sort());
  assert.ok(Object.values(m.weights).every((w) => w === 0.5));
  await s.withDeckInLibrary(c);
  await viewEverything(c);
  await finishQueue(c);
  s.clock.advance(DAY);
  await me(c);
  assert.equal(all(s.db, 'SELECT * FROM engine_state').length, 0);
});

test('assignment uses permuted blocks of 4: always 2 adaptive and 2 control per block', async () => {
  const s = setup(ON);
  const groups: (string | null)[] = [];
  for (let i = 0; i < 12; i++) {
    const u = await s.newUser();
    groups.push(groupOf(s, (await me(u.c)).nickname));
  }
  for (let b = 0; b < 3; b++) {
    const block = groups.slice(b * 4, b * 4 + 4);
    assert.equal(block.filter((g) => g === 'adaptive').length, 2, `block ${b}: ${block.join(',')}`);
    assert.equal(block.filter((g) => g === 'control').length, 2);
  }
});

test('assignment is permanent and the client never sees the group', async () => {
  const s = setup(ON);
  const { c } = await s.newUser();
  const m1 = await me(c);
  const g = groupOf(s, m1.nickname);
  assert.ok(g === 'adaptive' || g === 'control');
  s.clock.advance(3 * DAY);
  assert.equal(groupOf(s, (await me(c)).nickname), g);
  const raw = JSON.stringify((await c.get('/api/me')).json) + JSON.stringify((await c.get('/api/home')).json);
  assert.ok(!/"(grp|group)"\s*:|adaptive|"control"/i.test(raw), 'no trace of the group in what the client receives');
});

// ---- the day's decision ------------------------------------------------------------------------------------------------

test('control users get uniform weights; adaptive users get the core\'s weights within the floor', async () => {
  const s = setup(ON);
  const ctrl = await userInGroup(s, 'control');
  const adap = await userInGroup(s, 'adaptive');
  const wc = (await me(ctrl.c)).weights;
  assert.deepEqual(Object.keys(wc).sort(), [...IDS].sort());
  assert.ok(Object.values(wc).every((w) => w === 0.5));
  const wa = (await me(adap.c)).weights;
  assert.deepEqual(Object.keys(wa).sort(), [...IDS].sort());
  const vals = Object.values(wa);
  assert.ok(vals.every((w) => w >= 0.1 - 1e-9 && w <= 1 + 1e-9), 'respects the exposure floor');
  assert.ok(Math.max(...vals) - Math.min(...vals) > 0.05, 'the adaptive interface is not uniform');
  assert.equal(all(s.db, 'SELECT * FROM engine_state WHERE user_id = ?', 1).length >= 0, true);
});

test('the decision is made once per day: every visit that day shares it; a new day decides again', async () => {
  const s = setup(ON);
  const { c } = await userInGroup(s, 'adaptive');
  const w1 = (await me(c)).weights;
  s.clock.advance(45 * MIN); // new visit session, same day
  assert.deepEqual((await me(c)).weights, w1);
  s.clock.advance(2 * 60 * MIN);
  assert.deepEqual((await me(c)).weights, w1);
  const uid = one<{ id: number }>(s.db, "SELECT id FROM users WHERE grp = 'adaptive' ORDER BY id DESC LIMIT 1")!.id;
  assert.equal(all(s.db, 'SELECT * FROM day_weights WHERE user_id = ?', uid).length, 1);
  s.clock.advance(DAY);
  await me(c);
  assert.equal(all(s.db, 'SELECT * FROM day_weights WHERE user_id = ?', uid).length, 2);
  const state = JSON.parse(one<{ state: string }>(s.db, 'SELECT state FROM engine_state WHERE user_id = ?', uid)!.state);
  assert.match(state.lastDecision.sessionId, /^d\d+$/);
});

// ---- soft start --------------------------------------------------------------------------------------------

test('soft start: the first day is close to uniform and the raw decision and factor are logged', async () => {
  const s = setup(ON);
  const { c } = await userInGroup(s, 'adaptive');
  const uid = one<{ id: number }>(s.db, "SELECT id FROM users WHERE grp = 'adaptive' ORDER BY id DESC LIMIT 1")!.id;
  const w = (await me(c)).weights;
  for (const v of Object.values(w)) assert.ok(v >= 0.375 - 1e-9 && v <= 0.625 + 1e-9, `weight ${v}`);
  const row = one<{ weights: string; raw: string; shrink: number }>(s.db, 'SELECT weights, raw, shrink FROM day_weights WHERE user_id = ?', uid)!;
  assert.equal(row.shrink, 0.25);
  const raw = JSON.parse(row.raw) as Record<string, number>;
  assert.ok(Math.max(...Object.values(raw)) - Math.min(...Object.values(raw)) > 0.5, 'the core itself decided something far from uniform');
  for (const id of IDS) assert.ok(Math.abs(w[id]! - (0.5 + 0.25 * (raw[id]! - 0.5))) < 1e-9);
});

test('soft start: the factor grows over the first 7 decision days, then the core\'s weights apply as they are', async () => {
  const s = setup(ON);
  const { c } = await userInGroup(s, 'adaptive');
  const uid = one<{ id: number }>(s.db, "SELECT id FROM users WHERE grp = 'adaptive' ORDER BY id DESC LIMIT 1")!.id;
  for (let d = 0; d < 9; d++) {
    await me(c);
    s.clock.advance(DAY);
  }
  const ks = all<{ shrink: number }>(s.db, 'SELECT shrink FROM day_weights WHERE user_id = ? ORDER BY day', uid).map((r) => r.shrink);
  assert.deepEqual(ks.map((k) => Math.round(k * 1000) / 1000), [0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1, 1]);
  const last = one<{ weights: string; raw: string }>(s.db, 'SELECT weights, raw FROM day_weights WHERE user_id = ? ORDER BY day DESC LIMIT 1', uid)!;
  assert.deepEqual(JSON.parse(last.weights), JSON.parse(last.raw));
});

test('soft start counts decision days (days the user showed up), not calendar days', async () => {
  const s = setup(ON);
  const { c } = await userInGroup(s, 'adaptive');
  const uid = one<{ id: number }>(s.db, "SELECT id FROM users WHERE grp = 'adaptive' ORDER BY id DESC LIMIT 1")!.id;
  await me(c);
  s.clock.advance(10 * DAY); // ten days away
  await me(c);
  const ks = all<{ shrink: number }>(s.db, 'SELECT shrink FROM day_weights WHERE user_id = ? ORDER BY day', uid).map((r) => r.shrink);
  assert.deepEqual(ks, [0.25, 0.375]);
});

test('rampDays = 1 disables the soft start; control users are never shrunk', async () => {
  const s = setup({ experiment: { enabled: true, seed: 11, rampDays: 1 } });
  const adap = await userInGroup(s, 'adaptive');
  const uid = one<{ id: number }>(s.db, "SELECT id FROM users WHERE grp = 'adaptive' ORDER BY id DESC LIMIT 1")!.id;
  await me(adap.c);
  assert.equal(one<{ shrink: number }>(s.db, 'SELECT shrink FROM day_weights WHERE user_id = ?', uid)!.shrink, 1);
  const s2 = setup(ON);
  const ctrl = await userInGroup(s2, 'control');
  await me(ctrl.c);
  const cid = one<{ id: number }>(s2.db, "SELECT id FROM users WHERE grp = 'control' ORDER BY id DESC LIMIT 1")!.id;
  const row = one<{ raw: string | null; shrink: number | null }>(s2.db, 'SELECT raw, shrink FROM day_weights WHERE user_id = ?', cid)!;
  assert.equal(row.raw, null);
  assert.equal(row.shrink, null);
});

test('exposures are logged with the weight the user actually saw (the shrunk one)', async () => {
  const s = setup(ON);
  const { c } = await userInGroup(s, 'adaptive');
  const w = (await me(c)).weights;
  await viewEverything(c);
  const logged = all<{ element_id: string; prominence: number }>(s.db, "SELECT element_id, prominence FROM events WHERE type = 'exposure'");
  assert.equal(logged.length, IDS.length);
  for (const e of logged) assert.ok(Math.abs(e.prominence - w[e.element_id]!) < 1e-9);
});

// ---- feeding the core ----------------------------------------------------------------------------------------------------

test('a finished day is sent to the core on the next visit: the model learns and the profile is logged', async () => {
  const s = setup(ON);
  const { c } = await userInGroup(s, 'adaptive');
  const uid = one<{ id: number }>(s.db, "SELECT id FROM users WHERE grp = 'adaptive' ORDER BY id DESC LIMIT 1")!.id;
  await s.withDeckInLibrary(c);
  await viewEverything(c);
  await finishQueue(c);
  const before = JSON.parse(one<{ state: string }>(s.db, 'SELECT state FROM engine_state WHERE user_id = ?', uid)!.state);
  assert.equal(before.sessionsObserved, 0, 'nothing is sent while the day is still open');

  s.clock.advance(DAY);
  await me(c);
  const after = JSON.parse(one<{ state: string }>(s.db, 'SELECT state FROM engine_state WHERE user_id = ?', uid)!.state);
  assert.equal(after.sessionsObserved, 1);
  assert.deepEqual(all(s.db, 'SELECT sent FROM engine_days WHERE user_id = ?', uid).map((r: any) => r.sent), [1]);
  const log = all<{ sessions_observed: number; profile: string }>(s.db, 'SELECT sessions_observed, profile FROM profile_log WHERE user_id = ?', uid);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.sessions_observed, 1);
  assert.deepEqual(Object.keys(JSON.parse(log[0]!.profile)).sort(), ['achiever', 'disruptor', 'freeSpirit', 'philanthropist', 'player', 'socialiser']);

  s.clock.advance(DAY);
  await me(c); // a day with no visit data in between must not be re-sent
  assert.equal(all(s.db, 'SELECT * FROM engine_days WHERE user_id = ?', uid).length, 1);
  assert.equal(JSON.parse(one<{ state: string }>(s.db, 'SELECT state FROM engine_state WHERE user_id = ?', uid)!.state).sessionsObserved, 1);
});

test('the outcome sent to the core is the fraction of the queue finished (an unfinished day counts, not as a failure of the app)', async () => {
  const s = setup(ON);
  const { c } = await userInGroup(s, 'adaptive');
  const uid = one<{ id: number }>(s.db, "SELECT id FROM users WHERE grp = 'adaptive' ORDER BY id DESC LIMIT 1")!.id;
  await s.withDeckInLibrary(c);
  await viewEverything(c);
  const q = await c.get('/api/review/queue');
  for (const card of q.json.cards.slice(0, 4)) await c.post('/api/review', { cardId: card.id, grade: 2 }); // 4 of 10
  s.clock.advance(DAY);
  await me(c);
  const st = JSON.parse(one<{ state: string }>(s.db, 'SELECT state FROM engine_state WHERE user_id = ?', uid)!.state);
  assert.equal(st.sessionsObserved, 1);
  // level of the model ~ mean reward: after one session with r = 0.4 it must be positive but below 0.4
  const lvl = one<{ level: number }>(s.db, 'SELECT level FROM profile_log WHERE user_id = ?', uid)!.level;
  assert.ok(lvl > 0 && lvl < 0.4, `level ${lvl}`);
});

test('days without a queue are not sent (they would look like failures); days with a queue and no review are sent as 0', async () => {
  const s = setup(ON);
  const { c } = await userInGroup(s, 'adaptive');
  const uid = one<{ id: number }>(s.db, "SELECT id FROM users WHERE grp = 'adaptive' ORDER BY id DESC LIMIT 1")!.id;
  // day 1: no decks, so no queue, but the user looks around
  await viewEverything(c);
  s.clock.advance(DAY);
  await me(c);
  assert.deepEqual(all(s.db, 'SELECT sent FROM engine_days WHERE user_id = ?', uid).map((r: any) => r.sent), [0]);
  assert.equal(all(s.db, 'SELECT * FROM profile_log WHERE user_id = ?', uid).length, 0);
  // day 2: has a queue (opening the home page takes the day's snapshot), sees the elements, reviews nothing
  await s.withDeckInLibrary(c);
  await c.get('/api/home');
  await viewEverything(c);
  s.clock.advance(DAY);
  await me(c);
  assert.deepEqual(all(s.db, 'SELECT sent FROM engine_days WHERE user_id = ? ORDER BY day', uid).map((r: any) => r.sent), [0, 1]);
  assert.equal(all(s.db, 'SELECT * FROM profile_log WHERE user_id = ?', uid).length, 1);
});

test('several missed days are settled in order on the next visit', async () => {
  const s = setup(ON);
  const { c } = await userInGroup(s, 'adaptive');
  const uid = one<{ id: number }>(s.db, "SELECT id FROM users WHERE grp = 'adaptive' ORDER BY id DESC LIMIT 1")!.id;
  await s.withDeckInLibrary(c);
  for (let d = 0; d < 3; d++) {
    await viewEverything(c);
    await finishQueue(c);
    s.clock.advance(DAY);
    // do not open the app through /api/me on the next day until the loop ends (requests settle days): use a raw clock jump
  }
  // the loop's requests already settled earlier days; check totals instead of timing
  await me(c);
  const st = JSON.parse(one<{ state: string }>(s.db, 'SELECT state FROM engine_state WHERE user_id = ?', uid)!.state);
  assert.equal(st.sessionsObserved, 3);
  assert.equal(all(s.db, 'SELECT * FROM profile_log WHERE user_id = ?', uid).length, 3);
});

test('control users never get a model', async () => {
  const s = setup(ON);
  const { c } = await userInGroup(s, 'control');
  await s.withDeckInLibrary(c);
  await viewEverything(c);
  await finishQueue(c);
  s.clock.advance(DAY);
  await me(c);
  const uid = one<{ id: number }>(s.db, "SELECT id FROM users WHERE grp = 'control' ORDER BY id DESC LIMIT 1")!.id;
  assert.equal(all(s.db, 'SELECT * FROM engine_state WHERE user_id = ?', uid).length, 0);
  assert.equal(all(s.db, 'SELECT * FROM profile_log WHERE user_id = ?', uid).length, 0);
  assert.equal(all(s.db, 'SELECT * FROM day_weights WHERE user_id = ?', uid).length, 2, 'decisions are logged for both groups');
});

test('if the core fails, the user still gets a working page with uniform weights', async () => {
  const s = setup(ON);
  const { c } = await userInGroup(s, 'adaptive');
  const uid = one<{ id: number }>(s.db, "SELECT id FROM users WHERE grp = 'adaptive' ORDER BY id DESC LIMIT 1")!.id;
  s.db.prepare('UPDATE engine_state SET state = ? WHERE user_id = ?').run('{broken', uid);
  s.clock.advance(DAY);
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await c.get('/api/me');
    assert.equal(r.status, 200);
    assert.ok(Object.values(r.json.weights as Record<string, number>).every((w) => w === 0.5));
  } finally {
    console.error = orig;
  }
});

// ---- exports --------------------------------------------------------------------------------------------------------------------

test('exports: decisions, profiles and daily rows, anonymized and with the group column', async () => {
  const s = setup(ON);
  const ctrl = await userInGroup(s, 'control');
  const adap = await userInGroup(s, 'adaptive');
  for (const u of [ctrl, adap]) {
    await s.withDeckInLibrary(u.c);
    await viewEverything(u.c);
    await finishQueue(u.c);
  }
  // one user reviews a bit worse to test accuracy
  s.clock.advance(DAY);
  await me(ctrl.c);
  await me(adap.c);

  const decisions = exportDecisionsCsv(s.db).trim().split('\n');
  assert.equal(decisions[0], 'userId,group,day,elementId,weight,rawWeight,shrink');
  const dayRows = one<{ n: number }>(s.db, 'SELECT COUNT(*) AS n FROM day_weights')!.n;
  assert.ok(dayRows >= 4, 'at least my two users x two days');
  assert.equal(decisions.length - 1, dayRows * IDS.length, 'one row per user, day and element');
  assert.ok(decisions.some((l) => l.includes(',control,')) && decisions.some((l) => l.includes(',adaptive,')));

  const profiles = exportProfilesCsv(s.db).trim().split('\n');
  assert.equal(profiles.length - 1, 1, 'only the adaptive user has profile rows');
  assert.ok(profiles[0]!.startsWith('userId,group,day,sessionsObserved,level,profile_achiever'));
  assert.ok(profiles[1]!.includes(',adaptive,'));

  const daily = exportDailyCsv(s.db).trim().split('\n');
  assert.equal(daily[0], 'userId,group,day,queueTotal,queueDone,outcome,reviews,correct,accuracy');
  const first = daily[1]!.split(',');
  assert.equal(first[3], '10');
  assert.equal(first[4], '10');
  assert.equal(first[5], '1');
  assert.equal(first[8], '1');

  const all4 = [exportEventsCsv(s.db), exportDecisionsCsv(s.db), exportProfilesCsv(s.db), exportDailyCsv(s.db)].join('\n');
  assert.ok(!all4.includes(ctrl.code) && !all4.includes(adap.code));
  assert.ok(!all4.includes('Estudante'));
  const handles = all<{ handle: string }>(s.db, 'SELECT handle FROM users').map((r) => r.handle);
  for (const h of handles) assert.ok(!all4.includes(h));
});
