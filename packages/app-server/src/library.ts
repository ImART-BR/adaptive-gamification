// Decks, cards, library, catalog and learning paths.
import { all, one, run, tx } from './db.ts';
import type { Db } from './db.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DeckRow {
  id: number;
  owner_id: number | null;
  title: string;
  description: string;
  is_public: number;
  source_deck_id: number | null;
  created_at: number;
}

export interface CardRow {
  id: number;
  deck_id: number;
  front: string;
  back: string;
}

const MAX_TITLE = 120;
const MAX_TEXT = 2000;

function clean(s: unknown, max: number, field: string): string {
  if (typeof s !== 'string') throw new HttpError(400, `${field} deve ser texto`);
  const t = s.trim();
  if (t.length === 0) throw new HttpError(400, `${field} não pode ficar vazio`);
  if (t.length > max) throw new HttpError(400, `${field} passa de ${max} caracteres`);
  return t;
}

export function getDeck(db: Db, deckId: number): DeckRow | undefined {
  return one<DeckRow>(db, 'SELECT * FROM decks WHERE id = ?', deckId);
}

/** Readable if public, owned, or already in the user's library (a deck hidden by its owner stays available to followers). */
function canRead(db: Db, deck: DeckRow, userId: number): boolean {
  return deck.is_public === 1 || deck.owner_id === userId || !!one(db, 'SELECT 1 AS x FROM library WHERE user_id = ? AND deck_id = ?', userId, deck.id);
}

export function createDeck(db: Db, userId: number, now: number, input: { title: unknown; description?: unknown; isPublic?: unknown }): DeckRow {
  const title = clean(input.title, MAX_TITLE, 'título');
  const description = input.description === undefined || input.description === '' ? '' : clean(input.description, MAX_TEXT, 'descrição');
  return tx(db, () => {
    const { id } = run(db, 'INSERT INTO decks (owner_id, title, description, is_public, created_at) VALUES (?, ?, ?, ?, ?)', userId, title, description, input.isPublic ? 1 : 0, now);
    run(db, 'INSERT INTO library (user_id, deck_id, added_at) VALUES (?, ?, ?)', userId, id, now);
    return getDeck(db, id) as DeckRow;
  });
}

export function updateDeck(db: Db, userId: number, deckId: number, input: { title?: unknown; description?: unknown; isPublic?: unknown }): DeckRow {
  const deck = getDeck(db, deckId);
  if (!deck || deck.owner_id !== userId) throw new HttpError(404, 'baralho não encontrado');
  const title = input.title === undefined ? deck.title : clean(input.title, MAX_TITLE, 'título');
  const description = input.description === undefined ? deck.description : input.description === '' ? '' : clean(input.description, MAX_TEXT, 'descrição');
  const isPublic = input.isPublic === undefined ? deck.is_public : input.isPublic ? 1 : 0;
  run(db, 'UPDATE decks SET title = ?, description = ?, is_public = ? WHERE id = ?', title, description, isPublic, deckId);
  return getDeck(db, deckId) as DeckRow;
}

export function deleteDeck(db: Db, userId: number, deckId: number): void {
  const deck = getDeck(db, deckId);
  if (!deck || deck.owner_id !== userId) throw new HttpError(404, 'baralho não encontrado');
  // Other users may have it in their library: a deck with followers is hidden from the catalog instead of removed.
  const followers = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM library WHERE deck_id = ? AND user_id <> ?', deckId, userId)?.n ?? 0;
  if (followers > 0) {
    run(db, 'UPDATE decks SET is_public = 0 WHERE id = ?', deckId);
    run(db, 'DELETE FROM library WHERE deck_id = ? AND user_id = ?', deckId, userId);
    return;
  }
  tx(db, () => {
    run(db, 'DELETE FROM card_state WHERE card_id IN (SELECT id FROM cards WHERE deck_id = ?)', deckId);
    run(db, 'DELETE FROM daily_queue WHERE card_id IN (SELECT id FROM cards WHERE deck_id = ?)', deckId);
    run(db, 'DELETE FROM path_decks WHERE deck_id = ?', deckId);
    run(db, 'DELETE FROM library WHERE deck_id = ?', deckId);
    run(db, 'DELETE FROM cards WHERE deck_id = ?', deckId);
    run(db, 'DELETE FROM decks WHERE id = ?', deckId);
  });
}

export function addCard(db: Db, userId: number, now: number, deckId: number, input: { front: unknown; back: unknown }): CardRow {
  const deck = getDeck(db, deckId);
  if (!deck || deck.owner_id !== userId) throw new HttpError(404, 'baralho não encontrado');
  const front = clean(input.front, MAX_TEXT, 'frente');
  const back = clean(input.back, MAX_TEXT, 'verso');
  const { id } = run(db, 'INSERT INTO cards (deck_id, front, back, created_at) VALUES (?, ?, ?, ?)', deckId, front, back, now);
  return one<CardRow>(db, 'SELECT id, deck_id, front, back FROM cards WHERE id = ?', id) as CardRow;
}

export function updateCard(db: Db, userId: number, cardId: number, input: { front?: unknown; back?: unknown }): CardRow {
  const card = one<CardRow & { owner_id: number | null }>(db, 'SELECT c.id, c.deck_id, c.front, c.back, d.owner_id FROM cards c JOIN decks d ON d.id = c.deck_id WHERE c.id = ?', cardId);
  if (!card || card.owner_id !== userId) throw new HttpError(404, 'cartão não encontrado');
  const front = input.front === undefined ? card.front : clean(input.front, MAX_TEXT, 'frente');
  const back = input.back === undefined ? card.back : clean(input.back, MAX_TEXT, 'verso');
  run(db, 'UPDATE cards SET front = ?, back = ? WHERE id = ?', front, back, cardId);
  return { id: cardId, deck_id: card.deck_id, front, back };
}

export function deleteCard(db: Db, userId: number, cardId: number): void {
  const card = one<{ owner_id: number | null }>(db, 'SELECT d.owner_id FROM cards c JOIN decks d ON d.id = c.deck_id WHERE c.id = ?', cardId);
  if (!card || card.owner_id !== userId) throw new HttpError(404, 'cartão não encontrado');
  tx(db, () => {
    run(db, 'DELETE FROM card_state WHERE card_id = ?', cardId);
    run(db, 'DELETE FROM daily_queue WHERE card_id = ?', cardId);
    run(db, 'DELETE FROM cards WHERE id = ?', cardId);
  });
}

export function deckWithCards(db: Db, userId: number, deckId: number) {
  const deck = getDeck(db, deckId);
  if (!deck || !canRead(db, deck, userId)) throw new HttpError(404, 'baralho não encontrado');
  const cards = all<CardRow>(db, 'SELECT id, deck_id, front, back FROM cards WHERE deck_id = ? ORDER BY id', deckId);
  const owner = deck.owner_id ? one<{ nickname: string }>(db, 'SELECT nickname FROM users WHERE id = ?', deck.owner_id)?.nickname ?? null : null;
  const inLibrary = !!one(db, 'SELECT 1 AS x FROM library WHERE user_id = ? AND deck_id = ?', userId, deckId);
  return { id: deck.id, title: deck.title, description: deck.description, isPublic: deck.is_public === 1, mine: deck.owner_id === userId, ownerNickname: owner, inLibrary, sourceDeckId: deck.source_deck_id, cards };
}

export function addToLibrary(db: Db, userId: number, now: number, deckId: number): void {
  const deck = getDeck(db, deckId);
  if (!deck || !canRead(db, deck, userId)) throw new HttpError(404, 'baralho não encontrado');
  run(db, 'INSERT OR IGNORE INTO library (user_id, deck_id, added_at) VALUES (?, ?, ?)', userId, deckId, now);
}

export function removeFromLibrary(db: Db, userId: number, deckId: number): void {
  const deck = getDeck(db, deckId);
  if (!deck) throw new HttpError(404, 'baralho não encontrado');
  if (deck.owner_id === userId) throw new HttpError(400, 'para remover um baralho seu, apague-o');
  run(db, 'DELETE FROM library WHERE user_id = ? AND deck_id = ?', userId, deckId);
}

/** Copies a readable deck (and its cards) into a new deck owned by the user, who can then edit it. */
export function remixDeck(db: Db, userId: number, now: number, deckId: number): DeckRow {
  const src = getDeck(db, deckId);
  if (!src || !canRead(db, src, userId)) throw new HttpError(404, 'baralho não encontrado');
  return tx(db, () => {
    const { id } = run(db, 'INSERT INTO decks (owner_id, title, description, is_public, source_deck_id, created_at) VALUES (?, ?, ?, 0, ?, ?)', userId, `${src.title} (meu remix)`.slice(0, MAX_TITLE), src.description, src.id, now);
    run(db, 'INSERT INTO cards (deck_id, front, back, created_at) SELECT ?, front, back, ? FROM cards WHERE deck_id = ? ORDER BY id', id, now, src.id);
    run(db, 'INSERT INTO library (user_id, deck_id, added_at) VALUES (?, ?, ?)', userId, id, now);
    return getDeck(db, id) as DeckRow;
  });
}

export function catalog(db: Db, userId: number, q?: string) {
  const like = q ? `%${q.replace(/[%_]/g, '')}%` : '%';
  return all<{ id: number; title: string; description: string; owner: string | null; card_count: number; in_library: number }>(
    db,
    `SELECT d.id, d.title, d.description, u.nickname AS owner,
            (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id) AS card_count,
            EXISTS(SELECT 1 FROM library l WHERE l.user_id = ? AND l.deck_id = d.id) AS in_library
       FROM decks d LEFT JOIN users u ON u.id = d.owner_id
      WHERE d.is_public = 1 AND (d.title LIKE ? OR d.description LIKE ?)
      ORDER BY d.created_at DESC, d.id DESC LIMIT 100`,
    userId,
    like,
    like,
  ).map((r) => ({ id: r.id, title: r.title, description: r.description, owner: r.owner, cardCount: r.card_count, inLibrary: r.in_library === 1 }));
}

export function paths(db: Db, userId: number) {
  const ps = all<{ id: number; key: string; title: string; description: string }>(db, 'SELECT id, key, title, description FROM paths ORDER BY id');
  return ps.map((p) => {
    const decks = all<{ id: number; title: string; in_library: number; total: number; mature: number }>(
      db,
      `SELECT d.id, d.title,
              EXISTS(SELECT 1 FROM library l WHERE l.user_id = ? AND l.deck_id = d.id) AS in_library,
              (SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id) AS total,
              (SELECT COUNT(*) FROM cards c JOIN card_state s ON s.card_id = c.id AND s.user_id = ? WHERE c.deck_id = d.id AND s.interval >= 21) AS mature
         FROM path_decks pd JOIN decks d ON d.id = pd.deck_id WHERE pd.path_id = ? ORDER BY pd.position`,
      userId,
      userId,
      p.id,
    ).map((d) => ({ id: d.id, title: d.title, inLibrary: d.in_library === 1, cardCount: d.total, masteryPct: d.total ? Math.round((100 * d.mature) / d.total) : 0 }));
    return { key: p.key, title: p.title, description: p.description, decks };
  });
}
