// Spaced repetition (simplified SM-2). Pure functions; days are whole day numbers (see time.ts).

export type Grade = 0 | 1 | 2 | 3; // again, hard, good, easy
export type CardPhase = 'new' | 'learning' | 'review';

export interface CardState {
  ease: number;
  interval: number;
  due: number;
  reps: number;
  lapses: number;
  phase: CardPhase;
}

export function newCardState(today: number): CardState {
  return { ease: 2.5, interval: 0, due: today, reps: 0, lapses: 0, phase: 'new' };
}

export function schedule(s: CardState, grade: Grade, today: number): CardState {
  if (grade === 0) {
    return {
      ease: s.phase === 'review' ? Math.max(1.3, s.ease - 0.2) : s.ease,
      interval: 0,
      due: today,
      reps: 0,
      lapses: s.lapses + (s.phase === 'review' ? 1 : 0),
      phase: 'learning',
    };
  }
  let ease = s.ease;
  let interval: number;
  if (grade === 1) {
    ease = Math.max(1.3, ease - 0.15);
    interval = Math.max(1, Math.round(Math.max(s.interval, 1) * 1.2));
  } else if (grade === 2) {
    interval = s.reps === 0 ? 1 : s.reps === 1 ? 3 : Math.max(s.interval + 1, Math.round(s.interval * ease));
  } else {
    ease += 0.15;
    interval = s.reps === 0 ? 3 : Math.max(s.interval + 2, Math.round(Math.max(s.interval, 1) * ease * 1.3));
  }
  return { ease, interval, due: today + interval, reps: s.reps + 1, lapses: s.lapses, phase: 'review' };
}

/** A card counts as mature (mastered) once its interval reaches 21 days. */
export const MATURE_INTERVAL = 21;
