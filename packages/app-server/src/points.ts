// Points ledger and the activity log, shared by the study loop and the social features.
import { one, run } from './db.ts';
import type { Db } from './db.ts';
import { levelFromPoints } from './gamification.ts';
import { dayNumber } from './time.ts';

export function totalPoints(db: Db, userId: number): number {
  return one<{ p: number | null }>(db, 'SELECT SUM(points) AS p FROM point_events WHERE user_id = ?', userId)?.p ?? 0;
}

export type ActivityType = 'queue_done' | 'level_up' | 'achievement' | 'deck_shared' | 'helpful_answer' | 'gift' | 'joined_group' | 'pair_formed' | 'pair_goal' | 'suggestion_accepted';

/** What the feed shows to a user's group mates and study partner. Only the type and a few public fields. */
export function logActivity(db: Db, userId: number, type: ActivityType, payload: Record<string, unknown>, at: number): void {
  run(db, 'INSERT INTO activity (user_id, type, payload, at) VALUES (?, ?, ?, ?)', userId, type, JSON.stringify(payload), at);
}

/** Adds points to the ledger; logs a "level_up" activity if the level rose. */
export function grantPoints(db: Db, userId: number, now: number, points: number, reason: string): { levelBefore: number; levelAfter: number } {
  const levelBefore = levelFromPoints(totalPoints(db, userId));
  if (points !== 0) run(db, 'INSERT INTO point_events (user_id, at, day, points, reason) VALUES (?, ?, ?, ?, ?)', userId, now, dayNumber(now), points, reason);
  const levelAfter = levelFromPoints(totalPoints(db, userId));
  if (levelAfter > levelBefore) logActivity(db, userId, 'level_up', { level: levelAfter }, now);
  return { levelBefore, levelAfter };
}

/** True if a ledger entry with exactly this reason already exists for the user (for one-time rewards). */
export function alreadyGranted(db: Db, userId: number, reason: string): boolean {
  return !!one(db, 'SELECT 1 AS x FROM point_events WHERE user_id = ? AND reason = ?', userId, reason);
}
