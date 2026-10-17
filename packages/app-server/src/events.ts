// Research event log. The client may only report exposure and interaction with known elements;
// userId, sessionId and "at" are stamped by the server, and outcomes are produced by the server (study.ts).
import Ajv2020 from 'ajv/dist/2020.js';
import { all, run, tx } from './db.ts';
import type { Db } from './db.ts';
import { HttpError } from './library.ts';
import { CATALOG_IDS, readSpecJson } from './spec.ts';

const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const name of ['common', 'catalog', 'config', 'event', 'state']) ajv.addSchema(readSpecJson(`schemas/${name}.schema.json`) as object);
const validateEvent = ajv.getSchema('urn:gamificacao-adaptativa:schema:event')!;

export interface ClientEvent {
  type?: unknown;
  elementId?: unknown;
  prominence?: unknown;
}

const MAX_BATCH = 100;

/**
 * Validates a batch from the client against the shared event schema and stores it. Returns how many were stored.
 * The stored prominence of an exposure is the weight the server decided for that element today (`weights`), not the
 * number the client sent: the log must reflect what the experiment decided, whatever a modified client reports.
 */
export function recordClientEvents(db: Db, userId: number, sessionId: string, now: number, items: unknown, weights: Record<string, number>): number {
  if (!Array.isArray(items)) throw new HttpError(400, 'esperava uma lista de eventos');
  if (items.length > MAX_BATCH) throw new HttpError(400, `no máximo ${MAX_BATCH} eventos por envio`);
  const rows: { type: string; elementId: string; prominence: number | null }[] = [];
  for (const raw of items as ClientEvent[]) {
    if (raw === null || typeof raw !== 'object') throw new HttpError(400, 'evento inválido');
    if (raw.type !== 'exposure' && raw.type !== 'interaction') throw new HttpError(400, 'o cliente só pode enviar exposure ou interaction');
    if (typeof raw.elementId !== 'string' || !CATALOG_IDS.has(raw.elementId)) throw new HttpError(400, `elementId desconhecido: ${String(raw.elementId)}`);
    const stamped = raw.type === 'exposure'
      ? { type: 'exposure', userId: `u${userId}`, sessionId, at: now, elementId: raw.elementId, prominence: raw.prominence }
      : { type: 'interaction', userId: `u${userId}`, sessionId, at: now, elementId: raw.elementId };
    if (!validateEvent(stamped)) throw new HttpError(400, `evento fora do esquema: ${ajv.errorsText(validateEvent.errors)}`);
    rows.push({ type: raw.type, elementId: raw.elementId, prominence: raw.type === 'exposure' ? (weights[raw.elementId] ?? 0.5) : null });
  }
  tx(db, () => {
    for (const r of rows) run(db, 'INSERT INTO events (user_id, session_id, type, at, element_id, prominence) VALUES (?, ?, ?, ?, ?, ?)', userId, sessionId, r.type, now, r.elementId, r.prominence);
  });
  return rows.length;
}

/** Anonymized export (no code, nickname or password): pseudonymous user id, group and the event rows. */
export function exportEventsCsv(db: Db): string {
  const rows = all<{ user_id: number; grp: string | null; session_id: string; type: string; at: number; element_id: string | null; prominence: number | null; kind: string | null; value: number | null }>(
    db,
    'SELECT e.user_id, u.grp, e.session_id, e.type, e.at, e.element_id, e.prominence, e.kind, e.value FROM events e JOIN users u ON u.id = e.user_id ORDER BY e.id',
  );
  const head = 'userId,group,sessionId,type,at,elementId,prominence,kind,value';
  const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return [head, ...rows.map((r) => [`u${r.user_id}`, r.grp, r.session_id, r.type, r.at, r.element_id, r.prominence, r.kind, r.value].map(cell).join(','))].join('\n') + '\n';
}
