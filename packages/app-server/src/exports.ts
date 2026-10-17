// Research exports: anonymized CSVs for the pre-registered analysis.
// None of them contains the access code, nickname, password, handle, or free text typed by participants.
import { all } from './db.ts';
import type { Db } from './db.ts';
import { exportEventsCsv } from './events.ts';
import { HEXAD_TYPES } from '../../core/src/index.ts';
import { dayString } from './time.ts';

export { exportEventsCsv };

const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const line = (vals: unknown[]) => vals.map(cell).join(',');

/**
 * One row per user, day and element. `weight` is what the interface applied (control: uniform 0.5). For the adaptive
 * group, `rawWeight` is the core's own decision and `shrink` the soft-start factor k that was applied to it
 * (weight = 0.5 + shrink * (rawWeight - 0.5)); both are empty for control.
 */
export function exportDecisionsCsv(db: Db): string {
  const rows = all<{ user_id: number; grp: string | null; day: number; weights: string; raw: string | null; shrink: number | null }>(
    db,
    'SELECT w.user_id, u.grp, w.day, w.weights, w.raw, w.shrink FROM day_weights w JOIN users u ON u.id = w.user_id ORDER BY w.day, w.user_id',
  );
  const out = ['userId,group,day,elementId,weight,rawWeight,shrink'];
  for (const r of rows) {
    const weights = JSON.parse(r.weights) as Record<string, number>;
    const raw = r.raw ? (JSON.parse(r.raw) as Record<string, number>) : null;
    for (const [elementId, weight] of Object.entries(weights)) out.push(line([`u${r.user_id}`, r.grp, dayString(r.day), elementId, weight, raw ? raw[elementId] : '', r.shrink]));
  }
  return out.join('\n') + '\n';
}

/** The profile the core estimated after each settled day (adaptive group only). */
export function exportProfilesCsv(db: Db): string {
  const rows = all<{ user_id: number; grp: string | null; day: number; profile: string; uncertainty: string; level: number; sessions_observed: number }>(
    db,
    'SELECT p.user_id, u.grp, p.day, p.profile, p.uncertainty, p.level, p.sessions_observed FROM profile_log p JOIN users u ON u.id = p.user_id ORDER BY p.day, p.user_id',
  );
  const head = ['userId', 'group', 'day', 'sessionsObserved', 'level', ...HEXAD_TYPES.map((t) => `profile_${t}`), ...HEXAD_TYPES.map((t) => `sd_${t}`)];
  const out = [head.join(',')];
  for (const r of rows) {
    const p = JSON.parse(r.profile) as Record<string, number>;
    const sd = JSON.parse(r.uncertainty) as Record<string, number>;
    out.push(line([`u${r.user_id}`, r.grp, dayString(r.day), r.sessions_observed, r.level, ...HEXAD_TYPES.map((t) => p[t]), ...HEXAD_TYPES.map((t) => sd[t])]));
  }
  return out.join('\n') + '\n';
}

/**
 * One row per user and day with a queue: the primary outcome (fraction of the queue finished) and the secondary
 * learning metric (share of reviews answered "good" or "easy"). Accuracy is NOT a reward, only a metric.
 */
export function exportDailyCsv(db: Db): string {
  const rows = all<{ user_id: number; grp: string | null; day: number; total: number; done: number; reviews: number; correct: number }>(
    db,
    `SELECT s.user_id, u.grp, s.day, s.queue_total AS total,
            (SELECT COUNT(*) FROM daily_queue q WHERE q.user_id = s.user_id AND q.day = s.day AND q.done = 1) AS done,
            (SELECT COUNT(*) FROM reviews r WHERE r.user_id = s.user_id AND r.day = s.day) AS reviews,
            (SELECT COUNT(*) FROM reviews r WHERE r.user_id = s.user_id AND r.day = s.day AND r.grade >= 2) AS correct
       FROM daily_state s JOIN users u ON u.id = s.user_id ORDER BY s.day, s.user_id`,
  );
  const out = ['userId,group,day,queueTotal,queueDone,outcome,reviews,correct,accuracy'];
  for (const r of rows) {
    out.push(line([`u${r.user_id}`, r.grp, dayString(r.day), r.total, r.done, r.total > 0 ? r.done / r.total : '', r.reviews, r.correct, r.reviews > 0 ? r.correct / r.reviews : '']));
  }
  return out.join('\n') + '\n';
}
