// Adaptive gamification engine: Hexad profile as a discounted Bayesian linear model + Thompson Sampling.
// Semantics: see the Core section of the README. Pure functions: every call returns new objects and never mutates its inputs.

import {
  cholesky,
  cloneMat,
  dot,
  inverseFromCholesky,
  isSymmetric,
  matVec,
  solveWithCholesky,
  backSubT,
} from './linalg.ts';
import type { Mat, Vec } from './linalg.ts';
import { normalsAt } from './rng.ts';
import { HEXAD_TYPES } from './types.ts';
import type {
  AdaptiveEngine,
  AdaptiveEvent,
  Decision,
  EngineConfig,
  Explanation,
  HexadVector,
  Matrix6,
  UpdateResult,
  UserState,
  Vector6,
} from './types.ts';

const D = HEXAD_TYPES.length; // 6
const MAX_RECENT_SESSIONS = 64;

/**
 * Default parameters. Calibrated in round 1 (packages/simulator/src/calibrate.ts) on synthetic worlds: robust across them,
 * NOT validated on real users. The pilot must recalibrate.
 */
export const DEFAULTS = {
  forgetting: 0.98,
  priorVariance: 0.5,
  levelPriorVariance: 100,
  noiseVariance: 0.05,
  samplingScale: 0.15,
  sensitivity: 16,
  exposureFloor: 0.1,
  neutralWeight: 0.5,
  interactionRewardWeight: 0.05,
} as const;

interface Resolved {
  elementIds: string[];
  /** Normalized signatures (sum 1), same order as elementIds. */
  signatures: Vec[];
  gamma: number;
  noiseVariance: number;
  samplingScale: number;
  exposureFloor: number;
  neutralWeight: number;
  sensitivity: number;
  outcomeKinds: Record<string, number>;
  missingOutcome: 'zero' | 'skip';
  omega: number;
  seed: number;
  /** Lambda0 = Sigma0^-1. */
  lambda0: Mat;
  /** Lambda0 * mu0. */
  lambda0Mu0: Vec;
}

function fail(msg: string): never {
  throw new Error(`[AdaptiveEngine] ${msg}`);
}

function vectorFromHexad(v: HexadVector): Vec {
  return HEXAD_TYPES.map((t) => v[t]);
}

function hexadFromVector(v: Vec): HexadVector {
  const out = {} as HexadVector;
  HEXAD_TYPES.forEach((t, i) => {
    out[t] = v[i] as number;
  });
  return out;
}

function inRange(x: unknown, lo: number, hi: number): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
}

function resolveConfig(config: EngineConfig): Resolved {
  if (config.schemaVersion !== '0.1') fail(`unsupported config schemaVersion ${String(config.schemaVersion)}`);
  const elements = config.catalog?.elements;
  if (!Array.isArray(elements) || elements.length < 2) fail('catalog needs at least 2 elements');
  const seen = new Set<string>();
  const elementIds: string[] = [];
  const signatures: Vec[] = [];
  for (const el of elements) {
    if (typeof el.id !== 'string' || el.id.length === 0) fail('catalog element without id');
    if (seen.has(el.id)) fail(`duplicate element id "${el.id}"`);
    seen.add(el.id);
    const raw = vectorFromHexad(el.signature);
    if (raw.some((x) => !(typeof x === 'number' && Number.isFinite(x) && x >= 0))) {
      fail(`element "${el.id}": signature values must be finite and >= 0`);
    }
    const sum = raw.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) fail(`element "${el.id}": signature must have at least one value > 0`);
    elementIds.push(el.id);
    signatures.push(raw.map((x) => x / sum));
  }

  const gamma = config.forgetting ?? DEFAULTS.forgetting;
  if (!(gamma > 0 && gamma <= 1)) fail('forgetting must be in (0, 1]');
  const priorVariance = config.priorVariance ?? DEFAULTS.priorVariance;
  const levelPriorVariance = config.levelPriorVariance ?? DEFAULTS.levelPriorVariance;
  if (!(priorVariance > 0) || !(levelPriorVariance > 0)) fail('prior variances must be > 0');
  const noiseVariance = config.noiseVariance ?? DEFAULTS.noiseVariance;
  if (!(noiseVariance > 0)) fail('noiseVariance must be > 0');
  const samplingScale = config.samplingScale ?? DEFAULTS.samplingScale;
  if (!(samplingScale > 0)) fail('samplingScale must be > 0');
  const exposureFloor = config.exposureFloor ?? DEFAULTS.exposureFloor;
  const neutralWeight = config.neutralWeight ?? DEFAULTS.neutralWeight;
  const omega = config.interactionRewardWeight ?? DEFAULTS.interactionRewardWeight;
  if (!inRange(exposureFloor, 0, 1)) fail('exposureFloor must be in [0, 1]');
  if (!inRange(neutralWeight, 0, 1)) fail('neutralWeight must be in [0, 1]');
  if (!inRange(omega, 0, 1)) fail('interactionRewardWeight must be in [0, 1]');
  const sensitivity = config.sensitivity ?? DEFAULTS.sensitivity;
  if (!(sensitivity >= 0) || !Number.isFinite(sensitivity)) fail('sensitivity must be >= 0');
  const outcomeKinds = config.outcomeKinds ?? { target: 1 };
  const kinds = Object.keys(outcomeKinds);
  if (kinds.length === 0) fail('outcomeKinds must have at least one kind');
  for (const k of kinds) {
    if (!((outcomeKinds[k] as number) > 0)) fail(`outcomeKinds["${k}"] must be > 0`);
  }
  const missingOutcome = config.missingOutcome ?? 'zero';
  if (missingOutcome !== 'zero' && missingOutcome !== 'skip') fail('missingOutcome must be "zero" or "skip"');
  const seed = config.seed ?? 0;
  if (!Number.isInteger(seed)) fail('seed must be an integer');

  let lambda0: Mat;
  if (config.priorCovariance) {
    const S = config.priorCovariance.map((row) => row.slice());
    if (S.length !== D || S.some((row) => row.length !== D)) fail('priorCovariance must be 6x6');
    if (!isSymmetric(S)) fail('priorCovariance must be symmetric');
    lambda0 = inverseFromCholesky(cholesky(S));
  } else {
    // Lambda0 = P / sigma_delta^2 + Q / sigma_c^2, P = I - 11'/6, Q = 11'/6.
    lambda0 = Array.from({ length: D }, (_, i) =>
      Array.from({ length: D }, (_, j) => ((i === j ? 1 : 0) - 1 / D) / priorVariance + 1 / D / levelPriorVariance),
    );
  }
  const mu0 = config.priorMean ? vectorFromHexad(config.priorMean) : new Array<number>(D).fill(0);
  if (mu0.some((x) => !Number.isFinite(x))) fail('priorMean must be finite');
  const lambda0Mu0 = matVec(lambda0, mu0);

  return {
    elementIds,
    signatures,
    gamma,
    noiseVariance,
    samplingScale,
    exposureFloor,
    neutralWeight,
    sensitivity,
    outcomeKinds,
    missingOutcome,
    omega,
    seed,
    lambda0,
    lambda0Mu0,
  };
}

function checkState(state: UserState): void {
  if (state.schemaVersion !== '0.1') fail(`unsupported state schemaVersion ${String(state.schemaVersion)}`);
  if (state.A.length !== D || state.b.length !== D) fail('state has wrong dimensions');
}

function validateEvent(ev: AdaptiveEvent): void {
  if (typeof ev.userId !== 'string' || ev.userId === '') fail('event without userId');
  if (typeof ev.sessionId !== 'string' || ev.sessionId === '') fail('event without sessionId');
  if (!Number.isInteger(ev.at) || ev.at < 0) fail(`event "${ev.type}" has invalid "at"`);
  switch (ev.type) {
    case 'exposure':
      if (typeof ev.elementId !== 'string' || ev.elementId === '') fail('exposure without elementId');
      if (!inRange(ev.prominence, 0, 1)) fail('exposure.prominence must be in [0, 1]');
      break;
    case 'interaction':
      if (typeof ev.elementId !== 'string' || ev.elementId === '') fail('interaction without elementId');
      break;
    case 'outcome':
      if (!inRange(ev.value, 0, 1)) fail('outcome.value must be in [0, 1]');
      if (ev.kind !== undefined && (typeof ev.kind !== 'string' || ev.kind === '')) fail('outcome.kind must be a non-empty string');
      break;
    default:
      fail(`unknown event type "${String((ev as { type?: unknown }).type)}"`);
  }
}

export function createEngine(config: EngineConfig): AdaptiveEngine {
  const cfg = resolveConfig(config);
  const indexOf = new Map(cfg.elementIds.map((id, i) => [id, i] as const));

  function neutralState(userId: string): UserState {
    if (typeof userId !== 'string' || userId === '') fail('userId must be a non-empty string');
    return {
      schemaVersion: '0.1',
      userId,
      dimensions: HEXAD_TYPES,
      A: cloneMat(cfg.lambda0) as Matrix6,
      b: cfg.lambda0Mu0.slice() as Vector6,
      sessionsObserved: 0,
      updatedAt: null,
      rng: { seed: cfg.seed, counter: 0 },
      lastDecision: null,
      recentSessionIds: [],
    };
  }

  function decide(state: UserState, sessionId: string, at: number): Decision {
    checkState(state);
    if (typeof sessionId !== 'string' || sessionId === '') fail('sessionId must be a non-empty string');
    if (!Number.isInteger(at) || at < 0) fail('"at" must be a non-negative integer (epoch ms)');

    const last = state.lastDecision;
    if (last && last.sessionId === sessionId) {
      return { sessionId, weights: { ...last.weights }, state: structuredClone(state), reused: true };
    }

    const L = cholesky(state.A.map((r) => r.slice()));
    const mu = solveWithCholesky(L, state.b.slice());
    const z = normalsAt(state.rng.seed, state.userId, state.rng.counter, D);
    // theta ~ N(mu, v^2 A^-1): theta = mu + v * L^-T z
    const noise = backSubT(L, z);
    const theta = mu.map((m, i) => m + cfg.samplingScale * (noise[i] as number));

    const scores = cfg.signatures.map((w) => dot(theta, w));
    const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const weights: Record<string, number> = {};
    cfg.elementIds.forEach((id, i) => {
      const w = cfg.neutralWeight + cfg.sensitivity * ((scores[i] as number) - meanScore);
      weights[id] = Math.min(1, Math.max(cfg.exposureFloor, w));
    });

    const next: UserState = {
      ...structuredClone(state),
      rng: { seed: state.rng.seed, counter: state.rng.counter + D },
      lastDecision: { sessionId, at, weights: { ...weights }, sampledProfile: theta as Vector6 },
    };
    return { sessionId, weights, state: next, reused: false };
  }

  function update(state: UserState, events: AdaptiveEvent[]): UpdateResult {
    checkState(state);
    const warnings: string[] = [];
    const processedSessions: string[] = [];
    const skippedSessions: string[] = [];

    const bySession = new Map<string, { first: number; minAt: number; events: AdaptiveEvent[] }>();
    const foreignUsers = new Set<string>();
    events.forEach((ev, idx) => {
      validateEvent(ev);
      if (ev.userId !== state.userId) {
        if (!foreignUsers.has(ev.userId)) {
          foreignUsers.add(ev.userId);
          warnings.push(`events of user "${ev.userId}" ignored (state belongs to "${state.userId}")`);
        }
        return;
      }
      const g = bySession.get(ev.sessionId);
      if (g) {
        g.events.push(ev);
        g.minAt = Math.min(g.minAt, ev.at);
      } else {
        bySession.set(ev.sessionId, { first: idx, minAt: ev.at, events: [ev] });
      }
    });

    let A: Mat = state.A.map((r) => r.slice());
    let b: Vec = state.b.slice();
    let sessionsObserved = state.sessionsObserved;
    let updatedAt = state.updatedAt;
    const recent = state.recentSessionIds.slice();

    const ordered = [...bySession.entries()].sort((x, y) => x[1].minAt - y[1].minAt || x[1].first - y[1].first);

    for (const [sessionId, group] of ordered) {
      if (recent.includes(sessionId)) {
        skippedSessions.push(sessionId);
        continue;
      }

      // Context x: prominence-weighted mix of normalized signatures.
      const prominence = new Map<number, number>();
      const interacted = new Set<number>();
      const outcomeByKind = new Map<string, number>();
      for (const ev of group.events) {
        if (ev.type === 'exposure') {
          const idx = indexOf.get(ev.elementId);
          if (idx === undefined) {
            warnings.push(`unknown elementId "${ev.elementId}" in session "${sessionId}" ignored`);
            continue;
          }
          prominence.set(idx, Math.max(prominence.get(idx) ?? 0, ev.prominence));
        } else if (ev.type === 'interaction') {
          const idx = indexOf.get(ev.elementId);
          if (idx === undefined) {
            warnings.push(`unknown elementId "${ev.elementId}" in session "${sessionId}" ignored`);
            continue;
          }
          interacted.add(idx);
        } else {
          const kind = ev.kind ?? 'target';
          if (!(kind in cfg.outcomeKinds)) {
            warnings.push(`unknown outcome kind "${kind}" in session "${sessionId}" ignored`);
            continue;
          }
          outcomeByKind.set(kind, Math.max(outcomeByKind.get(kind) ?? 0, ev.value));
        }
      }

      const exposed = [...prominence.entries()].filter(([, p]) => p > 0);
      const totalProminence = exposed.reduce((acc, [, p]) => acc + p, 0);
      if (!(totalProminence > 0)) {
        skippedSessions.push(sessionId);
        continue;
      }
      const x: Vec = new Array<number>(D).fill(0);
      for (const [idx, p] of exposed) {
        const w = cfg.signatures[idx] as Vec;
        for (let i = 0; i < D; i++) x[i] = (x[i] as number) + (p * (w[i] as number)) / totalProminence;
      }

      // Reward r.
      const kinds = Object.keys(cfg.outcomeKinds);
      if (cfg.missingOutcome === 'skip' && kinds.some((k) => !outcomeByKind.has(k))) {
        skippedSessions.push(sessionId);
        continue;
      }
      let num = 0;
      let den = 0;
      for (const k of kinds) {
        const w = cfg.outcomeKinds[k] as number;
        num += w * (outcomeByKind.get(k) ?? 0);
        den += w;
      }
      const rOut = num / den;
      const rInt = exposed.filter(([idx]) => interacted.has(idx)).length / exposed.length;
      const r = (1 - cfg.omega) * rOut + cfg.omega * rInt;

      // A <- gamma A + x x^T / s2 + (1-gamma) Lambda0 ; b <- gamma b + r x / s2 + (1-gamma) Lambda0 mu0.
      const g = cfg.gamma;
      const s2 = cfg.noiseVariance;
      A = A.map((row, i) =>
        row.map((a, j) => g * a + ((x[i] as number) * (x[j] as number)) / s2 + (1 - g) * ((cfg.lambda0[i] as Vec)[j] as number)),
      );
      b = b.map((bi, i) => g * bi + (r * (x[i] as number)) / s2 + (1 - g) * (cfg.lambda0Mu0[i] as number));

      sessionsObserved += 1;
      const maxAt = group.events.reduce((m, e) => Math.max(m, e.at), 0);
      updatedAt = updatedAt === null ? maxAt : Math.max(updatedAt, maxAt);
      recent.push(sessionId);
      if (recent.length > MAX_RECENT_SESSIONS) recent.splice(0, recent.length - MAX_RECENT_SESSIONS);
      processedSessions.push(sessionId);
    }

    const next: UserState = {
      ...structuredClone(state),
      A: A as Matrix6,
      b: b as Vector6,
      sessionsObserved,
      updatedAt,
      recentSessionIds: recent,
    };
    return { state: next, processedSessions, skippedSessions, warnings };
  }

  function explain(state: UserState): Explanation {
    checkState(state);
    const L = cholesky(state.A.map((r) => r.slice()));
    const mu = solveWithCholesky(L, state.b.slice());
    const level = mu.reduce((a, c) => a + c, 0) / D;
    const profile = mu.map((m) => m - level);
    // Uncertainty of the PROFILE (differences), not of the level: diag of P Sigma P.
    const S = inverseFromCholesky(L);
    const rowMean = S.map((row) => row.reduce((a, c) => a + c, 0) / D);
    const grand = rowMean.reduce((a, c) => a + c, 0) / D;
    const uncertainty = S.map((row, i) => Math.sqrt(Math.max(0, (row[i] as number) - 2 * (rowMean[i] as number) + grand)));
    return {
      profile: hexadFromVector(profile),
      level,
      uncertainty: hexadFromVector(uncertainty),
      sessionsObserved: state.sessionsObserved,
    };
  }

  return { neutralState, decide, update, explain };
}
