import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import type { AppOptions } from '../src/app.ts';
import { openDb } from '../src/db.ts';
import { seedContent } from '../src/seed.ts';

export const T0 = Date.UTC(2026, 9, 19, 15, 0, 0); // Monday 2026-10-19 12:00 in UTC-3
export const MIN = 60_000;
export const DAY = 86_400_000;

export type Client = ReturnType<ReturnType<typeof setup>['client']>;

export function setup(options: Omit<AppOptions, 'clock'> = {}) {
  const db = openDb(':memory:');
  seedContent(db, T0);
  let now = T0;
  const app = createApp(db, { ...options, clock: () => now });
  const clock = { set: (t: number) => (now = t), advance: (ms: number) => (now += ms), get: () => now };

  function client() {
    let cookie = '';
    async function call(method: string, path: string, body?: unknown) {
      const res = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
    }
    return {
      get: (p: string) => call('GET', p),
      post: (p: string, b?: unknown) => call('POST', p, b ?? {}),
      patch: (p: string, b: unknown) => call('PATCH', p, b),
      del: (p: string) => call('DELETE', p),
    };
  }

  async function newUser(password?: string) {
    const c = client();
    const r = await c.post('/api/auth/register', { consent: true, ...(password ? { password } : {}) });
    assert.equal(r.status, 200);
    return { c, code: r.json.code as string };
  }

  async function withDeckInLibrary(c: ReturnType<typeof client>, title = 'Capitais do Brasil') {
    const cat = await c.get('/api/catalog');
    const deck = cat.json.find((d: any) => d.title === title);
    assert.ok(deck, 'seed deck not found');
    const r = await c.post(`/api/decks/${deck.id}/library`);
    assert.equal(r.status, 200);
    return deck.id as number;
  }

  /** The user's public handle (needed to send gifts). Read from the database: the API never returns your own handle. */
  function handleOf(nickname: string): string {
    const row = db.prepare('SELECT handle FROM users WHERE nickname = ?').get(nickname) as { handle: string } | undefined;
    assert.ok(row, `no user with nickname ${nickname}`);
    return row.handle;
  }

  return { db, app, clock, client, newUser, withDeckInLibrary, handleOf };
}
