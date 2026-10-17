// Minimal use of the core: decide -> show the interface -> report what happened -> update.
// Run: node packages/core/examples/quickstart.ts
// This only shows the integration loop. It does not show that the engine learns: that needs many users and many days
// (run `npm run sim` in packages/simulator).
import { readFileSync } from 'node:fs';
import { applySoftStart, createEngine, softStartFactor } from '../src/index.ts';
import type { AdaptiveEvent, Catalog } from '../src/index.ts';

const catalog = JSON.parse(readFileSync(new URL('../../../spec/catalog.flashcards.json', import.meta.url), 'utf-8')) as Catalog;
const engine = createEngine({ schemaVersion: '0.1', catalog, seed: 1 });

let state = engine.neutralState('user-1'); // a JSON object: store it per user

for (let day = 0; day < 7; day++) {
  const sessionId = `day-${day}`;
  const at = Date.UTC(2026, 0, 1 + day);

  // 1. Ask for the weights (0..1) of every element and render the interface with them.
  //    The first decisions can be extreme, so shrink them toward 0.5 for the first 7 days (soft start).
  const decided = engine.decide(state, sessionId, at).weights;
  const weights = applySoftStart(decided, softStartFactor(day, 7));

  // 2. Report what was really shown (exposure), what the user touched (interaction) and the behaviour you want (outcome, 0..1).
  const events: AdaptiveEvent[] = catalog.elements.map((e) => ({
    type: 'exposure', userId: 'user-1', sessionId, at, elementId: e.id, prominence: weights[e.id]!,
  }));
  events.push({ type: 'interaction', userId: 'user-1', sessionId, at, elementId: 'points' });
  events.push({ type: 'outcome', userId: 'user-1', sessionId, at, value: 0.6 }); // e.g. fraction of the day's queue finished

  // 3. Learn from the finished session. Returns a NEW state; nothing is mutated.
  const result = engine.update(state, events);
  state = result.state;

  const top = Object.entries(weights).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, w]) => `${id} ${w.toFixed(2)}`);
  console.log(`day ${day + 1}: processed=${result.processedSessions.length} top weights: ${top.join(', ')}`);
}

console.log('explain():', engine.explain(state));
