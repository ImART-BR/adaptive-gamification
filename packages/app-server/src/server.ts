// Entry point: API + built web app. Run with: npm run start (after npm run build:web).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApp } from './app.ts';
import { openDb } from './db.ts';
import { seedContent } from './seed.ts';

const dbPath = process.env.DATA_PATH ?? './data/app.db';
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
seedContent(db, Date.now());

// The experiment (random assignment + adaptive interface) is OFF unless EXPERIMENT=on. Keep it off until the research ethics committee approves.
const experimentOn = process.env.EXPERIMENT === 'on';
console.log(`[server] experimento: ${experimentOn ? 'LIGADO (novos usuários são sorteados em adaptativo/controle)' : 'desligado (todos veem a interface uniforme)'}`);
const api = createApp(db, {
  secureCookies: process.env.SECURE_COOKIES === '1',
  experiment: {
    enabled: experimentOn,
    seed: process.env.ENGINE_SEED ? Number(process.env.ENGINE_SEED) : 1,
    rampDays: process.env.RAMP_DAYS ? Number(process.env.RAMP_DAYS) : undefined,
  },
});
const root = new Hono();
root.route('/', api);
// index.html must never be cached, otherwise a deploy keeps pointing at old hashed assets.
const noCacheHtml = (path: string, c: { header: (name: string, value: string) => void }) => {
  if (path.endsWith('.html')) c.header('Cache-Control', 'no-cache');
};
root.use('/*', serveStatic({ root: './packages/app-web/dist', onFound: noCacheHtml }));
root.get('*', serveStatic({ path: './packages/app-web/dist/index.html', onFound: noCacheHtml }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: root.fetch, port }, (info) => console.log(`[server] http://localhost:${info.port} (banco: ${dbPath})`));
