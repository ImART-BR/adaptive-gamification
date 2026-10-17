import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Catalog, EngineConfig } from '../src/index.ts';

export function readSpec(relPath: string): unknown {
  const url = new URL(`../../../spec/${relPath}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf-8'));
}

export function flashcardCatalog(): Catalog {
  return readSpec('catalog.flashcards.json') as Catalog;
}

export function baseConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return { schemaVersion: '0.1', catalog: flashcardCatalog(), seed: 42, ...overrides };
}
