// Philanthropist and Disruptor elements that involve text from users: questions and answers, ideas to vote on,
// and suggestions of edits to other people's cards. Light moderation: length limits, daily caps, and
// content hidden after several distinct reports.
import { all, one, run, tx } from './db.ts';
import type { Db } from './db.ts';
import { SOCIAL } from './gamification.ts';
import { HttpError, getDeck } from './library.ts';
import { grantPoints, logActivity } from './points.ts';
import { dayNumber } from './time.ts';
import { publicUser } from './social.ts';
import type { PublicUser } from './social.ts';

function text(s: unknown, max: number, field: string, required = true): string {
  if (s === undefined || s === null || s === '') {
    if (required) throw new HttpError(400, `${field} não pode ficar vazio`);
    return '';
  }
  if (typeof s !== 'string') throw new HttpError(400, `${field} deve ser texto`);
  const t = s.trim();
  if (t.length === 0 && required) throw new HttpError(400, `${field} não pode ficar vazio`);
  if (t.length > max) throw new HttpError(400, `${field} passa de ${max} caracteres`);
  return t;
}

function canReadDeck(db: Db, userId: number, deckId: number): boolean {
  const d = getDeck(db, deckId);
  return !!d && (d.is_public === 1 || d.owner_id === userId || !!one(db, 'SELECT 1 AS x FROM library WHERE user_id = ? AND deck_id = ?', userId, deckId));
}

function reportCount(db: Db, kind: 'question' | 'answer', id: number): number {
  return one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM reports WHERE kind = ? AND target_id = ?', kind, id)?.n ?? 0;
}
const hidden = (db: Db, kind: 'question' | 'answer', id: number) => reportCount(db, kind, id) >= SOCIAL.reportsToHide;

// ---- questions and answers (answer_peers) -------------------------------------------------------------------------

interface QuestionRow {
  id: number;
  deck_id: number;
  card_id: number | null;
  user_id: number;
  text: string;
  created_at: number;
  helpful_answer_id: number | null;
}

function questionView(db: Db, viewerId: number, q: QuestionRow) {
  const deck = getDeck(db, q.deck_id);
  const card = q.card_id ? one<{ front: string }>(db, 'SELECT front FROM cards WHERE id = ?', q.card_id) : undefined;
  const answers = all<{ id: number; user_id: number; text: string; created_at: number }>(db, 'SELECT id, user_id, text, created_at FROM answers WHERE question_id = ? ORDER BY id', q.id)
    .filter((a) => !hidden(db, 'answer', a.id))
    .map((a) => ({ id: a.id, text: a.text, at: a.created_at, user: publicUser(db, a.user_id), helpful: q.helpful_answer_id === a.id, mine: a.user_id === viewerId }));
  return {
    id: q.id,
    deckId: q.deck_id,
    deckTitle: deck?.title ?? '',
    cardFront: card?.front ?? null,
    text: q.text,
    at: q.created_at,
    user: publicUser(db, q.user_id),
    mine: q.user_id === viewerId,
    answered: q.helpful_answer_id !== null,
    answers,
  };
}

export function askQuestion(db: Db, userId: number, now: number, input: { deckId?: unknown; cardId?: unknown; text?: unknown }) {
  const deckId = Number(input.deckId);
  if (!Number.isInteger(deckId) || !canReadDeck(db, userId, deckId)) throw new HttpError(404, 'baralho não encontrado');
  let cardId: number | null = null;
  if (input.cardId !== undefined && input.cardId !== null) {
    cardId = Number(input.cardId);
    if (!one(db, 'SELECT 1 AS x FROM cards WHERE id = ? AND deck_id = ?', cardId, deckId)) throw new HttpError(400, 'cartão não pertence ao baralho');
  }
  const body = text(input.text, SOCIAL.textMax, 'pergunta');
  const today = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM questions WHERE user_id = ? AND created_at >= ?', userId, dayNumber(now) * 86_400_000 + 180 * 60_000)?.n ?? 0;
  if (today >= SOCIAL.questionsPerDay) throw new HttpError(429, `no máximo ${SOCIAL.questionsPerDay} perguntas por dia`);
  const { id } = run(db, 'INSERT INTO questions (deck_id, card_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)', deckId, cardId, userId, body, now);
  return { id };
}

/** scope "open": questions from others without a helpful answer, in decks I can read. "mine": my own questions. */
export function listQuestions(db: Db, userId: number, scope: string, deckId?: number) {
  let rows: QuestionRow[];
  if (scope === 'mine') {
    rows = all<QuestionRow>(db, 'SELECT * FROM questions WHERE user_id = ? ORDER BY id DESC LIMIT 30', userId);
  } else {
    rows = all<QuestionRow>(
      db,
      `SELECT q.* FROM questions q JOIN decks d ON d.id = q.deck_id
        WHERE q.user_id <> ? AND q.helpful_answer_id IS NULL
          AND (d.is_public = 1 OR d.owner_id = ? OR EXISTS(SELECT 1 FROM library l WHERE l.user_id = ? AND l.deck_id = d.id))
          ${deckId ? 'AND q.deck_id = ?' : ''}
        ORDER BY q.id DESC LIMIT 60`,
      userId,
      userId,
      userId,
      ...(deckId ? [deckId] : []),
    );
    rows = rows.filter((q) => !hidden(db, 'question', q.id)).slice(0, 20);
  }
  return rows.map((q) => questionView(db, userId, q));
}

export function getQuestion(db: Db, userId: number, id: number) {
  const q = one<QuestionRow>(db, 'SELECT * FROM questions WHERE id = ?', id);
  if (!q || !canReadDeck(db, userId, q.deck_id) || (hidden(db, 'question', id) && q.user_id !== userId)) throw new HttpError(404, 'pergunta não encontrada');
  return questionView(db, userId, q);
}

export function answerQuestion(db: Db, userId: number, now: number, questionId: number, textIn: unknown) {
  const q = one<QuestionRow>(db, 'SELECT * FROM questions WHERE id = ?', questionId);
  if (!q || !canReadDeck(db, userId, q.deck_id)) throw new HttpError(404, 'pergunta não encontrada');
  if (q.user_id === userId) throw new HttpError(400, 'você não pode responder à própria pergunta');
  if (q.helpful_answer_id !== null) throw new HttpError(400, 'esta pergunta já foi respondida');
  const body = text(textIn, SOCIAL.textMax, 'resposta');
  const today = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM answers WHERE user_id = ? AND created_at >= ?', userId, dayNumber(now) * 86_400_000 + 180 * 60_000)?.n ?? 0;
  if (today >= SOCIAL.answersPerDay) throw new HttpError(429, `no máximo ${SOCIAL.answersPerDay} respostas por dia`);
  const { id } = run(db, 'INSERT INTO answers (question_id, user_id, text, created_at) VALUES (?, ?, ?, ?)', questionId, userId, body, now);
  return { id };
}

/** Only the person who asked can mark an answer as helpful; the author of the answer gets points. */
export function markHelpful(db: Db, userId: number, now: number, answerId: number) {
  const a = one<{ id: number; user_id: number; question_id: number }>(db, 'SELECT id, user_id, question_id FROM answers WHERE id = ?', answerId);
  const q = a ? one<QuestionRow>(db, 'SELECT * FROM questions WHERE id = ?', a.question_id) : undefined;
  if (!a || !q || q.user_id !== userId) throw new HttpError(404, 'resposta não encontrada');
  if (q.helpful_answer_id !== null) throw new HttpError(400, 'você já marcou uma resposta como útil');
  tx(db, () => {
    run(db, 'UPDATE questions SET helpful_answer_id = ? WHERE id = ?', a.id, q.id);
    grantPoints(db, a.user_id, now, SOCIAL.helpfulReward, `helpful:${a.id}`);
    logActivity(db, a.user_id, 'helpful_answer', {}, now);
  });
  return { answererPoints: SOCIAL.helpfulReward, answererId: a.user_id };
}

export function report(db: Db, userId: number, now: number, kind: unknown, id: unknown) {
  if (kind !== 'question' && kind !== 'answer') throw new HttpError(400, 'tipo inválido');
  const n = Number(id);
  const exists = kind === 'question' ? one(db, 'SELECT 1 AS x FROM questions WHERE id = ?', n) : one(db, 'SELECT 1 AS x FROM answers WHERE id = ?', n);
  if (!exists) throw new HttpError(404, 'conteúdo não encontrado');
  run(db, 'INSERT OR IGNORE INTO reports (user_id, kind, target_id, at) VALUES (?, ?, ?, ?)', userId, kind, n, now);
  return { reports: reportCount(db, kind, n) };
}

// ---- ideas to vote on (vote_features) -------------------------------------------------------------------------------

export function listProposals(db: Db, userId: number) {
  const used = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM votes WHERE user_id = ?', userId)?.n ?? 0;
  const rows = all<{ id: number; title: string; description: string; created_by: number | null; votes: number; mine: number }>(
    db,
    `SELECT p.id, p.title, p.description, p.created_by,
            (SELECT COUNT(*) FROM votes v WHERE v.proposal_id = p.id) AS votes,
            EXISTS(SELECT 1 FROM votes v WHERE v.proposal_id = p.id AND v.user_id = ?) AS mine
       FROM proposals p ORDER BY votes DESC, p.id`,
    userId,
  );
  return { votesLeft: Math.max(0, SOCIAL.maxVotes - used), maxVotes: SOCIAL.maxVotes, proposals: rows.map((r) => ({ id: r.id, title: r.title, description: r.description, votes: r.votes, voted: r.mine === 1, mine: r.created_by === userId })) };
}

export function addProposal(db: Db, userId: number, now: number, input: { title?: unknown; description?: unknown }) {
  const title = text(input.title, 80, 'título');
  const description = text(input.description, SOCIAL.textMax, 'descrição', false);
  const today = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM proposals WHERE created_by = ? AND created_at >= ?', userId, dayNumber(now) * 86_400_000 + 180 * 60_000)?.n ?? 0;
  if (today >= 3) throw new HttpError(429, 'no máximo 3 ideias por dia');
  const { id } = run(db, 'INSERT INTO proposals (title, description, created_by, created_at) VALUES (?, ?, ?, ?)', title, description, userId, now);
  return { id };
}

export function toggleVote(db: Db, userId: number, now: number, proposalId: number) {
  if (!one(db, 'SELECT 1 AS x FROM proposals WHERE id = ?', proposalId)) throw new HttpError(404, 'ideia não encontrada');
  const has = one(db, 'SELECT 1 AS x FROM votes WHERE user_id = ? AND proposal_id = ?', userId, proposalId);
  if (has) {
    run(db, 'DELETE FROM votes WHERE user_id = ? AND proposal_id = ?', userId, proposalId);
    return { voted: false };
  }
  const used = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM votes WHERE user_id = ?', userId)?.n ?? 0;
  if (used >= SOCIAL.maxVotes) throw new HttpError(400, `você já usou seus ${SOCIAL.maxVotes} votos; remova um para votar em outra ideia`);
  run(db, 'INSERT INTO votes (user_id, proposal_id, at) VALUES (?, ?, ?)', userId, proposalId, now);
  return { voted: true };
}

// ---- edit suggestions (suggest_edits) ---------------------------------------------------------------------------------

export function suggestEdit(db: Db, userId: number, now: number, cardId: number, input: { front?: unknown; back?: unknown; note?: unknown }) {
  const card = one<{ id: number; deck_id: number; front: string; back: string }>(db, 'SELECT id, deck_id, front, back FROM cards WHERE id = ?', cardId);
  const deck = card ? getDeck(db, card.deck_id) : undefined;
  if (!card || !deck || !canReadDeck(db, userId, deck.id)) throw new HttpError(404, 'cartão não encontrado');
  if (deck.owner_id === userId) throw new HttpError(400, 'o baralho é seu: edite o cartão diretamente');
  const front = input.front === undefined ? null : text(input.front, SOCIAL.textMax, 'frente');
  const back = input.back === undefined ? null : text(input.back, SOCIAL.textMax, 'verso');
  if ((front === null || front === card.front) && (back === null || back === card.back)) throw new HttpError(400, 'a sugestão não muda nada no cartão');
  const note = text(input.note, 300, 'comentário', false);
  if (one(db, "SELECT 1 AS x FROM edit_suggestions WHERE card_id = ? AND user_id = ? AND status = 'pending'", cardId, userId)) throw new HttpError(400, 'você já tem uma sugestão pendente para este cartão');
  const pending = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM edit_suggestions WHERE user_id = ? AND status = 'pending'", userId)?.n ?? 0;
  if (pending >= 10) throw new HttpError(429, 'você já tem 10 sugestões pendentes');
  const { id } = run(db, 'INSERT INTO edit_suggestions (card_id, user_id, new_front, new_back, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', cardId, userId, front, back, note, now);
  return { id, toTeam: deck.owner_id === null };
}

export interface SuggestionView {
  id: number;
  cardId: number;
  deckId: number;
  deckTitle: string;
  currentFront: string;
  currentBack: string;
  newFront: string | null;
  newBack: string | null;
  note: string;
  status: string;
  at: number;
  user: PublicUser;
}

function suggestionRows(db: Db, where: string, ...params: (number | string)[]): SuggestionView[] {
  return all<{ id: number; card_id: number; deck_id: number; title: string; front: string; back: string; new_front: string | null; new_back: string | null; note: string; status: string; created_at: number; user_id: number }>(
    db,
    `SELECT s.id, s.card_id, c.deck_id, d.title, c.front, c.back, s.new_front, s.new_back, s.note, s.status, s.created_at, s.user_id
       FROM edit_suggestions s JOIN cards c ON c.id = s.card_id JOIN decks d ON d.id = c.deck_id
      WHERE ${where} ORDER BY s.id DESC LIMIT 50`,
    ...params,
  ).map((r) => ({ id: r.id, cardId: r.card_id, deckId: r.deck_id, deckTitle: r.title, currentFront: r.front, currentBack: r.back, newFront: r.new_front, newBack: r.new_back, note: r.note, status: r.status, at: r.created_at, user: publicUser(db, r.user_id) }));
}

export function pendingForDeck(db: Db, userId: number, deckId: number) {
  const deck = getDeck(db, deckId);
  if (!deck || deck.owner_id !== userId) throw new HttpError(404, 'baralho não encontrado');
  return suggestionRows(db, "c.deck_id = ? AND s.status = 'pending'", deckId);
}

export function mySuggestions(db: Db, userId: number) {
  return suggestionRows(db, 's.user_id = ?', userId);
}

/** decider = the deck owner, or null for the research team (admin CLI) on decks owned by the team. */
export function decideSuggestion(db: Db, decider: number | null, now: number, id: number, accept: boolean): { suggesterId: number } {
  const s = one<{ id: number; card_id: number; user_id: number; new_front: string | null; new_back: string | null; status: string }>(db, 'SELECT id, card_id, user_id, new_front, new_back, status FROM edit_suggestions WHERE id = ?', id);
  const owner = s ? one<{ owner_id: number | null; title: string }>(db, 'SELECT d.owner_id, d.title FROM cards c JOIN decks d ON d.id = c.deck_id WHERE c.id = ?', s.card_id) : undefined;
  if (!s || !owner) throw new HttpError(404, 'sugestão não encontrada');
  const allowed = decider === null ? owner.owner_id === null : owner.owner_id === decider;
  if (!allowed) throw new HttpError(404, 'sugestão não encontrada');
  if (s.status !== 'pending') throw new HttpError(400, 'esta sugestão já foi decidida');
  tx(db, () => {
    if (accept) {
      if (s.new_front !== null) run(db, 'UPDATE cards SET front = ? WHERE id = ?', s.new_front, s.card_id);
      if (s.new_back !== null) run(db, 'UPDATE cards SET back = ? WHERE id = ?', s.new_back, s.card_id);
      grantPoints(db, s.user_id, now, SOCIAL.suggestionReward, `suggestion:${s.id}`);
      logActivity(db, s.user_id, 'suggestion_accepted', { deckTitle: owner.title }, now);
    }
    run(db, 'UPDATE edit_suggestions SET status = ?, decided_at = ? WHERE id = ?', accept ? 'accepted' : 'rejected', now, s.id);
  });
  return { suggesterId: s.user_id };
}

export function pendingForTeam(db: Db) {
  return suggestionRows(db, "s.status = 'pending' AND d.owner_id IS NULL");
}
