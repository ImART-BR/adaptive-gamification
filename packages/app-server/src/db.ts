import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { randomHandle } from './ids.ts';

export type Db = DatabaseSync;
export type Param = SQLInputValue;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  handle TEXT,
  code TEXT NOT NULL UNIQUE,
  pass_hash TEXT,
  nickname TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '🐕',
  theme TEXT NOT NULL DEFAULT 'padrao',
  frame TEXT NOT NULL DEFAULT 'nenhuma',
  created_at INTEGER NOT NULL,
  consented_at INTEGER,
  consent_version TEXT,
  grp TEXT
);
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  started_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, last_seen);
CREATE TABLE IF NOT EXISTS decks (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_public INTEGER NOT NULL DEFAULT 0,
  source_deck_id INTEGER REFERENCES decks(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck_id);
CREATE TABLE IF NOT EXISTS library (
  user_id INTEGER NOT NULL REFERENCES users(id),
  deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, deck_id)
);
CREATE TABLE IF NOT EXISTS card_state (
  user_id INTEGER NOT NULL REFERENCES users(id),
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  ease REAL NOT NULL,
  interval INTEGER NOT NULL,
  due INTEGER NOT NULL,
  reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL,
  phase TEXT NOT NULL,
  last_review INTEGER,
  PRIMARY KEY (user_id, card_id)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  card_id INTEGER NOT NULL,
  deck_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  day INTEGER NOT NULL,
  grade INTEGER NOT NULL,
  prev_interval INTEGER NOT NULL,
  new_interval INTEGER NOT NULL,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_user_day ON reviews(user_id, day);
CREATE TABLE IF NOT EXISTS point_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  at INTEGER NOT NULL,
  day INTEGER NOT NULL,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_points_user ON point_events(user_id, day);
CREATE TABLE IF NOT EXISTS daily_state (
  user_id INTEGER NOT NULL REFERENCES users(id),
  day INTEGER NOT NULL,
  queue_total INTEGER NOT NULL,
  first_session_id TEXT,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS daily_queue (
  user_id INTEGER NOT NULL REFERENCES users(id),
  day INTEGER NOT NULL,
  card_id INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, card_id)
);
CREATE TABLE IF NOT EXISTS achievements (
  user_id INTEGER NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS challenge_claims (
  user_id INTEGER NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  day INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key, day)
);
CREATE TABLE IF NOT EXISTS paths (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS path_decks (
  path_id INTEGER NOT NULL REFERENCES paths(id),
  deck_id INTEGER NOT NULL REFERENCES decks(id),
  position INTEGER NOT NULL,
  PRIMARY KEY (path_id, deck_id)
);
-- Research event log. Server-stamped: userId, sessionId and "at" never come from the client.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  element_id TEXT,
  prominence REAL,
  kind TEXT,
  value REAL
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, session_id);

-- Slice 2: social and community elements ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS group_decks (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  deck_id INTEGER NOT NULL REFERENCES decks(id),
  shared_by INTEGER NOT NULL REFERENCES users(id),
  at INTEGER NOT NULL,
  PRIMARY KEY (group_id, deck_id)
);
CREATE TABLE IF NOT EXISTS pairs (
  id INTEGER PRIMARY KEY,
  user_a INTEGER NOT NULL REFERENCES users(id),
  user_b INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS pair_invites (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pair_bonus (
  pair_id INTEGER NOT NULL REFERENCES pairs(id),
  day INTEGER NOT NULL,
  PRIMARY KEY (pair_id, day)
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_at ON activity(at);
CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES users(id),
  to_id INTEGER NOT NULL REFERENCES users(id),
  at INTEGER NOT NULL,
  day INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL REFERENCES decks(id),
  card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  helpful_answer_id INTEGER
);
CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, target_id)
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  user_id INTEGER NOT NULL REFERENCES users(id),
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, proposal_id)
);
-- experiment (adaptive x control) -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rand_blocks (
  idx INTEGER PRIMARY KEY,
  grp TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS engine_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- The weights each user had on each study day (adaptive: from the core; control: uniform). One row per user-day.
-- weights = what the interface applied. raw = the core's own decision and shrink = the soft-start factor k that was
-- applied to it (adaptive users only; NULL for control).
CREATE TABLE IF NOT EXISTS day_weights (
  user_id INTEGER NOT NULL REFERENCES users(id),
  day INTEGER NOT NULL,
  weights TEXT NOT NULL,
  raw TEXT,
  shrink REAL,
  PRIMARY KEY (user_id, day)
);
-- Days already sent to the engine (sent = 0 when the day had no usable data and was skipped).
CREATE TABLE IF NOT EXISTS engine_days (
  user_id INTEGER NOT NULL REFERENCES users(id),
  day INTEGER NOT NULL,
  sent INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
-- Profile estimate after each settled day, for the experiment's secondary metrics (evolution and stability).
CREATE TABLE IF NOT EXISTS profile_log (
  user_id INTEGER NOT NULL REFERENCES users(id),
  day INTEGER NOT NULL,
  profile TEXT NOT NULL,
  uncertainty TEXT NOT NULL,
  level REAL NOT NULL,
  sessions_observed INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS edit_suggestions (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  new_front TEXT,
  new_back TEXT,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
`;

/** Brings a database created by an older version up to date (additive changes only). */
function migrate(db: Db): void {
  const cols = all<{ name: string }>(db, 'PRAGMA table_info(users)').map((c) => c.name);
  if (!cols.includes('handle')) db.exec('ALTER TABLE users ADD COLUMN handle TEXT');
  for (const u of all<{ id: number }>(db, 'SELECT id FROM users WHERE handle IS NULL')) {
    let handle = randomHandle();
    while (one(db, 'SELECT 1 AS x FROM users WHERE handle = ?', handle)) handle = randomHandle();
    run(db, 'UPDATE users SET handle = ? WHERE id = ?', handle, u.id);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users(handle)');
  const dw = all<{ name: string }>(db, 'PRAGMA table_info(day_weights)').map((c) => c.name);
  if (!dw.includes('raw')) db.exec('ALTER TABLE day_weights ADD COLUMN raw TEXT');
  if (!dw.includes('shrink')) db.exec('ALTER TABLE day_weights ADD COLUMN shrink REAL');
}

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export function one<T>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: Db, sql: string, ...params: Param[]): { changes: number; id: number } {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
