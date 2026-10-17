// Calibration round. Random search over the engine parameters on TRAIN worlds, a ratio-vs-churn frontier,
// re-evaluation of frontier points with fresh users, and validation on HELD-OUT worlds the search never saw.
// The worlds are synthetic and mine: this chooses defaults that are robust across them, not "the truth".
// Run: node packages/simulator/src/calibrate.ts   (CAL_QUICK=1 for a smoke run; PROPOSAL_CHURN=0.1 picks the frontier point
// used for the sensitivity table). Writes the report to docs/CALIBRACAO_F2_RESULTADOS.md (local, unversioned).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Catalog, EngineConfig } from '../../core/src/index.ts';
import { DEFAULT_WORLD, churnOf, hexadPolicy, makeWorld, mean, meanCI, mulberry32, oraclePolicy, runPolicy, uniformPolicy, windowMean } from './sim.ts';
import type { SimUser, UserTrace, WorldParams } from './sim.ts';

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('../../../spec/catalog.flashcards.json', import.meta.url)), 'utf-8')) as Catalog;
const IDS = catalog.elements.map((e) => e.id);
const QUICK = process.env.CAL_QUICK === '1';
const PROPOSAL_CHURN = Number(process.env.PROPOSAL_CHURN ?? 0.1);

interface WorldSpec {
  name: string;
  params: Partial<WorldParams>;
  changeAt?: number;
}

const TRAIN: WorldSpec[] = [
  { name: 'base', params: {} },
  { name: 'efeito fraco (κ 0,25)', params: { kappa: 0.25 } },
  { name: 'efeito forte (κ 1,0)', params: { kappa: 1.0 } },
  { name: 'resultado ruidoso (0,30)', params: { outcomeNoise: 0.3 } },
  { name: 'resultado limpo (0,05)', params: { outcomeNoise: 0.05 } },
  { name: 'assinaturas erradas + idiossincrático', params: { signatureNoise: 0.15, idiosyncratic: 0.5 } },
  { name: 'mudança de gosto na sessão 61', params: {}, changeAt: 60 },
  { name: 'efeito fraco e ruidoso (κ 0,3; 0,30)', params: { kappa: 0.3, outcomeNoise: 0.3 } },
];

const HELD_OUT: WorldSpec[] = [
  { name: 'κ 0,4; ruído 0,20', params: { kappa: 0.4, outcomeNoise: 0.2 } },
  { name: 'κ 0,8; assinaturas muito erradas (0,30)', params: { kappa: 0.8, signatureNoise: 0.3 } },
  { name: 'idiossincrático 1,0', params: { idiosyncratic: 1.0 } },
  { name: 'mudança na sessão 41; κ 0,5', params: { kappa: 0.5 }, changeAt: 40 },
  { name: 'efeito muito fraco (κ 0,15; ruído 0,10)', params: { kappa: 0.15, outcomeNoise: 0.1 } },
];

const FROM = 20;
const TO = 120;
const N_SESS = 120;

interface Baseline {
  uni: UserTrace[];
  ceiling: number;
  registry: Map<string, SimUser>;
  world: ReturnType<typeof makeWorld>;
}

const baselineCache = new Map<string, Baseline>();

function baseline(spec: WorldSpec, nUsers: number, seed: number): Baseline {
  const key = `${spec.name}|${nUsers}|${seed}`;
  const hit = baselineCache.get(key);
  if (hit) return hit;
  const world = makeWorld(catalog, { ...DEFAULT_WORLD, ...spec.params }, seed + 1);
  const registry = new Map<string, SimUser>();
  const opts = { nUsers, nSessions: N_SESS, world, seed };
  const uni = runPolicy(uniformPolicy(IDS), opts, registry);
  // Ceiling: full-information hard oracle in the world WITHOUT the late change (it does not know about the change).
  const orc = runPolicy(oraclePolicy(world, registry), opts, registry);
  const ceiling = mean(orc.map((t, i) => windowMean(t, 'p', FROM, TO) - windowMean(uni[i] as UserTrace, 'p', FROM, TO)));
  const b = { uni, ceiling, registry, world };
  baselineCache.set(key, b);
  return b;
}

interface Params {
  sensitivity: number;
  priorVariance: number;
  noiseVariance: number;
  samplingScale: number;
  forgetting: number;
}

function toConfig(p: Params): EngineConfig {
  return { schemaVersion: '0.1', catalog, seed: 7, ...p };
}

function evalConfig(p: Params, specs: WorldSpec[], nUsers: number, seed: number) {
  const cfg = toConfig(p);
  const perWorld = specs.map((spec) => {
    const b = baseline(spec, nUsers, seed);
    const tr = runPolicy(hexadPolicy('c', cfg), { nUsers, nSessions: N_SESS, world: b.world, seed, changeAt: spec.changeAt, keepWeights: true }, b.registry);
    const lifts = tr.map((t, i) => windowMean(t, 'p', FROM, TO) - windowMean(b.uni[i] as UserTrace, 'p', FROM, TO));
    const { m, half } = meanCI(lifts);
    return { name: spec.name, lift: m, half, ratio: m / b.ceiling, ceiling: b.ceiling, churn: mean(tr.map(churnOf)) };
  });
  return {
    perWorld,
    meanRatio: mean(perWorld.map((w) => w.ratio)),
    worstRatio: Math.min(...perWorld.map((w) => w.ratio)),
    churn: mean(perWorld.map((w) => w.churn)),
  };
}

const logU = (rng: () => number, lo: number, hi: number) => Math.exp(Math.log(lo) + rng() * (Math.log(hi) - Math.log(lo)));
const out: string[] = [];
const log = (s = '') => {
  out.push(s);
  console.log(s);
};
const f = (x: number, d = 3) => x.toFixed(d);
const fp = (p: Params) => `sens ${f(p.sensitivity, 1)}; σδ² ${f(p.priorVariance, 2)}; ruído ${f(p.noiseVariance, 3)}; escala ${f(p.samplingScale, 2)}; γ ${f(p.forgetting, 3)}`;

const DEFAULTS_V04: Params = { sensitivity: 1, priorVariance: 0.25, noiseVariance: 0.25, samplingScale: 1, forgetting: 0.98 };
const STRONG: Params = { sensitivity: 8, priorVariance: 1, noiseVariance: 0.25, samplingScale: 1, forgetting: 0.98 };

// ---- optional: tracking / overconfidence sweep over forgetting x noiseVariance -------------------------------
if (process.env.GAMMA_SWEEP) {
  const BASE = JSON.parse(process.env.GAMMA_SWEEP) as Params;
  const N = 300;
  const ALL = [...TRAIN, ...HELD_OUT];
  const changeWorld = baseline({ name: 'sweep-change', params: {} }, N, 777);
  const nullWorld = baseline({ name: 'sweep-null', params: { kappa: 0 } }, N, 888);
  console.log(`Base: ${JSON.stringify(BASE)}`);
  console.log('| γ | noiseVariance | razão média | churn | corr. c/ novo perfil (sessão 100 / 120) | pTrue 101–120 após mudança | norma do perfil espúrio (sem efeito, 60 sessões) | churn sem efeito |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const g of [0.95, 0.97, 0.98, 0.99, 0.995]) {
    for (const nv of [0.02, 0.05, 0.1]) {
      const p: Params = { ...BASE, forgetting: g, noiseVariance: nv };
      const r = evalConfig(p, ALL, N, 444);
      const chg = runPolicy(hexadPolicy('c', toConfig(p)), { nUsers: N, nSessions: N_SESS, world: changeWorld.world, seed: 777, changeAt: 60 }, changeWorld.registry);
      const c100 = mean(chg.map((t) => pearsonLocal(t.profile[99] as number[], t.hAt[119] as number[])));
      const c120 = mean(chg.map((t) => pearsonLocal(t.profile[119] as number[], t.hAt[119] as number[])));
      const p101 = mean(chg.map((t) => windowMean(t, 'p', 100, 120)));
      const nul = runPolicy(hexadPolicy('n', toConfig(p)), { nUsers: N, nSessions: N_SESS, world: nullWorld.world, seed: 888, userKind: 'neutral', keepWeights: true }, nullWorld.registry);
      const spur = mean(nul.map((t) => Math.sqrt((t.profile[59] as number[]).reduce((a, v) => a + v * v, 0))));
      console.log(`| ${g} | ${nv} | ${f(r.meanRatio)} | ${f(r.churn)} | ${f(c100)} / ${f(c120)} | ${f(p101)} | ${f(spur)} | ${f(mean(nul.map(churnOf)))} |`);
    }
  }
  process.exit(0);
}

function pearsonLocal(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += ((a[i] as number) - ma) * ((b[i] as number) - mb);
    da += ((a[i] as number) - ma) ** 2;
    db += ((b[i] as number) - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

// ---- optional: check one given point (sensitivity + stress worlds) without redoing the search ----------------
if (process.env.PROPOSAL_JSON) {
  const P = JSON.parse(process.env.PROPOSAL_JSON) as Params;
  const N = 300;
  const STRESS: WorldSpec[] = [
    { name: 'sem efeito algum (κ 0): custo puro', params: { kappa: 0 } },
    { name: 'efeito mínimo e ruído alto (κ 0,10; ruído 0,35)', params: { kappa: 0.1, outcomeNoise: 0.35 } },
    { name: 'efeito fraco, ruído alto e mudança (κ 0,30; 0,35; sessão 61)', params: { kappa: 0.3, outcomeNoise: 0.35 }, changeAt: 60 },
    { name: 'assinaturas muito erradas e sem efeito Hexad real (κ 0,05; assin. 0,30; idiossincr. 0,5)', params: { kappa: 0.05, signatureNoise: 0.3, idiosyncratic: 0.5 } },
  ];
  console.log(`Ponto: ${JSON.stringify(P)}`);
  console.log('\nMundos de estresse (ganho absoluto ± IC 95%, churn):');
  for (const [label, p] of [['ponto', P], ['padrões v0.4', DEFAULTS_V04]] as const) {
    const r = evalConfig(p, STRESS, N, 555);
    console.log(`- ${label}: ${r.perWorld.map((w) => `${w.name}: ${f(w.lift, 4)} ± ${f(w.half, 4)} (churn ${f(w.churn)})`).join(' | ')}`);
  }
  const ALL = [...TRAIN, ...HELD_OUT];
  const baseR = evalConfig(P, ALL, N, 444);
  console.log(`\nSensibilidade (razão média / churn), treino + validação, ${N} usuários: escolhido ${f(baseR.meanRatio)} / ${f(baseR.churn)}`);
  for (const k of ['sensitivity', 'priorVariance', 'noiseVariance', 'samplingScale', 'forgetting'] as const) {
    const lo = { ...P } as Params;
    const hi = { ...P } as Params;
    if (k === 'forgetting') {
      lo[k] = 1 - (1 - P[k]) * 0.5;
      hi[k] = 1 - (1 - P[k]) * 2;
    } else {
      lo[k] = P[k] * 0.5;
      hi[k] = P[k] * 2;
    }
    const a = evalConfig(lo, ALL, N, 444);
    const b = evalConfig(hi, ALL, N, 444);
    console.log(`- ${k} (${f(P[k], 3)}): x0,5 → ${f(a.meanRatio)} / ${f(a.churn)}; x2 → ${f(b.meanRatio)} / ${f(b.churn)}`);
  }
  process.exit(0);
}

log('# Calibração dos parâmetros (Q2) — rodada 1: resultados');
log();
log('Gerado por `packages/simulator/src/calibrate.ts`. **Os mundos são sintéticos e meus**: a calibração escolhe valores robustos entre eles, não valores verdadeiros para pessoas reais. O piloto (F5) deve recalibrar.');
log();
log('- **Ganho**: resultado esperado (pTrue, sessões 21–120) menos o da política uniforme, usuários pareados.');
log('- **Razão** = ganho ÷ ganho de um oráculo duro de informação completa (conhece o perfil e os efeitos por elemento) no mesmo mundo: a fração do que era alcançável.');
log('- **Churn** = quanto os pesos mudam, em média, de uma sessão para a seguinte (0 = a interface nunca muda; 0,5 = cada elemento muda ±0,5 por sessão). É o preço visível ao usuário: DECISOES D9 e a §4.1 da dissertação pedem adaptação **gradual**.');
log();

// ---- 1. random search ------------------------------------------------------------------------------------
const N_CAND = QUICK ? 14 : 220;
const N_SEARCH_USERS = QUICK ? 40 : 100;
const rng = mulberry32(20261017);
const candidates: Params[] = Array.from({ length: N_CAND }, () => ({
  sensitivity: logU(rng, 1, 32),
  priorVariance: logU(rng, 0.1, 8),
  noiseVariance: logU(rng, 0.01, 0.5),
  samplingScale: logU(rng, 0.15, 1.5),
  forgetting: 1 - logU(rng, 0.005, 0.15),
}));
candidates.push(DEFAULTS_V04, STRONG);

const searchScores = candidates.map((p) => ({ p, r: evalConfig(p, TRAIN, N_SEARCH_USERS, 111) }));
searchScores.sort((a, b) => b.r.meanRatio - a.r.meanRatio);

log(`## 1. Busca aleatória (${candidates.length} candidatos, ${N_SEARCH_USERS} usuários por mundo, ${TRAIN.length} mundos de treino)`);
log();
log('Dez melhores por razão média, sem restrição de churn:');
log();
log('| posição | parâmetros | razão média | pior mundo | churn |');
log('|---|---|---|---|---|');
searchScores.slice(0, 10).forEach((s, i) => log(`| ${i + 1} | ${fp(s.p)} | ${f(s.r.meanRatio)} | ${f(s.r.worstRatio)} | ${f(s.r.churn)} |`));
for (const [label, p] of [['padrões v0.4', DEFAULTS_V04], ['"forte" v0.4', STRONG]] as const) {
  const k = searchScores.findIndex((s) => s.p === p);
  log(`| (${label}) posição ${k + 1} | ${fp(p)} | ${f(searchScores[k]!.r.meanRatio)} | ${f(searchScores[k]!.r.worstRatio)} | ${f(searchScores[k]!.r.churn)} |`);
}
log();

// ---- 2. frontier ratio vs churn --------------------------------------------------------------------------
const niceNum = (x: number, grid: number[]) => grid.reduce((a, b) => (Math.abs(Math.log(b / x)) < Math.abs(Math.log(a / x)) ? b : a));
function snap(p: Params): Params {
  return {
    sensitivity: niceNum(p.sensitivity, [1, 2, 3, 4, 6, 8, 12, 16, 24, 32]),
    priorVariance: niceNum(p.priorVariance, [0.1, 0.25, 0.5, 1, 2, 4, 8]),
    noiseVariance: niceNum(p.noiseVariance, [0.01, 0.02, 0.05, 0.1, 0.25, 0.5]),
    samplingScale: niceNum(p.samplingScale, [0.15, 0.25, 0.35, 0.5, 0.7, 1, 1.5]),
    forgetting: 1 - niceNum(1 - p.forgetting, [0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12]),
  };
}

const LIMITS = [0.05, 0.1, 0.15, 0.2, 0.3, Infinity];
const N_RE_USERS = QUICK ? 60 : 300;
const frontier = LIMITS.map((c) => {
  const pick = searchScores.find((s) => s.r.churn <= c);
  return pick ? { c, raw: pick.p, snapped: snap(pick.p) } : null;
}).filter((x): x is NonNullable<typeof x> => x !== null);

log('## 2. Fronteira razão × churn');
log();
log(`Para cada limite de churn, o melhor candidato da busca que o respeita, **arredondado** para valores "redondos" e reavaliado com usuários novos (${N_RE_USERS} por mundo, outra semente) em mundos de treino e depois em mundos de validação que a busca não viu.`);
log();
const N_VAL_USERS = QUICK ? 60 : 300;
log('| churn ≤ | parâmetros (arredondados) | razão (treino, novos) | churn (treino) | razão (validação) | pior mundo (validação) | churn (validação) |');
log('|---|---|---|---|---|---|---|');
const evaluated = frontier.map((fr) => {
  const rt = evalConfig(fr.snapped, TRAIN, N_RE_USERS, 222);
  const rv = evalConfig(fr.snapped, HELD_OUT, N_VAL_USERS, 333);
  log(`| ${Number.isFinite(fr.c) ? fr.c : 'sem limite'} | ${fp(fr.snapped)} | ${f(rt.meanRatio)} | ${f(rt.churn)} | ${f(rv.meanRatio)} | ${f(rv.worstRatio)} | ${f(rv.churn)} |`);
  return { ...fr, rt, rv };
});
for (const [label, p] of [['padrões v0.4', DEFAULTS_V04], ['"forte" v0.4', STRONG]] as const) {
  const rt = evalConfig(p, TRAIN, N_RE_USERS, 222);
  const rv = evalConfig(p, HELD_OUT, N_VAL_USERS, 333);
  log(`| (${label}) | ${fp(p)} | ${f(rt.meanRatio)} | ${f(rt.churn)} | ${f(rv.meanRatio)} | ${f(rv.worstRatio)} | ${f(rv.churn)} |`);
}
log();

// ---- 3. proposal + absolute lifts -------------------------------------------------------------------------
const proposalPoint = evaluated.find((e) => e.c >= PROPOSAL_CHURN) ?? evaluated[evaluated.length - 1]!;
const PROPOSAL = proposalPoint.snapped;
log(`## 3. Ponto escolhido para a discussão: churn ≤ ${proposalPoint.c}`);
log();
log(`\`${JSON.stringify(PROPOSAL)}\``);
log();
log('Ganho absoluto por mundo de validação (média ± IC 95%) e o teto do oráculo de informação completa:');
log();
log('| mundo | teto | padrões v0.4 | ponto escolhido |');
log('|---|---|---|---|');
const vDef = evalConfig(DEFAULTS_V04, HELD_OUT, N_VAL_USERS, 333).perWorld;
const vProp = evalConfig(PROPOSAL, HELD_OUT, N_VAL_USERS, 333).perWorld;
HELD_OUT.forEach((w, i) => log(`| ${w.name} | ${f(vProp[i]!.ceiling, 4)} | ${f(vDef[i]!.lift, 4)} ± ${f(vDef[i]!.half, 4)} | ${f(vProp[i]!.lift, 4)} ± ${f(vProp[i]!.half, 4)} |`));
log();

// ---- 4. sensitivity ----------------------------------------------------------------------------------------
log('## 4. Sensibilidade em torno do ponto escolhido');
log();
log(`Um parâmetro por vez (×0,5 e ×2; para γ, o complemento 1−γ). Razão média e churn em treino + validação (${N_VAL_USERS} usuários, outra semente).`);
log();
log('| parâmetro | ×0,5 (razão / churn) | escolhido | ×2 (razão / churn) |');
log('|---|---|---|---|');
const ALL = [...TRAIN, ...HELD_OUT];
const baseR = evalConfig(PROPOSAL, ALL, N_VAL_USERS, 444);
for (const k of ['sensitivity', 'priorVariance', 'noiseVariance', 'samplingScale', 'forgetting'] as const) {
  const lo = { ...PROPOSAL } as Params;
  const hi = { ...PROPOSAL } as Params;
  if (k === 'forgetting') {
    lo[k] = 1 - (1 - PROPOSAL[k]) * 0.5;
    hi[k] = 1 - (1 - PROPOSAL[k]) * 2;
  } else {
    lo[k] = PROPOSAL[k] * 0.5;
    hi[k] = PROPOSAL[k] * 2;
  }
  const a = evalConfig(lo, ALL, N_VAL_USERS, 444);
  const b = evalConfig(hi, ALL, N_VAL_USERS, 444);
  log(`| ${k} (${f(PROPOSAL[k], 3)}) | ${f(a.meanRatio)} / ${f(a.churn)} | ${f(baseR.meanRatio)} / ${f(baseR.churn)} | ${f(b.meanRatio)} / ${f(b.churn)} |`);
}
log();

// docs/ is not versioned, so create it on a fresh clone.
const reportPath = fileURLToPath(new URL('../../../docs/CALIBRACAO_F2_RESULTADOS.md', import.meta.url));
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, out.join('\n') + '\n', 'utf-8');
