// Anonymized research export: node packages/app-server/src/export.ts [out-dir]   (default ./data/export)
// Writes events.csv, decisions.csv, profiles.csv and daily.csv.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { exportDailyCsv, exportDecisionsCsv, exportEventsCsv, exportProfilesCsv } from './exports.ts';

const db = openDb(process.env.DATA_PATH ?? './data/app.db');
const dir = process.argv[2] ?? './data/export';
mkdirSync(dir, { recursive: true });
const files: [string, string][] = [
  ['events.csv', exportEventsCsv(db)],
  ['decisions.csv', exportDecisionsCsv(db)],
  ['profiles.csv', exportProfilesCsv(db)],
  ['daily.csv', exportDailyCsv(db)],
];
for (const [name, text] of files) {
  writeFileSync(join(dir, name), text, 'utf-8');
  console.log(`[export] ${join(dir, name)} (${text.split('\n').length - 2} linhas)`);
}
