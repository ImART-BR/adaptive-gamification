// Logic of the interactive visual simulation: ONE fake user living through N days in the simulated world, once under
// the adaptive core and once under the uniform interface (control), with the same noise on both. Pure and
// deterministic: the same parameters always give the same history, so the page can scrub it back and forth.
import { HEXAD_TYPES } from '../../core/src/index.ts';
import type { Catalog } from '../../core/src/index.ts';
import { DEFAULT_WORLD, hash3, hexadPolicy, makeWorld, mulberry32, simulateSession, uniformPolicy } from './sim.ts';
import type { SimUser } from './sim.ts';

export interface DemoParams {
  /** Hidden affinity of the fake user for each Hexad type (any scale; it is centered). The system never sees it. */
  affinity: number[];
  /** Day (1-based) on which the taste changes to `affinityAfter`; null = never. */
  changeDay: number | null;
  affinityAfter: number[] | null;
  /** Chance of finishing the day's queue with the plain interface. */
  base: number;
  /** How much the interface matters to this user (the world's kappa). */
  effect: number;
  /** Std of the day-to-day noise on the outcome. */
  noise: number;
  days: number;
  seed: number;
  /** Soft start length in days; 1 disables it. */
  rampDays: number;
}

export interface ArmDay {
  /** Weight of every element on this day (what the interface applied). */
  weights: Record<string, number>;
  /** Elements the fake user interacted with this day. */
  clicked: string[];
  /** Fraction of the day's queue the user finished (with noise). */
  outcome: number;
  /** The same without the noise: what the interface really gave this user. */
  expected: number;
  /** Estimated profile (differences between the 6 types) after the day's decision, adaptive arm only. */
  profile: number[] | null;
}

export interface DemoResult {
  elementIds: string[];
  elementLabels: Record<string, string>;
  /** Index (0..5) of the Hexad type each element mostly speaks to. */
  elementType: Record<string, number>;
  adaptive: ArmDay[];
  control: ArmDay[];
  /** The hidden affinity (centered) on each day. */
  affinityAt: number[][];
}

export const DEFAULT_PARAMS: DemoParams = {
  affinity: [0, 1, 0, 0, 0, 0],
  changeDay: null,
  affinityAfter: null,
  base: 0.42,
  effect: 0.6,
  noise: 0.15,
  days: 120,
  seed: 7,
  rampDays: 7,
};

const center = (v: number[]): number[] => {
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return v.map((x) => x - m);
};

export function runDemo(catalog: Catalog, p: DemoParams): DemoResult {
  const elementIds = catalog.elements.map((e) => e.id);
  const world = makeWorld(catalog, { ...DEFAULT_WORLD, kappa: p.effect, outcomeNoise: p.noise }, p.seed + 1);
  const before = center(p.affinity);
  const after = center(p.affinityAfter ?? p.affinity);

  const adaptive = hexadPolicy('adaptive', { schemaVersion: '0.1', catalog, seed: p.seed }, undefined, p.rampDays).create('demo', mulberry32(hash3(p.seed, 0, 2)));
  const control = uniformPolicy(elementIds).create('demo', mulberry32(hash3(p.seed, 0, 3)));

  const arms: { adaptive: ArmDay[]; control: ArmDay[] } = { adaptive: [], control: [] };
  const affinityAt: number[][] = [];
  for (let i = 0; i < p.days; i++) {
    const h = p.changeDay !== null && i + 1 >= p.changeDay ? after : before;
    affinityAt.push(h);
    const user: SimUser = { id: 'demo', h, base: p.base };
    for (const [name, policy] of [['adaptive', adaptive], ['control', control]] as const) {
      const weights = policy.decide(i);
      // Same random numbers for both arms on the same day: the difference comes from the interface, not from luck.
      const s = simulateSession(world, user, weights, mulberry32(hash3(p.seed, 0, 1000 + i)));
      policy.observe(i, { weights, clicked: s.clicked, outcome: s.outcome });
      arms[name].push({ weights, clicked: s.clicked, outcome: s.outcome, expected: s.pTrue, profile: policy.profile() });
    }
  }

  const elementType: Record<string, number> = {};
  const elementLabels: Record<string, string> = {};
  for (const e of catalog.elements) {
    const sig = HEXAD_TYPES.map((t) => e.signature[t]);
    elementType[e.id] = sig.indexOf(Math.max(...sig));
    elementLabels[e.id] = e.label ?? e.id;
  }
  return { elementIds, elementLabels, elementType, adaptive: arms.adaptive, control: arms.control, affinityAt };
}

export interface Ensemble {
  runs: number;
  /** Per day: mean of (expected outcome with the adaptive interface − with the uniform one). */
  gain: number[];
  /** Per day: mean correlation between the estimated profile and the hidden affinity. */
  corr: number[];
  /** Per day: mean estimated profile (6 numbers). */
  profile: number[][];
}

/**
 * The same fake user lived `runs` times with different luck (seeds seed, seed+1, ...). One person's history is noisy;
 * this shows what usually happens, which is what the acceptance criteria are about.
 */
export function ensemble(catalog: Catalog, p: DemoParams, runs: number): Ensemble {
  const gain = new Array<number>(p.days).fill(0);
  const corr = new Array<number>(p.days).fill(0);
  const profile = Array.from({ length: p.days }, () => new Array<number>(6).fill(0));
  for (let k = 0; k < runs; k++) {
    const r = runDemo(catalog, { ...p, seed: p.seed + k });
    for (let i = 0; i < p.days; i++) {
      gain[i] = (gain[i] as number) + ((r.adaptive[i] as ArmDay).expected - (r.control[i] as ArmDay).expected) / runs;
      const prof = (r.adaptive[i] as ArmDay).profile as number[];
      corr[i] = (corr[i] as number) + correlation(prof, r.affinityAt[i] as number[]) / runs;
      prof.forEach((v, j) => {
        (profile[i] as number[])[j] = ((profile[i] as number[])[j] as number) + v / runs;
      });
    }
  }
  return { runs, gain, corr, profile };
}

/** Average absolute change of the weights from the previous day: how much the interface moved. 0 on the first day. */
export function churn(days: ArmDay[], i: number): number {
  if (i <= 0 || i >= days.length) return 0;
  const ids = Object.keys((days[i] as ArmDay).weights);
  let s = 0;
  for (const id of ids) s += Math.abs((days[i] as ArmDay).weights[id]! - (days[i - 1] as ArmDay).weights[id]!);
  return s / ids.length;
}

/** Pearson correlation of two equally long vectors (0 if either is constant). */
export function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
