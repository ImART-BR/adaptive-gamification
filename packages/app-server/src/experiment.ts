// Connects the app to the adaptive core and runs the A/B experiment.
//
// - Each new user is randomly and permanently assigned to "adaptive" or "control" (permuted blocks of 4).
// - The unit of adaptation is the STUDY DAY: the interface weights are decided once, at the user's first visit of the
//   day (decided at the start of a session, never in the middle), and every visit that day shares them.
//   This matches the target behavior, which is defined per day (fraction of the day's queue finished).
// - Control users get fixed uniform weights; the same decision log is kept for both groups.
// - The core is fed with COMPLETE days: a day is sent the next time the user comes back.
import { applySoftStart, createEngine, softStartFactor } from '../../core/src/index.ts';
import type { AdaptiveEngine, AdaptiveEvent, EngineConfig, UserState } from '../../core/src/index.ts';
import { all, one, run, tx } from './db.ts';
import type { Db } from './db.ts';
import { CATALOG } from './spec.ts';
import { dayNumber } from './time.ts';

export type Group = 'adaptive' | 'control';

export interface ExperimentOptions {
  /** When false (the default), nobody is assigned a group, everyone is "control" and the core never runs. */
  enabled: boolean;
  /** Seed of the core's deterministic generator. */
  seed?: number;
  /** Extra core configuration (tests and later calibration). */
  engineConfig?: Partial<EngineConfig>;
  /**
   * Soft start: over a user's first `rampDays` decision days the core's weights are shrunk toward the
   * neutral weight (factor 0.25 on day 1, growing to 1). Default 7; 1 disables it.
   */
  rampDays?: number;
}

export interface Experiment {
  enabled: boolean;
  engine: AdaptiveEngine;
  rampDays: number;
}

export const DEFAULT_RAMP_DAYS = 7;

/** Weight every element has for control users: the neutral weight of the core (neutral = default). */
export const CONTROL_WEIGHT = 0.5;

export function createExperiment(options: ExperimentOptions): Experiment {
  const engine = createEngine({ schemaVersion: '0.1', catalog: CATALOG, seed: options.seed ?? 1, ...options.engineConfig });
  return { enabled: options.enabled, engine, rampDays: options.rampDays ?? DEFAULT_RAMP_DAYS };
}

const coreUserId = (userId: number) => `u${userId}`;

export function uniformWeights(): Record<string, number> {
  return Object.fromEntries(CATALOG.elements.map((e) => [e.id, CONTROL_WEIGHT]));
}

// ---- assignment ---------------------------------------------------------------------------------------------------------------

function shuffle<T>(items: T[], rand: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/** Permuted blocks of 4 (two adaptive, two control): groups stay balanced at every point of the enrolment. */
export function assignGroup(db: Db, rand: () => number = Math.random): Group {
  return tx(db, () => {
    const used = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM users WHERE grp IS NOT NULL')?.n ?? 0;
    let slot = one<{ grp: Group }>(db, 'SELECT grp FROM rand_blocks WHERE idx = ?', used);
    if (!slot) {
      const block = shuffle<Group>(['adaptive', 'adaptive', 'control', 'control'], rand);
      block.forEach((g, i) => run(db, 'INSERT OR IGNORE INTO rand_blocks (idx, grp) VALUES (?, ?)', used + i, g));
      slot = one<{ grp: Group }>(db, 'SELECT grp FROM rand_blocks WHERE idx = ?', used) as { grp: Group };
    }
    return slot.grp;
  });
}

// ---- engine state ---------------------------------------------------------------------------------------------------------------

function loadState(db: Db, exp: Experiment, userId: number): UserState {
  const row = one<{ state: string }>(db, 'SELECT state FROM engine_state WHERE user_id = ?', userId);
  return row ? (JSON.parse(row.state) as UserState) : exp.engine.neutralState(coreUserId(userId));
}

function saveState(db: Db, userId: number, state: UserState, now: number): void {
  run(
    db,
    'INSERT INTO engine_state (user_id, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at',
    userId,
    JSON.stringify(state),
    now,
  );
}

// ---- settling past days ---------------------------------------------------------------------------------------------------------

interface EventRow {
  type: 'exposure' | 'interaction';
  at: number;
  element_id: string;
  prominence: number | null;
}

/** Builds the core's input for one finished day, or null if the day cannot be used (no queue, nothing shown). */
function coreEventsForDay(db: Db, userId: number, day: number, rows: EventRow[]): AdaptiveEvent[] | null {
  const st = one<{ queue_total: number }>(db, 'SELECT queue_total FROM daily_state WHERE user_id = ? AND day = ?', userId, day);
  // A day without a queue has no target behavior: sending it would make the core read it as a failure (reward 0).
  if (!st || st.queue_total === 0) return null;
  const done = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM daily_queue WHERE user_id = ? AND day = ? AND done = 1', userId, day)?.n ?? 0;
  const sessionId = `d${day}`;
  const uid = coreUserId(userId);
  const events: AdaptiveEvent[] = [];
  let last = 0;
  for (const r of rows) {
    last = Math.max(last, r.at);
    if (r.type === 'exposure') events.push({ type: 'exposure', userId: uid, sessionId, at: r.at, elementId: r.element_id, prominence: r.prominence ?? 0 });
    else events.push({ type: 'interaction', userId: uid, sessionId, at: r.at, elementId: r.element_id });
  }
  if (!events.some((e) => e.type === 'exposure')) return null;
  events.push({ type: 'outcome', userId: uid, sessionId, at: last, kind: 'target', value: Math.min(1, done / st.queue_total) });
  return events;
}

/** Sends every finished day that has not been sent yet, in order. Returns how many days changed the model. */
export function settle(db: Db, exp: Experiment, userId: number, now: number): number {
  const today = dayNumber(now);
  const startOfToday = today * 86_400_000 + 180 * 60_000;
  const rows = all<EventRow & { id: number }>(
    db,
    "SELECT id, type, at, element_id, prominence FROM events WHERE user_id = ? AND type IN ('exposure', 'interaction') AND at < ? ORDER BY at, id",
    userId,
    startOfToday,
  );
  const byDay = new Map<number, EventRow[]>();
  for (const r of rows) {
    const d = dayNumber(r.at);
    const list = byDay.get(d);
    if (list) list.push(r);
    else byDay.set(d, [r]);
  }
  const done = new Set(all<{ day: number }>(db, 'SELECT day FROM engine_days WHERE user_id = ?', userId).map((r) => r.day));
  const pending = [...byDay.keys()].filter((d) => !done.has(d)).sort((a, b) => a - b);
  if (pending.length === 0) return 0;

  let state = loadState(db, exp, userId);
  let changed = 0;
  for (const day of pending) {
    const events = coreEventsForDay(db, userId, day, byDay.get(day) as EventRow[]);
    let sent = 0;
    if (events) {
      const r = exp.engine.update(state, events);
      state = r.state;
      if (r.processedSessions.length > 0) {
        sent = 1;
        changed += 1;
        const ex = exp.engine.explain(state);
        run(
          db,
          'INSERT OR REPLACE INTO profile_log (user_id, day, profile, uncertainty, level, sessions_observed) VALUES (?, ?, ?, ?, ?, ?)',
          userId,
          day,
          JSON.stringify(ex.profile),
          JSON.stringify(ex.uncertainty),
          ex.level,
          ex.sessionsObserved,
        );
      }
    }
    run(db, 'INSERT OR REPLACE INTO engine_days (user_id, day, sent) VALUES (?, ?, ?)', userId, day, sent);
  }
  saveState(db, userId, state, now);
  return changed;
}

// ---- the day's decision ------------------------------------------------------------------------------------------------------------

export function weightsOfDay(db: Db, userId: number, day: number): Record<string, number> | null {
  const row = one<{ weights: string }>(db, 'SELECT weights FROM day_weights WHERE user_id = ? AND day = ?', userId, day);
  return row ? (JSON.parse(row.weights) as Record<string, number>) : null;
}

/**
 * Called on every request. On the user's first request of the day it settles past days, decides the weights
 * (adaptive: core; control: uniform) and logs them; afterwards it just returns today's stored weights.
 * It never throws: if the core fails, the user gets uniform weights and the failure is logged.
 */
export function ensureDay(db: Db, exp: Experiment, userId: number, now: number): Record<string, number> {
  const day = dayNumber(now);
  const existing = weightsOfDay(db, userId, day);
  if (existing) return existing;
  const grp = one<{ grp: Group | null }>(db, 'SELECT grp FROM users WHERE id = ?', userId)?.grp ?? null;
  let weights = uniformWeights();
  let raw: Record<string, number> | null = null;
  let k: number | null = null;
  if (exp.enabled && grp === 'adaptive') {
    try {
      tx(db, () => {
        settle(db, exp, userId, now);
        const d = exp.engine.decide(loadState(db, exp, userId), `d${day}`, now);
        saveState(db, userId, d.state, now);
        // Soft start: the n-th decision day of this user shrinks the core's weights toward the neutral weight.
        const n = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM day_weights WHERE user_id = ? AND day < ?', userId, day)?.n ?? 0;
        k = softStartFactor(n, exp.rampDays);
        raw = d.weights;
        weights = applySoftStart(d.weights, k, CONTROL_WEIGHT);
      });
    } catch (err) {
      console.error(`[experiment] falha no núcleo para o usuário ${userId}; usando pesos uniformes:`, err);
      weights = uniformWeights();
      raw = null;
      k = null;
    }
  }
  run(db, 'INSERT OR IGNORE INTO day_weights (user_id, day, weights, raw, shrink) VALUES (?, ?, ?, ?, ?)', userId, day, JSON.stringify(weights), raw ? JSON.stringify(raw) : null, k);
  return weights;
}
