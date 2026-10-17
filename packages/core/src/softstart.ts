// Soft start: helpers an app can use so that a new user does not see an extreme interface on day 1.
//
// The engine samples a plausible profile from its belief, so even with a neutral belief the first decision can be
// far from uniform. The app can shrink the engine's weights toward the neutral weight on the first days and release
// them gradually. This is application policy, not part of the engine: decide() is unchanged and the shrunk weights
// are what the user is actually exposed to (so they are what must be logged as exposure).

/**
 * Factor k in (0, 1] for the user's n-th decision day (0 = first). Grows linearly from 0.25 to 1 over `rampDays`
 * decision days. rampDays <= 1 disables the soft start (k = 1 always).
 */
export function softStartFactor(dayIndex: number, rampDays: number): number {
  if (!(rampDays > 1)) return 1;
  const n = Math.max(0, dayIndex);
  return Math.min(1, 0.25 + (0.75 * n) / (rampDays - 1));
}

/** `neutral + k * (w - neutral)` for every element. Keeps the order of the weights and never goes below the floor. */
export function applySoftStart(weights: Record<string, number>, k: number, neutral = 0.5): Record<string, number> {
  if (k >= 1) return { ...weights };
  return Object.fromEntries(Object.entries(weights).map(([id, w]) => [id, neutral + k * (w - neutral)]));
}
