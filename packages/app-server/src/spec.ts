import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Catalog } from '../../core/src/index.ts';

/** Reads a JSON file from the repository's spec/ folder (schemas, catalog). */
export function readSpecJson(rel: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../../spec/${rel}`, import.meta.url)), 'utf-8'));
}

export const CATALOG: Catalog = readSpecJson('catalog.flashcards.json') as Catalog;
export const CATALOG_IDS: Set<string> = new Set(CATALOG.elements.map((e) => e.id));
