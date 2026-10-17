// Socialiser and Philanthropist elements: study groups, activity feed, study pair, gifts, sharing and impact.
// Everything visible to other users uses a public handle plus nickname/avatar/frame, never the internal id.
import { all, one, run, tx } from './db.ts';
import type { Db } from './db.ts';
import { SOCIAL } from './gamification.ts';
import { randomInviteCode } from './ids.ts';
import { HttpError, getDeck } from './library.ts';
import { alreadyGranted, grantPoints, logActivity } from './points.ts';
import { dayNumber, weekStartDay } from './time.ts';

export interface PublicUser {
  handle: string;
  nickname: string;
  avatar: string;
  frame: string;
}

const DAY_MS = 86_400_000;
const INVITE_TTL_MS = DAY_MS;

export function publicUser(db: Db, userId: number): PublicUser {
  const u = one<{ handle: string; nickname: string; avatar: string; frame: string }>(db, 'SELECT handle, nickname, avatar, frame FROM users WHERE id = ?', userId);
  if (!u) throw new HttpError(404, 'usuário não encontrado');
  return u;
}

function cleanText(s: unknown, max: number, field: string): string {
  if (typeof s !== 'string' || s.trim().length === 0) throw new HttpError(400, `${field} não pode ficar vazio`);
  const t = s.trim();
  if (t.length > max) throw new HttpError(400, `${field} passa de ${max} caracteres`);
  return t;
}

// ---- groups -------------------------------------------------------------------------------------------------------

function memberIds(db: Db, groupId: number): number[] {
  return all<{ user_id: number }>(db, 'SELECT user_id FROM group_members WHERE group_id = ?', groupId).map((r) => r.user_id);
}

function isMember(db: Db, groupId: number, userId: number): boolean {
  return !!one(db, 'SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId);
}

function weekStats(db: Db, userId: number, now: number) {
  const ws = weekStartDay(dayNumber(now));
  const pts = one<{ p: number | null }>(db, 'SELECT SUM(points) AS p FROM point_events WHERE user_id = ? AND day >= ?', userId, ws)?.p ?? 0;
  const reviews = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM reviews WHERE user_id = ? AND day >= ?', userId, ws)?.n ?? 0;
  return { points: pts, reviews };
}

export function createGroup(db: Db, userId: number, now: number, nameIn: unknown) {
  const name = cleanText(nameIn, 40, 'nome do grupo');
  const mine = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM group_members WHERE user_id = ?', userId)?.n ?? 0;
  if (mine >= SOCIAL.maxGroupsPerUser) throw new HttpError(400, `você já participa de ${SOCIAL.maxGroupsPerUser} grupos`);
  return tx(db, () => {
    let code = randomInviteCode();
    while (one(db, 'SELECT 1 AS x FROM groups WHERE code = ?', code)) code = randomInviteCode();
    const { id } = run(db, 'INSERT INTO groups (name, code, owner_id, created_at) VALUES (?, ?, ?, ?)', name, code, userId, now);
    run(db, 'INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)', id, userId, now);
    return { id, name, code };
  });
}

export function joinGroup(db: Db, userId: number, now: number, codeIn: unknown) {
  const code = typeof codeIn === 'string' ? codeIn.trim().toUpperCase() : '';
  const g = one<{ id: number; name: string }>(db, 'SELECT id, name FROM groups WHERE code = ?', code);
  if (!g) throw new HttpError(404, 'código de grupo não encontrado');
  if (isMember(db, g.id, userId)) throw new HttpError(400, 'você já está neste grupo');
  const mine = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM group_members WHERE user_id = ?', userId)?.n ?? 0;
  if (mine >= SOCIAL.maxGroupsPerUser) throw new HttpError(400, `você já participa de ${SOCIAL.maxGroupsPerUser} grupos`);
  if (memberIds(db, g.id).length >= SOCIAL.maxGroupMembers) throw new HttpError(400, 'o grupo está cheio');
  run(db, 'INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)', g.id, userId, now);
  logActivity(db, userId, 'joined_group', { groupName: g.name }, now);
  return { id: g.id, name: g.name };
}

export function leaveGroup(db: Db, userId: number, groupId: number): void {
  if (!isMember(db, groupId, userId)) throw new HttpError(404, 'grupo não encontrado');
  tx(db, () => {
    run(db, 'DELETE FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId);
    const left = memberIds(db, groupId);
    if (left.length === 0) {
      run(db, 'DELETE FROM group_decks WHERE group_id = ?', groupId);
      run(db, 'DELETE FROM groups WHERE id = ?', groupId);
    } else {
      const g = one<{ owner_id: number }>(db, 'SELECT owner_id FROM groups WHERE id = ?', groupId);
      if (g && g.owner_id === userId) run(db, 'UPDATE groups SET owner_id = ? WHERE id = ?', left[0]!, groupId);
    }
  });
}

export function myGroups(db: Db, userId: number, now: number) {
  const groups = all<{ id: number; name: string; code: string }>(db, 'SELECT g.id, g.name, g.code FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY m.joined_at, g.id', userId);
  return groups.map((g) => {
    const ids = memberIds(db, g.id);
    const reviews = ids.reduce((acc, id) => acc + weekStats(db, id, now).reviews, 0);
    return { id: g.id, name: g.name, code: g.code, memberCount: ids.length, weekReviews: reviews, weekGoal: SOCIAL.groupWeeklyReviewsPerMember * ids.length };
  });
}

export function groupDetail(db: Db, userId: number, now: number, groupId: number) {
  const g = one<{ id: number; name: string; code: string; owner_id: number }>(db, 'SELECT id, name, code, owner_id FROM groups WHERE id = ?', groupId);
  if (!g || !isMember(db, groupId, userId)) throw new HttpError(404, 'grupo não encontrado');
  const members = memberIds(db, groupId).map((id) => ({ id, ...publicUser(db, id), ...weekStats(db, id, now) }));
  members.sort((a, b) => b.points - a.points || a.nickname.localeCompare(b.nickname));
  const decks = all<{ id: number; title: string; cards: number; by: string | null; in_library: number }>(
    db,
    `SELECT d.id, d.title, (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id) AS cards, u.nickname AS by,
            EXISTS(SELECT 1 FROM library l WHERE l.user_id = ? AND l.deck_id = d.id) AS in_library
       FROM group_decks gd JOIN decks d ON d.id = gd.deck_id LEFT JOIN users u ON u.id = gd.shared_by
      WHERE gd.group_id = ? ORDER BY gd.at DESC`,
    userId,
    groupId,
  );
  const weekReviews = members.reduce((acc, m) => acc + m.reviews, 0);
  return {
    id: g.id,
    name: g.name,
    code: g.code,
    isOwner: g.owner_id === userId,
    weekReviews,
    weekGoal: SOCIAL.groupWeeklyReviewsPerMember * members.length,
    members: members.map((m) => ({ handle: m.handle, nickname: m.nickname, avatar: m.avatar, frame: m.frame, weekPoints: m.points, weekReviews: m.reviews, me: m.id === userId })),
    decks: decks.map((d) => ({ id: d.id, title: d.title, cardCount: d.cards, sharedBy: d.by, inLibrary: d.in_library === 1 })),
  };
}

export function shareDeckToGroup(db: Db, userId: number, now: number, groupId: number, deckId: number): void {
  if (!isMember(db, groupId, userId)) throw new HttpError(404, 'grupo não encontrado');
  const deck = getDeck(db, deckId);
  const readable = deck && (deck.is_public === 1 || deck.owner_id === userId || !!one(db, 'SELECT 1 AS x FROM library WHERE user_id = ? AND deck_id = ?', userId, deckId));
  if (!deck || !readable) throw new HttpError(404, 'baralho não encontrado');
  const { changes } = run(db, 'INSERT OR IGNORE INTO group_decks (group_id, deck_id, shared_by, at) VALUES (?, ?, ?, ?)', groupId, deckId, userId, now);
  if (changes === 0) return;
  const g = one<{ name: string }>(db, 'SELECT name FROM groups WHERE id = ?', groupId);
  logActivity(db, userId, 'deck_shared', { deckTitle: deck.title, groupName: g?.name }, now);
  if (deck.owner_id === userId && !alreadyGranted(db, userId, `share:${deckId}`)) grantPoints(db, userId, now, SOCIAL.shareReward, `share:${deckId}`);
}

// ---- study pair ---------------------------------------------------------------------------------------------------

function activePair(db: Db, userId: number) {
  return one<{ id: number; user_a: number; user_b: number; created_at: number }>(db, 'SELECT id, user_a, user_b, created_at FROM pairs WHERE ended_at IS NULL AND (user_a = ? OR user_b = ?)', userId, userId);
}

function todayProgress(db: Db, userId: number, now: number): { total: number; done: number } | null {
  const day = dayNumber(now);
  const st = one<{ queue_total: number }>(db, 'SELECT queue_total FROM daily_state WHERE user_id = ? AND day = ?', userId, day);
  if (!st) return null;
  const done = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM daily_queue WHERE user_id = ? AND day = ? AND done = 1', userId, day)?.n ?? 0;
  return { total: st.queue_total, done };
}

export function createPairInvite(db: Db, userId: number, now: number): { code: string } {
  if (activePair(db, userId)) throw new HttpError(400, 'você já tem uma dupla');
  return tx(db, () => {
    run(db, 'DELETE FROM pair_invites WHERE user_id = ?', userId);
    let code = randomInviteCode();
    while (one(db, 'SELECT 1 AS x FROM pair_invites WHERE code = ?', code)) code = randomInviteCode();
    run(db, 'INSERT INTO pair_invites (code, user_id, created_at) VALUES (?, ?, ?)', code, userId, now);
    return { code };
  });
}

export function acceptPairInvite(db: Db, userId: number, now: number, codeIn: unknown): void {
  const code = typeof codeIn === 'string' ? codeIn.trim().toUpperCase() : '';
  const inv = one<{ user_id: number; created_at: number }>(db, 'SELECT user_id, created_at FROM pair_invites WHERE code = ?', code);
  if (!inv || now - inv.created_at > INVITE_TTL_MS) throw new HttpError(404, 'convite não encontrado ou vencido');
  if (inv.user_id === userId) throw new HttpError(400, 'você não pode aceitar o próprio convite');
  if (activePair(db, userId) || activePair(db, inv.user_id)) throw new HttpError(400, 'uma das pessoas já tem dupla');
  tx(db, () => {
    run(db, 'INSERT INTO pairs (user_a, user_b, created_at) VALUES (?, ?, ?)', inv.user_id, userId, now);
    run(db, 'DELETE FROM pair_invites WHERE code = ?', code);
    logActivity(db, inv.user_id, 'pair_formed', {}, now);
    logActivity(db, userId, 'pair_formed', {}, now);
  });
}

export function endPair(db: Db, userId: number, now: number): void {
  const p = activePair(db, userId);
  if (!p) throw new HttpError(404, 'você não tem dupla');
  run(db, 'UPDATE pairs SET ended_at = ? WHERE id = ?', now, p.id);
}

export function getPair(db: Db, userId: number, now: number) {
  const p = activePair(db, userId);
  const invite = one<{ code: string; created_at: number }>(db, 'SELECT code, created_at FROM pair_invites WHERE user_id = ?', userId);
  const pendingInvite = invite && now - invite.created_at <= INVITE_TTL_MS ? invite.code : null;
  if (!p) return { pair: null, pendingInvite };
  const partnerId = p.user_a === userId ? p.user_b : p.user_a;
  const mine = todayProgress(db, userId, now);
  const theirs = todayProgress(db, partnerId, now);
  const complete = (x: { total: number; done: number } | null) => !!x && x.total > 0 && x.done === x.total;
  const bonusToday = !!one(db, 'SELECT 1 AS x FROM pair_bonus WHERE pair_id = ? AND day = ?', p.id, dayNumber(now));
  return {
    pair: { partner: publicUser(db, partnerId), partnerToday: theirs, myToday: mine, bothDone: complete(mine) && complete(theirs), bonusToday, bonusPoints: SOCIAL.pairDailyBonus, since: p.created_at },
    pendingInvite,
  };
}

/** If both partners finished today's queue, pays the daily pair bonus (once per day) to both. Returns what I received. */
export function checkPairBonus(db: Db, userId: number, now: number): number {
  const p = activePair(db, userId);
  if (!p) return 0;
  const day = dayNumber(now);
  if (one(db, 'SELECT 1 AS x FROM pair_bonus WHERE pair_id = ? AND day = ?', p.id, day)) return 0;
  const a = todayProgress(db, p.user_a, now);
  const b = todayProgress(db, p.user_b, now);
  const complete = (x: { total: number; done: number } | null) => !!x && x.total > 0 && x.done === x.total;
  if (!complete(a) || !complete(b)) return 0;
  run(db, 'INSERT INTO pair_bonus (pair_id, day) VALUES (?, ?)', p.id, day);
  for (const id of [p.user_a, p.user_b]) {
    grantPoints(db, id, now, SOCIAL.pairDailyBonus, `pair:${p.id}:${day}`);
    logActivity(db, id, 'pair_goal', {}, now);
  }
  return SOCIAL.pairDailyBonus;
}

// ---- connections, gifts and feed ------------------------------------------------------------------------------

/** People I can see in the feed and send gifts to: members of my groups and my study partner. */
export function connectionIds(db: Db, userId: number): number[] {
  const rows = all<{ id: number }>(
    db,
    `SELECT DISTINCT m2.user_id AS id FROM group_members m1 JOIN group_members m2 ON m1.group_id = m2.group_id WHERE m1.user_id = ? AND m2.user_id <> ?`,
    userId,
    userId,
  );
  const ids = new Set(rows.map((r) => r.id));
  const p = activePair(db, userId);
  if (p) ids.add(p.user_a === userId ? p.user_b : p.user_a);
  return [...ids];
}

export function connections(db: Db, userId: number): PublicUser[] {
  return connectionIds(db, userId).map((id) => publicUser(db, id)).sort((a, b) => a.nickname.localeCompare(b.nickname));
}

function giftsSentToday(db: Db, userId: number, now: number): number {
  return one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM gifts WHERE from_id = ? AND day = ?', userId, dayNumber(now))?.n ?? 0;
}

export function giftInfo(db: Db, userId: number, now: number) {
  const ws = weekStartDay(dayNumber(now));
  const received = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM gifts WHERE to_id = ? AND day >= ?', userId, ws)?.n ?? 0;
  const sent = giftsSentToday(db, userId, now);
  return { sentToday: sent, remainingToday: Math.max(0, SOCIAL.giftsPerDay - sent), receivedThisWeek: received, giftPoints: SOCIAL.giftPoints };
}

export function sendGift(db: Db, userId: number, now: number, handleIn: unknown) {
  const handle = typeof handleIn === 'string' ? handleIn : '';
  const to = one<{ id: number; nickname: string }>(db, 'SELECT id, nickname FROM users WHERE handle = ?', handle);
  if (!to || to.id === userId) throw new HttpError(400, 'escolha um colega para presentear');
  if (!connectionIds(db, userId).includes(to.id)) throw new HttpError(403, 'você só pode presentear quem está nos seus grupos ou na sua dupla');
  if (giftsSentToday(db, userId, now) >= SOCIAL.giftsPerDay) throw new HttpError(429, `no máximo ${SOCIAL.giftsPerDay} presentes por dia`);
  tx(db, () => {
    run(db, 'INSERT INTO gifts (from_id, to_id, at, day) VALUES (?, ?, ?, ?)', userId, to.id, now, dayNumber(now));
    grantPoints(db, to.id, now, SOCIAL.giftPoints, 'gift');
    logActivity(db, userId, 'gift', { toNickname: to.nickname, toHandle: handle }, now);
  });
  return giftInfo(db, userId, now);
}

export function feed(db: Db, userId: number, now: number) {
  const ids = connectionIds(db, userId);
  const me = one<{ handle: string }>(db, 'SELECT handle FROM users WHERE id = ?', userId)!;
  const since = now - 14 * DAY_MS;
  const marks = ids.map(() => '?').join(',') || 'NULL';
  const rows = all<{ id: number; user_id: number; type: string; payload: string; at: number }>(
    db,
    `SELECT id, user_id, type, payload, at FROM activity
      WHERE at >= ? AND user_id <> ?
        AND (user_id IN (${marks}) OR (type = 'gift' AND json_extract(payload, '$.toHandle') = ?))
      ORDER BY at DESC, id DESC LIMIT 30`,
    since,
    userId,
    ...ids,
    me.handle,
  );
  return rows.map((r) => {
    const payload = JSON.parse(r.payload) as Record<string, unknown>;
    return { id: r.id, at: r.at, user: publicUser(db, r.user_id), type: r.type, payload: { ...payload, toHandle: undefined }, toMe: r.type === 'gift' && payload.toHandle === me.handle };
  });
}

// ---- sharing and impact ----------------------------------------------------------------------------------------

/** First time a deck becomes public: small reward and a feed item. */
export function onDeckPublished(db: Db, userId: number, now: number, deckId: number): void {
  const deck = getDeck(db, deckId);
  if (!deck || deck.owner_id !== userId) return;
  if (alreadyGranted(db, userId, `share:${deckId}`)) return;
  grantPoints(db, userId, now, SOCIAL.shareReward, `share:${deckId}`);
  logActivity(db, userId, 'deck_shared', { deckTitle: deck.title }, now);
}

/** Someone added (or remixed) one of my decks: a small, once-per-person reward for the author. */
export function onDeckAdopted(db: Db, adopterId: number, now: number, deckId: number): void {
  const deck = getDeck(db, deckId);
  if (!deck || deck.owner_id === null || deck.owner_id === adopterId) return;
  const reason = `adopted:${deckId}:${adopterId}`;
  if (alreadyGranted(db, deck.owner_id, reason)) return;
  grantPoints(db, deck.owner_id, now, SOCIAL.adoptedReward, reason);
}

export function impact(db: Db, userId: number) {
  const n = (sql: string, ...p: number[]) => one<{ n: number }>(db, sql, ...p)?.n ?? 0;
  return {
    adopters: n('SELECT COUNT(DISTINCT l.user_id) AS n FROM library l JOIN decks d ON d.id = l.deck_id WHERE d.owner_id = ? AND l.user_id <> ?', userId, userId),
    remixers: n('SELECT COUNT(DISTINCT d2.owner_id) AS n FROM decks d2 JOIN decks d ON d.id = d2.source_deck_id WHERE d.owner_id = ? AND d2.owner_id <> ?', userId, userId),
    helpfulAnswers: n('SELECT COUNT(*) AS n FROM answers a JOIN questions q ON q.helpful_answer_id = a.id WHERE a.user_id = ?', userId),
    giftsSent: n('SELECT COUNT(*) AS n FROM gifts WHERE from_id = ?', userId),
    giftsReceived: n('SELECT COUNT(*) AS n FROM gifts WHERE to_id = ?', userId),
    suggestionsAccepted: n("SELECT COUNT(*) AS n FROM edit_suggestions WHERE user_id = ? AND status = 'accepted'", userId),
    sharedDecks: n('SELECT COUNT(*) AS n FROM decks WHERE owner_id = ? AND is_public = 1', userId),
  };
}

/** Counters used by the achievements of slice 2. */
export function socialStats(db: Db, userId: number) {
  const n = (sql: string, ...p: number[]) => one<{ n: number }>(db, sql, ...p)?.n ?? 0;
  return {
    groupsJoined: n('SELECT COUNT(*) AS n FROM group_members WHERE user_id = ?', userId),
    pairsFormed: n('SELECT COUNT(*) AS n FROM pairs WHERE user_a = ? OR user_b = ?', userId, userId),
    decksShared: n('SELECT (SELECT COUNT(*) FROM decks WHERE owner_id = ? AND is_public = 1) + (SELECT COUNT(DISTINCT gd.deck_id) FROM group_decks gd JOIN decks d ON d.id = gd.deck_id WHERE gd.shared_by = ? AND d.is_public = 0) AS n', userId, userId),
    helpfulAnswers: n('SELECT COUNT(*) AS n FROM answers a JOIN questions q ON q.helpful_answer_id = a.id WHERE a.user_id = ?', userId),
    giftsSent: n('SELECT COUNT(*) AS n FROM gifts WHERE from_id = ?', userId),
    votesCast: n('SELECT COUNT(*) AS n FROM votes WHERE user_id = ?', userId),
    suggestionsAccepted: n("SELECT COUNT(*) AS n FROM edit_suggestions WHERE user_id = ? AND status = 'accepted'", userId),
    questionsAsked: n('SELECT COUNT(*) AS n FROM questions WHERE user_id = ?', userId),
  };
}
