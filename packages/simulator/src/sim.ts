// Synthetic-user simulator. Used to verify that the ALGORITHM behaves as expected;
// it is not evidence about real users. Uses the core's public API, plus its internal linalg helpers for the
// direct-bandit ablation (the ablation is simulator code, not part of the core).

import { applySoftStart, createEngine, HEXAD_TYPES, softStartFactor } from '../../core/src/index.ts';
import type { AdaptiveEngine, AdaptiveEvent, Catalog, EngineConfig, UserState } from '../../core/src/index.ts';
import { cholesky, backSubT, solveWithCholesky } from '../../core/src/linalg.ts';

// ---- deterministic randomness ---------------------------------------------

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash3(a: number, b: number, c: number): number {
  let h = 0x811c9dc5;
  for (const v of [a, b, c]) {
    h ^= v | 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

export function gauss(rng: Rng): number {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const DAY = 86_400_000;

// ---- world ----------------------------------------------------------------

export interface WorldParams {
  /** Effect of the exposure mixture on the outcome probability. */
  kappa: number;
  /** Std of the observation noise on the outcome value. */
  outcomeNoise: number;
  /** Std of the perturbation of the signatures the WORLD uses (0 = the catalog prior is exactly right). */
  signatureNoise: number;
  /** Strength with which clicks follow the user's real affinity. */
  clickAffinity: number;
  /** Strength of the element-specific click propensity that is unrelated to the user's affinity ("shiny" elements). */
  clickiness: number;
  /** Std of a per-user, per-element effect on the outcome that the Hexad structure does NOT explain (0 = pure Hexad world). */
  idiosyncratic: number;
}

export const DEFAULT_WORLD: WorldParams = { kappa: 0.6, outcomeNoise: 0.15, signatureNoise: 0, clickAffinity: 0.3, clickiness: 0.5, idiosyncratic: 0 };

export interface World {
  ids: string[];
  /** Normalized signatures the world uses to translate exposure into effect. */
  sig: number[][];
  /** Click propensity of each element independent of the user. */
  shiny: number[];
  params: WorldParams;
}

const SHINY = new Set(['points', 'leaderboard', 'cosmetic_rewards', 'achievements', 'levels']);

export function makeWorld(catalog: Catalog, params: WorldParams, seed: number): World {
  const rng = mulberry32(seed);
  const sig = catalog.elements.map((e) => {
    const raw = HEXAD_TYPES.map((t) => e.signature[t]);
    const noisy = raw.map((v) => Math.max(0, v / raw.reduce((a, b) => a + b, 0) + params.signatureNoise * gauss(rng)));
    const s = noisy.reduce((a, b) => a + b, 0) || 1;
    return noisy.map((v) => v / s);
  });
  return { ids: catalog.elements.map((e) => e.id), sig, shiny: catalog.elements.map((e) => (SHINY.has(e.id) ? 1 : 0)), params };
}

export interface SimUser {
  id: string;
  /** Hidden affinity over the 6 types, sums to 0. */
  h: number[];
  base: number;
  /** Per-element effect not explained by the Hexad structure (filled by runPolicy from world.params.idiosyncratic). */
  g?: number[];
}

export function randomAffinity(rng: Rng, avoidDominant?: number): number[] {
  let d = Math.floor(rng() * 6);
  while (avoidDominant !== undefined && d === avoidDominant) d = Math.floor(rng() * 6);
  let s = Math.floor(rng() * 6);
  while (s === d) s = Math.floor(rng() * 6);
  const h = Array.from({ length: 6 }, () => 0.1 * gauss(rng));
  h[d] = (h[d] as number) + 1;
  h[s] = (h[s] as number) + 0.4;
  const m = h.reduce((a, b) => a + b, 0) / 6;
  return h.map((v) => v - m);
}

export function makeUser(id: string, rng: Rng, kind: 'typed' | 'neutral'): SimUser {
  return { id, h: kind === 'neutral' ? new Array<number>(6).fill(0) : randomAffinity(rng), base: 0.25 + 0.35 * rng() };
}

export function dominant(h: number[]): number {
  return h.indexOf(Math.max(...h));
}

export interface SessionOutcome {
  /** Noise-free expected outcome of this session (what the policy actually achieved). */
  pTrue: number;
  outcome: number;
  clicked: string[];
  clickRate: number;
  /** Exposure mixture x. */
  x: number[];
}

/** Exposure mixture exactly as the engine defines it, but with the WORLD's signatures. */
export function mixture(world: World, weights: Record<string, number>): number[] {
  const x = new Array<number>(6).fill(0);
  let tot = 0;
  world.ids.forEach((id, k) => {
    const p = weights[id] ?? 0;
    if (p <= 0) return;
    tot += p;
    for (let i = 0; i < 6; i++) x[i] = (x[i] as number) + p * ((world.sig[k] as number[])[i] as number);
  });
  return x.map((v) => v / (tot || 1));
}

export function simulateSession(world: World, user: SimUser, weights: Record<string, number>, rng: Rng): SessionOutcome {
  const { kappa, outcomeNoise, clickAffinity, clickiness } = world.params;
  const x = mixture(world, weights);
  let effect = x.reduce((a, xi, i) => a + xi * (user.h[i] as number), 0);
  if (user.g) {
    let tot = 0;
    let acc = 0;
    world.ids.forEach((id, k) => {
      const p = weights[id] ?? 0;
      tot += p;
      acc += p * (user.g![k] as number);
    });
    effect += acc / (tot || 1);
  }
  const pTrue = clamp(user.base + kappa * effect, 0, 1);
  const outcome = clamp(pTrue + outcomeNoise * gauss(rng), 0, 1);
  const clicked: string[] = [];
  let exposed = 0;
  world.ids.forEach((id, k) => {
    const p = weights[id] ?? 0;
    if (p <= 0) return;
    exposed += 1;
    const aff = (world.sig[k] as number[]).reduce((a, w, i) => a + w * (user.h[i] as number), 0);
    const q = clamp(0.05 + p * (clickiness * (world.shiny[k] as number) + clickAffinity * aff), 0, 1);
    if (rng() < q) clicked.push(id);
  });
  return { pTrue, outcome, clicked, clickRate: exposed ? clicked.length / exposed : 0, x };
}

// ---- policies ---------------------------------------------------------------

export interface SessionRecord {
  weights: Record<string, number>;
  clicked: string[];
  outcome: number;
}

export interface PolicyInstance {
  decide(sessionIdx: number): Record<string, number>;
  observe(sessionIdx: number, rec: SessionRecord): void;
  /** Estimated profile as differences across the 6 dimensions (null if the policy has none). */
  profile(): number[] | null;
}

export interface PolicyFactory {
  name: string;
  create(userId: string, rng: Rng): PolicyInstance;
}

export function uniformPolicy(ids: string[], level = 0.5): PolicyFactory {
  const w = Object.fromEntries(ids.map((id) => [id, level]));
  return { name: 'uniform', create: () => ({ decide: () => ({ ...w }), observe: () => {}, profile: () => null }) };
}

export function randomPolicy(ids: string[], floor = 0.1): PolicyFactory {
  return {
    name: 'random',
    create: (_u, rng) => ({
      decide: () => Object.fromEntries(ids.map((id) => [id, floor + (1 - floor) * rng()])),
      observe: () => {},
      profile: () => null,
    }),
  };
}

/** Upper reference: knows the user's hidden affinity and the world's signatures. */
export function oraclePolicy(world: World, users: Map<string, SimUser>, floor = 0.1, topK = 4): PolicyFactory {
  return {
    name: 'oracle',
    create: (userId) => {
      const u = users.get(userId) as SimUser;
      // Full-information oracle: also knows the per-element effect the Hexad structure does not explain.
      const scores = world.sig.map((w, k) => w.reduce((a, v, i) => a + v * (u.h[i] as number), 0) + (u.g ? (u.g[k] as number) : 0));
      const order = scores.map((s, k) => [s, k] as const).sort((a, b) => b[0] - a[0]).map(([, k]) => k);
      const top = new Set(order.slice(0, topK));
      const w = Object.fromEntries(world.ids.map((id, k) => [id, top.has(k) ? 1 : floor]));
      return { decide: () => ({ ...w }), observe: () => {}, profile: () => null };
    },
  };
}

/** Uses the TRUE affinity as the profile (no learning, no sampling) with the engine's weight mapping.
 *  Separates "how much the weight mapping can gain at a given sensitivity" from "how well the profile is learned". */
export function profileOraclePolicy(world: World, users: Map<string, SimUser>, sensitivity: number, floor = 0.1, neutral = 0.5): PolicyFactory {
  return {
    name: `profile-oracle (sens ${sensitivity})`,
    create: (userId) => {
      const u = users.get(userId) as SimUser;
      const scores = world.sig.map((w) => w.reduce((a, v, i) => a + v * (u.h[i] as number), 0));
      const m = scores.reduce((a, c) => a + c, 0) / scores.length;
      const w = Object.fromEntries(world.ids.map((id, k) => [id, clamp(neutral + sensitivity * ((scores[k] as number) - m), floor, 1)]));
      return { decide: () => ({ ...w }), observe: () => {}, profile: () => null };
    },
  };
}

function buildEvents(userId: string, sessionIdx: number, rec: SessionRecord): AdaptiveEvent[] {
  const sessionId = `s${sessionIdx}`;
  const at = sessionIdx * DAY + 8 * 3_600_000;
  const evs: AdaptiveEvent[] = Object.entries(rec.weights).map(([elementId, prominence]) => ({ type: 'exposure', userId, sessionId, at, elementId, prominence }));
  for (const elementId of rec.clicked) evs.push({ type: 'interaction', userId, sessionId, at: at + 60_000, elementId });
  evs.push({ type: 'outcome', userId, sessionId, at: at + 3_600_000, kind: 'target', value: rec.outcome });
  return evs;
}

export function hexadPolicy(name: string, config: EngineConfig, engineOverride?: AdaptiveEngine, rampDays = 1): PolicyFactory {
  const engine = engineOverride ?? createEngine(config);
  return {
    name,
    create: (userId) => {
      let state: UserState = engine.neutralState(userId);
      return {
        decide: (i) => {
          const d = engine.decide(state, `s${i}`, i * DAY + 7 * 3_600_000);
          state = d.state;
          return applySoftStart(d.weights, softStartFactor(i, rampDays));
        },
        observe: (i, rec) => {
          state = engine.update(state, buildEvents(userId, i, rec)).state;
        },
        profile: () => {
          const p = engine.explain(state).profile;
          return HEXAD_TYPES.map((t) => p[t]);
        },
      };
    },
  };
}

/** Ablation of the Hexad layer: the same discounted linear Thompson Sampling, but directly over the elements (no Hexad layer). */
export function directPolicy(ids: string[], cfg: { gamma: number; priorVariance: number; levelPriorVariance: number; noiseVariance: number; samplingScale: number; sensitivity: number; floor: number; neutral: number; omega: number }): PolicyFactory {
  const n = ids.length;
  const lambda0 = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => ((i === j ? 1 : 0) - 1 / n) / cfg.priorVariance + 1 / n / cfg.levelPriorVariance));
  return {
    name: 'direct-bandit (no Hexad)',
    create: (_u, rng) => {
      let A = lambda0.map((r) => r.slice());
      let b = new Array<number>(n).fill(0);
      return {
        decide: () => {
          const L = cholesky(A.map((r) => r.slice()));
          const mu = solveWithCholesky(L, b.slice());
          const z = Array.from({ length: n }, () => gauss(rng));
          const noise = backSubT(L, z);
          const theta = mu.map((m, i) => m + cfg.samplingScale * (noise[i] as number));
          const mean = theta.reduce((a, c) => a + c, 0) / n;
          return Object.fromEntries(ids.map((id, i) => [id, clamp(cfg.neutral + cfg.sensitivity * ((theta[i] as number) - mean), cfg.floor, 1)]));
        },
        observe: (_i, rec) => {
          const tot = Object.values(rec.weights).reduce((a, c) => a + c, 0);
          const x = ids.map((id) => (rec.weights[id] ?? 0) / tot);
          const exposed = ids.filter((id) => (rec.weights[id] ?? 0) > 0);
          const rInt = exposed.length ? exposed.filter((id) => rec.clicked.includes(id)).length / exposed.length : 0;
          const r = (1 - cfg.omega) * rec.outcome + cfg.omega * rInt;
          A = A.map((row, i) => row.map((a, j) => cfg.gamma * a + ((x[i] as number) * (x[j] as number)) / cfg.noiseVariance + (1 - cfg.gamma) * ((lambda0[i] as number[])[j] as number)));
          b = b.map((bi, i) => cfg.gamma * bi + (r * (x[i] as number)) / cfg.noiseVariance);
        },
        profile: () => null,
      };
    },
  };
}

// ---- running ----------------------------------------------------------------

export interface RunOptions {
  nUsers: number;
  nSessions: number;
  world: World;
  seed: number;
  userKind?: 'typed' | 'neutral';
  /** Session index at which every user's hidden affinity is redrawn (different dominant type). */
  changeAt?: number;
  /** Record the full per-session weights (for floor and variability checks). */
  keepWeights?: boolean;
}

export interface UserTrace {
  userId: string;
  p: number[];
  outcome: number[];
  clickRate: number[];
  /** Hidden h at each session (changes if changeAt is set). */
  hAt: number[][];
  profile: (number[] | null)[];
  minWeight: number;
  weights?: Record<string, number>[];
}

export function runPolicy(factory: PolicyFactory, opts: RunOptions, usersOut?: Map<string, SimUser>): UserTrace[] {
  const traces: UserTrace[] = [];
  const registry = usersOut ?? new Map<string, SimUser>();
  for (let u = 0; u < opts.nUsers; u++) {
    const userId = `u${u}`;
    const urng = mulberry32(hash3(opts.seed, u, 1));
    const user = registry.get(userId) ?? makeUser(userId, urng, opts.userKind ?? 'typed');
    if (!user.g) {
      const grng = mulberry32(hash3(opts.seed, u, 4));
      user.g = opts.world.ids.map(() => opts.world.params.idiosyncratic * gauss(grng));
    }
    registry.set(userId, user);
    const inst = factory.create(userId, mulberry32(hash3(opts.seed, u, 2)));
    const trace: UserTrace = { userId, p: [], outcome: [], clickRate: [], hAt: [], profile: [], minWeight: 1, weights: opts.keepWeights ? [] : undefined };
    let h = user.h;
    const crng = mulberry32(hash3(opts.seed, u, 3));
    const newH = opts.changeAt !== undefined ? randomAffinity(crng, dominant(user.h)) : null;
    for (let i = 0; i < opts.nSessions; i++) {
      if (opts.changeAt !== undefined && newH && i === opts.changeAt) h = newH;
      const live: SimUser = { ...user, h };
      const weights = inst.decide(i);
      const minW = Math.min(...Object.values(weights));
      trace.minWeight = Math.min(trace.minWeight, minW);
      const sess = simulateSession(opts.world, live, weights, mulberry32(hash3(opts.seed, u, 1000 + i)));
      inst.observe(i, { weights, clicked: sess.clicked, outcome: sess.outcome });
      trace.p.push(sess.pTrue);
      trace.outcome.push(sess.outcome);
      trace.clickRate.push(sess.clickRate);
      trace.hAt.push(h);
      trace.profile.push(inst.profile());
      trace.weights?.push(weights);
    }
    traces.push(trace);
  }
  return traces;
}

// ---- stats ------------------------------------------------------------------

export const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

export function sd(a: number[]): number {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1));
}

export function meanCI(a: number[]): { m: number; half: number } {
  return { m: mean(a), half: (1.96 * sd(a)) / Math.sqrt(a.length) };
}

export function windowMean(t: UserTrace, field: 'p' | 'outcome' | 'clickRate', from: number, to: number): number {
  return mean(t[field].slice(from, to));
}

/** User-visible churn: mean absolute change of the element weights between consecutive sessions. 0 = interface never changes. */
export function churnOf(t: UserTrace): number {
  const w = t.weights;
  if (!w || w.length < 2) return 0;
  const ids = Object.keys(w[0] as Record<string, number>);
  let acc = 0;
  for (let i = 1; i < w.length; i++) {
    let s = 0;
    for (const id of ids) s += Math.abs(((w[i] as Record<string, number>)[id] as number) - ((w[i - 1] as Record<string, number>)[id] as number));
    acc += s / ids.length;
  }
  return acc / (w.length - 1);
}

export function pearson(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += ((a[i] as number) - ma) * ((b[i] as number) - mb);
    da += ((a[i] as number) - ma) ** 2;
    db += ((b[i] as number) - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
