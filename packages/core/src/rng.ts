// Counter-based deterministic generator.
// Every draw is a pure function of (seed, userId, counter), so decide() stays pure and reproducible.
// Reproducibility is guaranteed within this implementation only (not bit-for-bit across ports).

/** FNV-1a 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 32-bit finalizer. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform in (0, 1] for draw number `counter`. Never returns 0 (safe for log). */
export function uniformAt(seed: number, userHash: number, counter: number): number {
  const a = fmix32((seed | 0) ^ Math.imul(userHash, 0x9e3779b1));
  const b = fmix32(a ^ Math.imul(counter + 1, 0x85ebca6b));
  const c = fmix32(b + 0x6a09e667);
  return (c + 1) / 4294967296;
}

/** n standard normal draws consuming n consecutive counters (Box-Muller on pairs). */
export function normalsAt(seed: number, userId: string, counter: number, n: number): number[] {
  const userHash = hashString(userId);
  const out: number[] = [];
  for (let i = 0; i < n; i += 2) {
    const u1 = uniformAt(seed, userHash, counter + i);
    const u2 = uniformAt(seed, userHash, counter + i + 1);
    const r = Math.sqrt(-2 * Math.log(u1));
    out.push(r * Math.cos(2 * Math.PI * u2));
    if (i + 1 < n) out.push(r * Math.sin(2 * Math.PI * u2));
  }
  return out;
}
