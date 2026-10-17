import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { createEngine } from '../src/index.ts';
import type { AdaptiveEvent } from '../src/index.ts';
import { baseConfig, readSpec } from './helpers.ts';

// Validates the JSON Schemas in spec/schemas against the shipped catalog, examples and the engine's own output.

function makeAjv() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const name of ['common', 'catalog', 'config', 'event', 'state']) {
    ajv.addSchema(readSpec(`schemas/${name}.schema.json`) as object);
  }
  return ajv;
}

const ajv = makeAjv();
const validator = (name: string) => {
  const v = ajv.getSchema(`urn:gamificacao-adaptativa:schema:${name}`);
  assert.ok(v, `schema ${name} not found`);
  return v;
};

test('all schemas compile in strict mode', () => {
  for (const name of ['common', 'catalog', 'config', 'event', 'state']) validator(name);
});

test('catalog.flashcards.json is a valid catalog', () => {
  const v = validator('catalog');
  assert.ok(v(readSpec('catalog.flashcards.json')), JSON.stringify(v.errors));
});

test('example events are valid', () => {
  const v = validator('event');
  for (const ev of readSpec('examples/events.session.json') as unknown[]) {
    assert.ok(v(ev), JSON.stringify(v.errors));
  }
});

test('engine config (defaults) is valid; unknown keys rejected', () => {
  const v = validator('config');
  assert.ok(v(baseConfig()), JSON.stringify(v.errors));
  assert.equal(v({ ...baseConfig(), bogus: 1 }), false);
  assert.equal(v({ ...baseConfig(), forgetting: 0 }), false);
  assert.equal(v({ ...baseConfig(), forgetting: 1.01 }), false);
});

test('states produced by the engine are valid (neutral, after decide, after update)', () => {
  const v = validator('state');
  const eng = createEngine(baseConfig());
  const s0 = eng.neutralState('u1');
  assert.ok(v(s0), JSON.stringify(v.errors));
  const d = eng.decide(s0, 's1', 1000);
  assert.ok(v(d.state), JSON.stringify(v.errors));
  const evs = readSpec('examples/events.session.json') as AdaptiveEvent[];
  const u = eng.update(d.state, evs.map((e) => ({ ...e, userId: 'u1' })));
  assert.deepEqual(u.processedSessions, ['s_001']);
  assert.ok(v(u.state), JSON.stringify(v.errors));
});

test('negative cases are rejected', () => {
  const ev = validator('event');
  const cat = validator('catalog');
  const base = { userId: 'u', sessionId: 's', at: 0 };
  assert.equal(ev({ type: 'exposure', ...base, elementId: 'e', prominence: 2 }), false);
  assert.equal(ev({ type: 'exposure', ...base, elementId: 'e' }), false);
  assert.equal(ev({ type: 'outcome', ...base, value: -0.1 }), false);
  assert.equal(ev({ type: 'click', ...base }), false);
  assert.equal(ev({ type: 'outcome', ...base, value: 0.5, extra: true }), false);
  const zero = { achiever: 0, player: 0, socialiser: 0, freeSpirit: 0, disruptor: 0, philanthropist: 0 };
  assert.equal(cat({ schemaVersion: '0.1', elements: [{ id: 'a', signature: zero }, { id: 'b', signature: { ...zero, player: 1 } }] }), false);
  assert.equal(cat({ schemaVersion: '0.1', elements: [{ id: 'a', signature: { ...zero, player: 1 } }] }), false);
});
