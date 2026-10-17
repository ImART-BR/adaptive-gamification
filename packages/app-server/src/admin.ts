// Research-team commands for content that has no human owner in the app.
//   node packages/app-server/src/admin.ts suggestions            list pending edit suggestions on team decks
//   node packages/app-server/src/admin.ts accept <id>            accept one (applies the edit, rewards the author)
//   node packages/app-server/src/admin.ts reject <id>
//   node packages/app-server/src/admin.ts proposals              ideas ranked by votes
import { decideSuggestion, pendingForTeam, listProposals } from './community.ts';
import { all, openDb } from './db.ts';
import { refreshProgress } from './study.ts';

const db = openDb(process.env.DATA_PATH ?? './data/app.db');
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'suggestions') {
  const rows = pendingForTeam(db);
  if (rows.length === 0) console.log('[admin] nenhuma sugestão pendente');
  for (const s of rows) {
    console.log(`#${s.id} [${s.deckTitle}] ${s.user.nickname}: "${s.currentFront}" → ${s.newFront !== null ? `frente "${s.newFront}"` : ''}${s.newBack !== null ? ` verso "${s.newBack}"` : ''}${s.note ? ` (${s.note})` : ''}`);
  }
} else if ((cmd === 'accept' || cmd === 'reject') && Number.isInteger(Number(arg))) {
  const { suggesterId } = decideSuggestion(db, null, Date.now(), Number(arg), cmd === 'accept');
  if (cmd === 'accept') refreshProgress(db, suggesterId, Date.now());
  console.log(`[admin] sugestão ${arg}: ${cmd === 'accept' ? 'aceita' : 'recusada'}`);
} else if (cmd === 'proposals') {
  const users = all<{ id: number }>(db, 'SELECT id FROM users LIMIT 1')[0];
  for (const p of listProposals(db, users?.id ?? 0).proposals) console.log(`${String(p.votes).padStart(3)} votos  #${p.id} ${p.title}`);
} else {
  console.log('uso: admin.ts suggestions | accept <id> | reject <id> | proposals');
}
