// Contract types of the adaptive gamification core (draft v0.1).
// Source of truth for formats: spec/schemas/*.schema.json. Semantics: see the Core section of the README.
// The core has no I/O, no network and imports nothing from any app.

export const HEXAD_TYPES = [
  'achiever',
  'player',
  'socialiser',
  'freeSpirit',
  'disruptor',
  'philanthropist',
] as const;

export type HexadType = (typeof HEXAD_TYPES)[number];

/** One number per Hexad type. */
export type HexadVector = Record<HexadType, number>;

/** Fixed-order arrays: index i corresponds to HEXAD_TYPES[i]. */
export type Vector6 = [number, number, number, number, number, number];
export type Matrix6 = [Vector6, Vector6, Vector6, Vector6, Vector6, Vector6];

export interface GameElement {
  id: string;
  /** Non-negative weights; at least one > 0. Normalized internally to sum 1. A prior, not ground truth. */
  signature: HexadVector;
  label?: string;
  /** Different implementations of the same strategy should be different elements. */
  variant?: string;
}

export interface Catalog {
  schemaVersion: '0.1';
  elements: GameElement[];
}

export interface EngineConfig {
  schemaVersion: '0.1';
  catalog: Catalog;
  /** gamma in (0,1]. Default 0.98 (calibrated; see DEFAULTS in engine.ts). */
  forgetting?: number;
  /** sigma_delta^2: prior variance of the differences between dimensions. Default 0.5. Ignored when priorCovariance is given. */
  priorVariance?: number;
  /** sigma_c^2: prior variance of the level (mean of the 6 dimensions = reward intercept). Default 100 (nearly diffuse). Ignored when priorCovariance is given. */
  levelPriorVariance?: number;
  /** mu0. Default: zeros (neutral). */
  priorMean?: HexadVector;
  /** Sigma0, symmetric positive definite, Hexad order (hook for population priors). */
  priorCovariance?: Matrix6;
  /** Observation noise variance as the model sees it. Default 0.05 (calibrated; estimate from pilot data). */
  noiseVariance?: number;
  /** v in mu + v*chol(Sigma)*z. Default 0.15 (nearly greedy; gives up the v > 1 regret theory on purpose). */
  samplingScale?: number;
  /** Minimum output weight. Default 0.1. */
  exposureFloor?: number;
  /** Output weight under the neutral profile. Default 0.5. */
  neutralWeight?: number;
  /** Gain from score difference to weight. Default 16 (calibrated). */
  sensitivity?: number;
  /** Weight of each outcome kind in the session reward. Default { target: 1 }. */
  outcomeKinds?: Record<string, number>;
  /** Closed session without a configured outcome kind: count as 0 or skip. Default 'zero'. */
  missingOutcome?: 'zero' | 'skip';
  /** omega: weight of the auxiliary interaction signal. Default 0.05. */
  interactionRewardWeight?: number;
  /** Seed of the deterministic generator. Default 0. */
  seed?: number;
}

// ---- Events -----------------------------------------------------------

interface EventBase {
  userId: string;
  sessionId: string;
  /** Epoch milliseconds. */
  at: number;
}

export interface ExposureEvent extends EventBase {
  type: 'exposure';
  elementId: string;
  /** In [0,1]. 0 = not actually visible (ignored). */
  prominence: number;
}

export interface InteractionEvent extends EventBase {
  type: 'interaction';
  elementId: string;
}

export interface OutcomeEvent extends EventBase {
  type: 'outcome';
  /** Key into EngineConfig.outcomeKinds. Default 'target'. */
  kind?: string;
  /** In [0,1]. */
  value: number;
}

export type AdaptiveEvent = ExposureEvent | InteractionEvent | OutcomeEvent;

// ---- State -----------------------------------------------------------

export interface LastDecision {
  sessionId: string;
  at: number;
  weights: Record<string, number>;
  sampledProfile: Vector6;
}

/** JSON-serializable. Independent of the catalog: lives in the 6-dimensional Hexad space. */
export interface UserState {
  schemaVersion: '0.1';
  userId: string;
  dimensions: typeof HEXAD_TYPES;
  /** Posterior precision matrix; Sigma = A^-1. */
  A: Matrix6;
  /** mu = A^-1 b. */
  b: Vector6;
  sessionsObserved: number;
  updatedAt: number | null;
  rng: { seed: number; counter: number };
  lastDecision: LastDecision | null;
  /** Last processed session ids (cap 64), for idempotent update(). */
  recentSessionIds: string[];
}

// ---- API -------------------------------------------------------------------

export interface Decision {
  sessionId: string;
  /** { elementId -> weight in [0,1] }, never below config.exposureFloor. */
  weights: Record<string, number>;
  state: UserState;
  /** True when sessionId had already been decided: the stored decision is returned unchanged. */
  reused: boolean;
}

export interface UpdateResult {
  state: UserState;
  /** Sessions that changed the state in this call. */
  processedSessions: string[];
  /** Sessions skipped as duplicates, empty, or without outcome (when missingOutcome = 'skip'). */
  skippedSessions: string[];
  /** Non-fatal problems: unknown elementId, unknown outcome kind, userId mismatch. */
  warnings: string[];
}

export interface Explanation {
  /** mu minus its mean over dimensions. All zeros = neutral. */
  profile: HexadVector;
  /** Mean of mu over dimensions: the estimated level (intercept) of the user's session reward. Does not affect output weights. */
  level: number;
  /** Posterior standard deviation of the PROFILE (differences between dimensions, level removed): sqrt of diag(P Sigma P). */
  uncertainty: HexadVector;
  sessionsObserved: number;
}

export interface AdaptiveEngine {
  neutralState(userId: string): UserState;
  /** Idempotent per sessionId: called twice for the same session, returns the same weights. */
  decide(state: UserState, sessionId: string, at: number): Decision;
  /** Receives COMPLETE sessions. Pure: returns a new state. */
  update(state: UserState, events: AdaptiveEvent[]): UpdateResult;
  explain(state: UserState): Explanation;
}
