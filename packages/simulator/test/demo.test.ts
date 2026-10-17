import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Catalog } from '../../core/src/index.ts';
import { DEFAULT_PARAMS, churn, correlation, ensemble, runDemo } from '../src/demo.ts';
import type { DemoParams } from '../src/demo.ts';

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('../../../spec/catalog.flashcards.json', import.meta.url)), 'utf-8')) as Catalog;
const TYPES = ['achiever', 'player', 'socialiser', 'freeSpirit', 'disruptor', 'philanthropist'];
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const run = (over: Partial<DemoParams> = {}) => runDemo(catalog, { ...DEFAULT_PARAMS, ...over });

test('deterministic: same parameters, same history; another seed changes it', () => {
  assert.deepEqual(run(), run());
  assert.notDeepEqual(run().adaptive[5]!.weights, run({ seed: 99 }).adaptive[5]!.weights);
});

test('shape: one entry per day for each arm, 19 elements, hidden affinity centered', () => {
  const r = run({ days: 40 });
  assert.equal(r.adaptive.length, 40);
  assert.equal(r.control.length, 40);
  assert.equal(r.affinityAt.length, 40);
  assert.equal(r.elementIds.length, 19);
  assert.ok(Math.abs(r.affinityAt[0]!.reduce((a, b) => a + b, 0)) < 1e-9);
  for (const id of r.elementIds) assert.ok(r.elementType[id]! >= 0 && r.elementType[id]! <= 5);
  assert.ok(r.control.every((d) => d.profile === null));
});

test('control: uniform 0.5 every day; adaptive respects the floor and the soft start on day 1', () => {
  const r = run();
  for (const d of r.control) assert.ok(Object.values(d.weights).every((w) => w === 0.5));
  for (const d of r.adaptive) assert.ok(Object.values(d.weights).every((w) => w >= 0.1 - 1e-9 && w <= 1 + 1e-9));
  assert.ok(Object.values(r.adaptive[0]!.weights).every((w) => w >= 0.375 - 1e-9 && w <= 0.625 + 1e-9), 'day 1 is close to the default interface');
  assert.ok(churn(r.adaptive, 0) === 0);
  const noRamp = run({ rampDays: 1 });
  const w = Object.values(noRamp.adaptive[0]!.weights);
  assert.ok(Math.max(...w) - Math.min(...w) > 0.3, 'without the soft start the first day can already be far from uniform');
});

test('a Player user: the system finds Player, and the interface does better than the uniform one', () => {
  const r = run({ affinity: [0, 1, 0, 0, 0, 0], days: 120 });
  const last = r.adaptive[119]!.profile!;
  assert.equal(last.indexOf(Math.max(...last)), TYPES.indexOf('player'), `profile ${last.map((x) => x.toFixed(2)).join(',')}`);
  assert.ok(correlation(last, r.affinityAt[119]!) > 0.5);
  const gain = mean(r.adaptive.slice(80).map((d) => d.expected)) - mean(r.control.slice(80).map((d) => d.expected));
  assert.ok(gain > 0.02, `gain ${gain}`);
  // the elements that speak to Player are more featured at the end than those that speak to others
  const w = r.adaptive[119]!.weights;
  const playerElems = r.elementIds.filter((id) => r.elementType[id] === 1);
  const others = r.elementIds.filter((id) => r.elementType[id] !== 1);
  assert.ok(mean(playerElems.map((id) => w[id]!)) > mean(others.map((id) => w[id]!)));
});

test('a user without preference: the interface makes no difference to the result', () => {
  const r = run({ affinity: [0, 0, 0, 0, 0, 0] });
  for (let i = 0; i < r.adaptive.length; i++) assert.ok(Math.abs(r.adaptive[i]!.expected - r.control[i]!.expected) < 1e-9);
});

test('taste change: after it, the system moves toward the new type (on average; one person is noisy)', () => {
  const p = { ...DEFAULT_PARAMS, affinity: [1, 0, 0, 0, 0, 0], affinityAfter: [0, 0, 0, 0, 1, 0], changeDay: 60, days: 150 };
  const r = runDemo(catalog, p);
  assert.ok(r.affinityAt[0]![0]! > 0.5);
  assert.ok(r.affinityAt[149]![4]! > 0.5);
  const e = ensemble(catalog, p, 12);
  assert.ok(e.profile[58]![0]! > e.profile[58]![4]!, 'before the change: Achiever above Disruptor');
  assert.ok(e.profile[149]![4]! > e.profile[149]![0]!, 'at the end: Disruptor above Achiever');
});

test('ensemble: on average the profile is found and the interface beats the uniform one', () => {
  const e = ensemble(catalog, { ...DEFAULT_PARAMS, affinity: [0, 0, 0, 1, 0, 0] }, 12);
  assert.equal(e.runs, 12);
  assert.equal(e.gain.length, 120);
  assert.ok(e.corr[119]! > 0.4, `correlation ${e.corr[119]}`);
  assert.ok(mean(e.gain.slice(80)) > 0.015, `gain ${mean(e.gain.slice(80))}`);
  assert.ok(mean(e.gain.slice(0, 5)) < mean(e.gain.slice(80)), 'the gain grows with time');
});

test('no randomness leaks between the arms: luck is the same, so with no effect the outcomes are identical', () => {
  const r = run({ effect: 0 });
  for (let i = 0; i < r.adaptive.length; i++) assert.equal(r.adaptive[i]!.outcome, r.control[i]!.outcome);
});

test('correlation helper', () => {
  assert.equal(correlation([1, 2, 3], [2, 4, 6]), 1);
  assert.equal(correlation([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(correlation([1, 1, 1], [1, 2, 3]), 0);
});
