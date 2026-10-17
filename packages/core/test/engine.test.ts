import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, DEFAULTS, HEXAD_TYPES } from '../src/index.ts';
import type { AdaptiveEvent } from '../src/index.ts';
import { baseConfig } from './helpers.ts';

const DAY = 86_400_000;

function session(userId: string, sessionId: string, at: number, exposures: Record<string, number>, opts: { interact?: string[]; outcome?: number | null } = {}): AdaptiveEvent[] {
  const evs: AdaptiveEvent[] = Object.entries(exposures).map(([elementId, prominence]) => ({ type: 'exposure', userId, sessionId, at, elementId, prominence }));
  for (const elementId of opts.interact ?? []) evs.push({ type: 'interaction', userId, sessionId, at: at + 1000, elementId });
  if (opts.outcome !== null && opts.outcome !== undefined) evs.push({ type: 'outcome', userId, sessionId, at: at + 3600_000, kind: 'target', value: opts.outcome });
  return evs;
}

test('defaults are the calibrated ones and the engine accepts them', () => {
  assert.deepEqual(DEFAULTS, {
    forgetting: 0.98,
    priorVariance: 0.5,
    levelPriorVariance: 100,
    noiseVariance: 0.05,
    samplingScale: 0.15,
    sensitivity: 16,
    exposureFloor: 0.1,
    neutralWeight: 0.5,
    interactionRewardWeight: 0.05,
  });
});

test('neutral state: profile zero, uncertainty equal, level zero', () => {
  const eng = createEngine(baseConfig());
  const s = eng.neutralState('u1');
  const ex = eng.explain(s);
  for (const t of HEXAD_TYPES) {
    assert.ok(Math.abs(ex.profile[t]) < 1e-12, `profile ${t}`);
    assert.ok(Math.abs(ex.uncertainty[t] - ex.uncertainty.achiever) < 1e-9, `uncertainty ${t}`);
  }
  assert.ok(Math.abs(ex.level) < 1e-12);
  assert.equal(ex.sessionsObserved, 0);
});

test('neutral state is JSON-serializable and round-trips', () => {
  const eng = createEngine(baseConfig());
  const s = eng.neutralState('u1');
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('decide: weights respect floor and [0,1], cover the whole catalog', () => {
  const eng = createEngine(baseConfig({ sensitivity: 20, exposureFloor: 0.15 }));
  let s = eng.neutralState('u1');
  for (let i = 0; i < 200; i++) {
    const d = eng.decide(s, `s${i}`, i * DAY);
    s = d.state;
    assert.equal(Object.keys(d.weights).length, 19);
    for (const w of Object.values(d.weights)) {
      assert.ok(w >= 0.15 - 1e-12 && w <= 1 + 1e-12, `weight ${w}`);
    }
  }
});

test('decide: idempotent per sessionId, no randomness consumed on reuse', () => {
  const eng = createEngine(baseConfig());
  const s0 = eng.neutralState('u1');
  const d1 = eng.decide(s0, 'sA', 1000);
  assert.equal(d1.reused, false);
  const d2 = eng.decide(d1.state, 'sA', 2000);
  assert.equal(d2.reused, true);
  assert.deepEqual(d2.weights, d1.weights);
  assert.equal(d2.state.rng.counter, d1.state.rng.counter);
  const d3 = eng.decide(d2.state, 'sB', 3000);
  assert.equal(d3.reused, false);
  assert.ok(d3.state.rng.counter > d2.state.rng.counter);
});

test('decide/update are pure: inputs are not mutated', () => {
  const eng = createEngine(baseConfig());
  const s0 = eng.neutralState('u1');
  const snap = JSON.stringify(s0);
  const d = eng.decide(s0, 's1', 1000);
  assert.equal(JSON.stringify(s0), snap);
  const snap1 = JSON.stringify(d.state);
  eng.update(d.state, session('u1', 's1', 1000, { points: 0.8 }, { outcome: 0.5 }));
  assert.equal(JSON.stringify(d.state), snap1);
});

test('determinism: same seed and same history give identical decisions; different seeds differ', () => {
  const run = (seed: number) => {
    const eng = createEngine(baseConfig({ seed }));
    let s = eng.neutralState('u1');
    const out: Record<string, number>[] = [];
    for (let i = 0; i < 5; i++) {
      const d = eng.decide(s, `s${i}`, i * DAY);
      out.push(d.weights);
      const exposures = Object.fromEntries(Object.entries(d.weights));
      s = eng.update(d.state, session('u1', `s${i}`, i * DAY, exposures, { outcome: 0.6 })).state;
    }
    return out;
  };
  assert.deepEqual(run(7), run(7));
  assert.notDeepEqual(run(7), run(8));
});

test('users with the same seed draw different samples (userId is part of the stream)', () => {
  const eng = createEngine(baseConfig());
  const a = eng.decide(eng.neutralState('alice'), 's1', 0);
  const b = eng.decide(eng.neutralState('bob'), 's1', 0);
  assert.notDeepEqual(a.weights, b.weights);
});

test('sampled theta has the covariance A^-1 (moment check on the neutral prior)', () => {
  // Level direction has prior variance 100 and differences 0.25 (explicit): check the difference part.
  // samplingScale 1 = plain Thompson Sampling, so the sample covariance is exactly A^-1.
  const eng = createEngine(baseConfig({ priorVariance: 0.25, samplingScale: 1 }));
  const N = 4000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < N; i++) {
    const d = eng.decide(eng.neutralState(`user${i}`), 's', 0);
    const th = d.state.lastDecision!.sampledProfile;
    const m = th.reduce((a, c) => a + c, 0) / 6;
    const delta0 = th[0] - m;
    sum += delta0;
    sumSq += delta0 * delta0;
  }
  const mean = sum / N;
  const variance = sumSq / N - mean * mean;
  // Var(delta_0) = sigma_delta^2 * (1 - 1/6) = 0.25 * 5/6 = 0.2083
  assert.ok(Math.abs(mean) < 0.03, `mean ${mean}`);
  assert.ok(Math.abs(variance - 0.25 * (5 / 6)) < 0.02, `variance ${variance}`);
});

test('update: processes a complete session; idempotent on resend', () => {
  const eng = createEngine(baseConfig());
  const s0 = eng.neutralState('u1');
  const evs = session('u1', 's1', 1000, { points: 0.8, study_groups: 0.3, levels: 0.5 }, { interact: ['points'], outcome: 0.75 });
  const r1 = eng.update(s0, evs);
  assert.deepEqual(r1.processedSessions, ['s1']);
  assert.equal(r1.state.sessionsObserved, 1);
  assert.ok(r1.state.updatedAt !== null && r1.state.updatedAt >= 1000);
  const r2 = eng.update(r1.state, evs);
  assert.deepEqual(r2.processedSessions, []);
  assert.deepEqual(r2.skippedSessions, ['s1']);
  assert.deepEqual(r2.state.A, r1.state.A);
  assert.deepEqual(r2.state.b, r1.state.b);
});

test('update: matches the model formula (hand computation, gamma = 1)', () => {
  const eng = createEngine(baseConfig({ forgetting: 1, noiseVariance: 0.25, priorVariance: 0.25, levelPriorVariance: 100, interactionRewardWeight: 0 }));
  const s0 = eng.neutralState('u1');
  // single element exposed: x = normalized signature of 'points'
  const r = eng.update(s0, session('u1', 's1', 1000, { points: 1 }, { outcome: 0.6 }));
  const sig = { achiever: 0.2, player: 0.6, socialiser: 0.05, freeSpirit: 0.05, disruptor: 0.05, philanthropist: 0.05 };
  const x = HEXAD_TYPES.map((t) => sig[t]);
  const lambda0 = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => ((i === j ? 1 : 0) - 1 / 6) / 0.25 + 1 / 6 / 100));
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      const expected = lambda0[i]![j]! + (x[i]! * x[j]!) / 0.25;
      assert.ok(Math.abs(r.state.A[i]![j]! - expected) < 1e-9, `A[${i}][${j}]`);
    }
    assert.ok(Math.abs(r.state.b[i]! - (0.6 * x[i]!) / 0.25) < 1e-9, `b[${i}]`);
  }
});

test('update: missing outcome counts as 0 by default, session skipped with missingOutcome=skip', () => {
  const evs = session('u1', 's1', 1000, { points: 0.8, levels: 0.4 }, { outcome: null });
  const zero = createEngine(baseConfig({ interactionRewardWeight: 0 }));
  const rz = zero.update(zero.neutralState('u1'), evs);
  assert.deepEqual(rz.processedSessions, ['s1']);
  const skip = createEngine(baseConfig({ missingOutcome: 'skip' }));
  const rs = skip.update(skip.neutralState('u1'), evs);
  assert.deepEqual(rs.processedSessions, []);
  assert.deepEqual(rs.skippedSessions, ['s1']);
});

test('update: session without exposure is skipped and not remembered', () => {
  const eng = createEngine(baseConfig());
  const only = [{ type: 'outcome', userId: 'u1', sessionId: 's1', at: 5, kind: 'target', value: 1 }] as AdaptiveEvent[];
  const r = eng.update(eng.neutralState('u1'), only);
  assert.deepEqual(r.skippedSessions, ['s1']);
  assert.deepEqual(r.state.recentSessionIds, []);
});

test('update: warnings for unknown element, unknown kind and foreign user; no throw', () => {
  const eng = createEngine(baseConfig());
  const evs: AdaptiveEvent[] = [
    ...session('u1', 's1', 1000, { points: 0.5, ghost: 0.5 }, { outcome: 0.5 }),
    { type: 'outcome', userId: 'u1', sessionId: 's1', at: 1002, kind: 'weird', value: 1 },
    ...session('other', 'sX', 1000, { points: 1 }, { outcome: 1 }),
  ];
  const r = eng.update(eng.neutralState('u1'), evs);
  assert.deepEqual(r.processedSessions, ['s1']);
  assert.equal(r.warnings.length, 3);
});

test('update: invalid input throws', () => {
  const eng = createEngine(baseConfig());
  const s = eng.neutralState('u1');
  assert.throws(() => eng.update(s, [{ type: 'exposure', userId: 'u1', sessionId: 's', at: 0, elementId: 'points', prominence: 2 }]), /prominence/);
  assert.throws(() => eng.update(s, [{ type: 'outcome', userId: 'u1', sessionId: 's', at: 0, value: -1 }]), /value/);
  assert.throws(() => eng.update(s, [{ type: 'exposure', userId: 'u1', sessionId: '', at: 0, elementId: 'points', prominence: 1 }]), /sessionId/);
});

test('update: sessions in a batch are processed chronologically', () => {
  const eng = createEngine(baseConfig());
  const late = session('u1', 'late', 5000, { points: 1 }, { outcome: 1 });
  const early = session('u1', 'early', 1000, { levels: 1 }, { outcome: 0 });
  const r = eng.update(eng.neutralState('u1'), [...late, ...early]);
  assert.deepEqual(r.processedSessions, ['early', 'late']);
});

test('recentSessionIds is capped at 64', () => {
  const eng = createEngine(baseConfig());
  let s = eng.neutralState('u1');
  for (let i = 0; i < 80; i++) s = eng.update(s, session('u1', `s${i}`, i * 1000, { points: 1 }, { outcome: 0.5 })).state;
  assert.equal(s.recentSessionIds.length, 64);
  assert.equal(s.recentSessionIds.at(-1), 's79');
});

const PLAYER_HEAVY: Record<string, number> = { points: 1, leaderboard: 0.8 };
const SOCIAL_HEAVY: Record<string, number> = { study_groups: 1, activity_feed: 0.8 };

test('learning: exposure of Player-heavy elements followed by high reward raises Player relative to others', () => {
  const eng = createEngine(baseConfig());
  let s = eng.neutralState('u1');
  for (let i = 0; i < 40; i++) {
    // alternate: player-heavy sessions succeed, social-heavy sessions fail
    const good = i % 2 === 0;
    const exposures = good ? PLAYER_HEAVY : SOCIAL_HEAVY;
    s = eng.update(s, session('u1', `s${i}`, i * DAY, exposures, { outcome: good ? 0.9 : 0.2 })).state;
  }
  const ex = eng.explain(s);
  assert.ok(ex.profile.player > ex.profile.socialiser + 0.1, `player ${ex.profile.player} vs socialiser ${ex.profile.socialiser}`);
  assert.ok(ex.level > 0.3, `level ${ex.level}`);
  // uncertainty must have shrunk relative to neutral
  const u0 = eng.explain(eng.neutralState('u1')).uncertainty.player;
  assert.ok(ex.uncertainty.player < u0);
});

test('forgetting: with gamma < 1 the profile follows a change of taste faster than with gamma = 1', () => {
  const run = (forgetting: number) => {
    const eng = createEngine(baseConfig({ forgetting }));
    let s = eng.neutralState('u1');
    for (let i = 0; i < 60; i++) {
      const good = i % 2 === 0;
      const ex = good ? PLAYER_HEAVY : SOCIAL_HEAVY;
      s = eng.update(s, session('u1', `a${i}`, i * DAY, ex, { outcome: good ? 0.9 : 0.2 })).state;
    }
    for (let i = 0; i < 30; i++) {
      const good = i % 2 === 1; // taste flips
      const ex = good ? PLAYER_HEAVY : SOCIAL_HEAVY;
      s = eng.update(s, session('u1', `b${i}`, (100 + i) * DAY, ex, { outcome: good ? 0.2 : 0.9 })).state;
    }
    const p = eng.explain(s).profile;
    return p.socialiser - p.player;
  };
  assert.ok(run(0.95) > run(1), `forgetful ${run(0.95)} vs none ${run(1)}`);
});

test('prior injection: priorMean shifts the neutral profile; priorCovariance is honoured', () => {
  const eng = createEngine(
    baseConfig({
      priorMean: { achiever: 0.5, player: 0, socialiser: 0, freeSpirit: 0, disruptor: 0, philanthropist: 0 },
      priorCovariance: Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => (i === j ? 0.04 : 0))) as never,
    }),
  );
  const ex = eng.explain(eng.neutralState('u1'));
  assert.ok(ex.profile.achiever > 0.3);
  assert.ok(ex.profile.player < 0);
  assert.ok(Math.abs(ex.uncertainty.player - 0.2 * Math.sqrt(5 / 6)) < 1e-6);
});

test('config validation', () => {
  const cat = baseConfig().catalog;
  assert.throws(() => createEngine(baseConfig({ forgetting: 0 })), /forgetting/);
  assert.throws(() => createEngine(baseConfig({ forgetting: 1.5 })), /forgetting/);
  assert.throws(() => createEngine(baseConfig({ exposureFloor: 2 })), /exposureFloor/);
  assert.throws(() => createEngine(baseConfig({ catalog: { schemaVersion: '0.1', elements: [cat.elements[0]!] } })), /at least 2/);
  assert.throws(
    () => createEngine(baseConfig({ catalog: { schemaVersion: '0.1', elements: [cat.elements[0]!, cat.elements[0]!] } })),
    /duplicate/,
  );
  const zeroSig = { id: 'z', signature: { achiever: 0, player: 0, socialiser: 0, freeSpirit: 0, disruptor: 0, philanthropist: 0 } };
  assert.throws(() => createEngine(baseConfig({ catalog: { schemaVersion: '0.1', elements: [cat.elements[0]!, zeroSig] } })), /signature/);
  assert.throws(() => createEngine(baseConfig({ priorCovariance: Array.from({ length: 6 }, () => new Array(6).fill(0)) as never })), /positive definite/);
});

test('neutral weights: all elements get neutralWeight under a neutral posterior mean (sensitivity does not matter at the mean)', () => {
  // With samplingScale tiny, theta ~= mu = 0, so every score is 0 and every weight = neutralWeight.
  const eng = createEngine(baseConfig({ samplingScale: 1e-9, neutralWeight: 0.6, sensitivity: 50 }));
  const d = eng.decide(eng.neutralState('u1'), 's', 0);
  for (const w of Object.values(d.weights)) assert.ok(Math.abs(w - 0.6) < 1e-6);
});
