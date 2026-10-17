import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySoftStart, softStartFactor } from '../src/index.ts';

test('softStartFactor: 0.25 on the first day, linear, 1 after the ramp; rampDays <= 1 disables it', () => {
  assert.equal(softStartFactor(0, 7), 0.25);
  assert.equal(softStartFactor(3, 7), 0.625);
  assert.equal(softStartFactor(6, 7), 1);
  assert.equal(softStartFactor(30, 7), 1);
  assert.equal(softStartFactor(-2, 7), 0.25);
  assert.equal(softStartFactor(0, 1), 1);
  assert.equal(softStartFactor(0, 0), 1);
  const ks = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => softStartFactor(n, 7));
  for (let i = 1; i < ks.length; i++) assert.ok(ks[i]! >= ks[i - 1]!, 'never decreases');
});

test('applySoftStart: shrinks toward the neutral weight, keeps order and floor, identity at k = 1', () => {
  const w = { a: 1, b: 0.5, c: 0.1, d: 0.8 };
  const half = applySoftStart(w, 0.5);
  assert.deepEqual(half, { a: 0.75, b: 0.5, c: 0.3, d: 0.65 });
  const order = (x: Record<string, number>) => Object.keys(x).sort((p, q) => x[q]! - x[p]!);
  assert.deepEqual(order(half), order(w));
  assert.deepEqual(applySoftStart(w, 1), w);
  assert.notEqual(applySoftStart(w, 1), w, 'returns a copy');
  const tiny = applySoftStart(w, 0.25);
  for (const v of Object.values(tiny)) assert.ok(v >= 0.375 - 1e-12 && v <= 0.625 + 1e-12);
  const floor = 0.1;
  for (const k of [0.25, 0.5, 0.9]) for (const v of Object.values(applySoftStart(w, k))) assert.ok(v >= floor);
});
