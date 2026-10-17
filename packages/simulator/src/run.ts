// Experiments: checks the six acceptance criteria with synthetic users.
// Run: npm run sim   (writes the report to docs/SIMULACAO_F2_RESULTADOS.md, local and unversioned). SIM_USERS=60 for a quick run.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../../core/src/index.ts';
import type { Catalog, EngineConfig } from '../../core/src/index.ts';
import {
  DEFAULT_WORLD,
  directPolicy,
  dominant,
  hexadPolicy,
  makeWorld,
  mean,
  meanCI,
  oraclePolicy,
  pearson,
  profileOraclePolicy,
  randomPolicy,
  runPolicy,
  uniformPolicy,
  windowMean,
} from './sim.ts';
import type { PolicyFactory, SimUser, UserTrace, WorldParams } from './sim.ts';

const catalog = JSON.parse(readFileSync(fileURLToPath(new URL('../../../spec/catalog.flashcards.json', import.meta.url)), 'utf-8')) as Catalog;
const IDS = catalog.elements.map((e) => e.id);

const N_USERS = Number(process.env.SIM_USERS ?? 300);
const N_SESSIONS = 120;
const SEED = 20261016;

const out: string[] = [];
const log = (s = '') => {
  out.push(s);
  console.log(s);
};
const f = (x: number, d = 3) => x.toFixed(d);
const ci = (a: number[], d = 3) => {
  const { m, half } = meanCI(a);
  return `${f(m, d)} ± ${f(half, d)}`;
};

function baseConfig(over: Partial<EngineConfig> = {}): EngineConfig {
  return { schemaVersion: '0.1', catalog, seed: 7, ...over };
}

/** Contract defaults. */
const DEFAULT = baseConfig();
/** The v0.4 defaults, before the Calibration round. Kept for comparison. */
const LEGACY = baseConfig({ sensitivity: 1, priorVariance: 0.25, noiseVariance: 0.25, samplingScale: 1, forgetting: 0.98 });

function world(params: Partial<WorldParams> = {}) {
  return makeWorld(catalog, { ...DEFAULT_WORLD, ...params }, SEED + 1);
}

type Extra = { userKind?: 'typed' | 'neutral'; changeAt?: number; keepWeights?: boolean };

function run(factory: PolicyFactory, w = world(), extra: Extra = {}, registry?: Map<string, SimUser>) {
  return runPolicy(factory, { nUsers: N_USERS, nSessions: N_SESSIONS, world: w, seed: SEED, ...extra }, registry);
}

function liftVs(base: UserTrace[], t: UserTrace[], from: number, to: number) {
  return t.map((tr, i) => windowMean(tr, 'p', from, to) - windowMean(base[i] as UserTrace, 'p', from, to));
}

function corrAt(traces: UserTrace[], t: number, finalH = false): number {
  return mean(
    traces.map((tr) => {
      const p = tr.profile[t];
      return p ? pearson(p, tr.hAt[finalH ? N_SESSIONS - 1 : t] as number[]) : 0;
    }),
  );
}

function top1At(traces: UserTrace[], t: number): number {
  return mean(traces.map((tr) => (tr.profile[t] && dominant(tr.profile[t] as number[]) === dominant(tr.hAt[t] as number[]) ? 1 : 0)));
}

function weightDeviation(tr: UserTrace[], t: number): number {
  return mean(tr.map((x) => mean(Object.values((x.weights as Record<string, number>[])[t] as Record<string, number>).map((w) => Math.abs(w - 0.5)))));
}

log('# Resultados da simulação F2');
log();
log(`Gerado automaticamente por \`npm run sim\`. ${N_USERS} usuários sintéticos por política, ${N_SESSIONS} sessões (1 por dia), semente ${SEED}.`);
log('Estes números verificam o **comportamento do algoritmo** em um mundo sintético que eu defini (ver `packages/simulator/src/sim.ts`); não são evidência sobre pessoas reais.');
log();
log('Duas configurações do motor aparecem abaixo:');
log('- **padrão**: os valores padrão atuais do motor, calibrados na rodada 1 (`DEFAULTS` em `engine.ts`; ver `CALIBRACAO_F2.md`).');
log('- **legado v0.4**: os padrões anteriores à calibração (`sensitivity` 1; `priorVariance` 0,25; `noiseVariance` 0,25; `samplingScale` 1; γ 0,98), mantidos para comparação.');
log();

// ---------------------------------------------------------------------------------------------
const registry = new Map<string, SimUser>();
const w0 = world();
const uni = run(uniformPolicy(IDS), w0, {}, registry);
const rnd = run(randomPolicy(IDS), w0, {}, registry);
const orc = run(oraclePolicy(w0, registry), w0, {}, registry);
const hexD = run(hexadPolicy('hexad (padrão)', DEFAULT), w0, { keepWeights: true }, registry);
const hexS = run(hexadPolicy('hexad (legado v0.4)', LEGACY), w0, { keepWeights: true }, registry);
const po1 = run(profileOraclePolicy(w0, registry, 1), w0, {}, registry);
const po8 = run(profileOraclePolicy(w0, registry, 8), w0, {}, registry);

log('## 0. Referência: resultado esperado da sessão (pTrue) por janela');
log();
log('| política | sessões 1–20 | 21–60 | 61–120 | ganho sobre uniforme em 61–120 |');
log('|---|---|---|---|---|');
const rows: [string, UserTrace[]][] = [
  ['uniforme (controle)', uni],
  ['aleatória por sessão', rnd],
  ['hexad (padrão calibrado)', hexD],
  ['hexad (legado v0.4)', hexS],
  ['perfil verdadeiro + mapeamento sens 1 (sem aprender)', po1],
  ['perfil verdadeiro + mapeamento sens 8 (sem aprender)', po8],
  ['oráculo duro (top-4 em 1, resto no piso)', orc],
];
for (const [name, tr] of rows) {
  log(`| ${name} | ${f(mean(tr.map((t) => windowMean(t, 'p', 0, 20))))} | ${f(mean(tr.map((t) => windowMean(t, 'p', 20, 60))))} | ${f(mean(tr.map((t) => windowMean(t, 'p', 60, 120))))} | ${tr === uni ? '—' : ci(liftVs(uni, tr, 60, 120), 4)} |`);
}
log();
log('Leitura: as linhas "perfil verdadeiro" mostram quanto o **mapeamento de pesos** consegue ganhar mesmo sabendo o perfil. Com `sensitivity` 1 o teto é pequeno porque os pesos quase não saem de 0,5. A diferença entre essas linhas e "hexad" é o que falta **aprender**.');
log();

// ---------------------------------------------------------------------------------------------
log('## 1. Convergência: começando neutro, o perfil estimado converge para o oculto');
log();
log('Correlação de Pearson média entre o perfil estimado e o oculto (0 = nada aprendido; 1 = perfeito) e acerto do tipo dominante (acaso = 0,167).');
log();
log('| sessão | correlação (padrão) | correlação (legado) | tipo dominante certo (padrão) | (legado) |');
log('|---|---|---|---|---|');
for (const t of [4, 9, 19, 39, 79, 119]) log(`| ${t + 1} | ${f(corrAt(hexD, t))} | ${f(corrAt(hexS, t))} | ${f(top1At(hexD, t))} | ${f(top1At(hexS, t))} |`);
log();

// ---------------------------------------------------------------------------------------------
log('## 2. Mudança de gosto na sessão 61: o perfil acompanha?');
log();
log('Correlação do perfil estimado com o **novo** perfil oculto, por fator de esquecimento γ (demais parâmetros nos padrões calibrados).');
log();
log('| sessão | γ=0,9 | γ=0,95 | γ=0,98 | γ=1,0 (sem esquecer) |');
log('|---|---|---|---|---|');
const gammas = [0.9, 0.95, 0.98, 1.0];
const changeRuns = gammas.map((g) => run(hexadPolicy(`γ=${g}`, baseConfig({ forgetting: g })), w0, { changeAt: 60 }));
const changeDefault = run(hexadPolicy('padrão calibrado', DEFAULT), w0, { changeAt: 60 });
const changeLegacy = run(hexadPolicy('legado v0.4', LEGACY), w0, { changeAt: 60 });
for (const t of [59, 64, 69, 79, 99, 119]) log(`| ${t + 1} | ${changeRuns.map((r) => f(corrAt(r, t, true))).join(' | ')} |`);
log();
log(`Padrão calibrado (γ = ${DEFAULTS.forgetting}, idêntico à coluna γ=0,98) na mesma mudança: correlação com o novo perfil na sessão 80 = ${f(corrAt(changeDefault, 79, true))}, 100 = ${f(corrAt(changeDefault, 99, true))}, 120 = ${f(corrAt(changeDefault, 119, true))}. Legado v0.4: ${f(corrAt(changeLegacy, 79, true))}, ${f(corrAt(changeLegacy, 99, true))}, ${f(corrAt(changeLegacy, 119, true))}.`);
log();
log(`Resultado esperado da sessão (pTrue) em 101–120, depois da mudança: ${changeRuns.map((r, i) => `γ=${gammas[i]}: ${f(mean(r.map((t) => windowMean(t, 'p', 100, 120))))}`).join('; ')}; padrão calibrado: ${f(mean(changeDefault.map((t) => windowMean(t, 'p', 100, 120))))}; legado: ${f(mean(changeLegacy.map((t) => windowMean(t, 'p', 100, 120))))}.`);
log();

// ---------------------------------------------------------------------------------------------
log('## 3. Recompensa só por cliques × por resultado (D8) — padrões calibrados');
log();
log('Neste mundo, alguns elementos são "brilhantes" (cliques frequentes, independentes do gosto do usuário). Previsão de D8: otimizar cliques leva o sistema a favorecê-los e o resultado do app piora.');
log();
log('| recompensa | ω | taxa de cliques (61–120) | resultado esperado (61–120) | ganho sobre uniforme |');
log('|---|---|---|---|---|');
for (const [label, omega] of [['só resultado', 0], ['padrão (resultado + 5% cliques)', 0.05], ['só cliques', 1]] as const) {
  const tr = run(hexadPolicy(label, baseConfig({ interactionRewardWeight: omega })));
  log(`| ${label} | ${omega} | ${f(mean(tr.map((t) => windowMean(t, 'clickRate', 60, 120))))} | ${f(mean(tr.map((t) => windowMean(t, 'p', 60, 120))))} | ${ci(liftVs(uni, tr, 60, 120), 4)} |`);
}
log(`| uniforme (referência) | — | ${f(mean(uni.map((t) => windowMean(t, 'clickRate', 60, 120))))} | ${f(mean(uni.map((t) => windowMean(t, 'p', 60, 120))))} | — |`);
log();

// ---------------------------------------------------------------------------------------------
log('## 4. Piso de exposição');
log();
for (const fl of [0.1, 0.25]) {
  const tr = run(hexadPolicy(`piso ${fl}`, baseConfig({ exposureFloor: fl, sensitivity: 20 })));
  const minW = Math.min(...tr.map((t) => t.minWeight));
  log(`- piso ${fl} com sensibilidade 20 (agressiva): menor peso observado em ${N_USERS * N_SESSIONS} decisões = ${f(minW, 4)} → ${minW >= fl - 1e-12 ? 'ok' : '**FALHOU**'}`);
}
for (const [name, tr] of [['padrão calibrado', hexD], ['legado v0.4', hexS]] as const) {
  const minW = Math.min(...tr.map((t) => t.minWeight));
  log(`- piso 0,1 com configuração ${name}: menor peso = ${f(minW, 4)} → ${minW >= 0.1 - 1e-12 ? 'ok' : '**FALHOU**'}`);
}
log();

// ---------------------------------------------------------------------------------------------
log('## 5. Ablação de D4: camada Hexad × bandit direto sobre os elementos — padrões calibrados nos dois');
log();
const directCfg = { gamma: DEFAULTS.forgetting, priorVariance: DEFAULTS.priorVariance, levelPriorVariance: DEFAULTS.levelPriorVariance, noiseVariance: DEFAULTS.noiseVariance, samplingScale: DEFAULTS.samplingScale, sensitivity: DEFAULTS.sensitivity, floor: DEFAULTS.exposureFloor, neutral: DEFAULTS.neutralWeight, omega: DEFAULTS.interactionRewardWeight };
log('Ganho sobre o uniforme (pTrue). "Assinaturas erradas" = o mundo usa assinaturas perturbadas (ruído 0,15), então o prior do catálogo está errado. O bandit direto aprende uma preferência por elemento (19 parâmetros) em vez de seis.');
log();
log('"Efeito idiossincrático" = cada usuário tem também um efeito por elemento que a estrutura Hexad **não** explica (desvio 0,5 ou 1,0, comparável ao do perfil Hexad), que é o caso em que o bandit direto deveria se beneficiar.');
log();
log('| mundo | política | 21–60 | 61–120 |');
log('|---|---|---|---|');
for (const [label, wp] of [
  ['assinaturas certas', {}],
  ['assinaturas erradas (ruído 0,15)', { signatureNoise: 0.15 }],
  ['assinaturas muito erradas (ruído 0,30)', { signatureNoise: 0.3 }],
  ['efeito idiossincrático 0,5', { idiosyncratic: 0.5 }],
  ['efeito idiossincrático 1,0', { idiosyncratic: 1.0 }],
] as const) {
  const w = world(wp);
  const reg = new Map<string, SimUser>();
  const u = run(uniformPolicy(IDS), w, {}, reg);
  const h = run(hexadPolicy('hexad', DEFAULT), w, {}, reg);
  const d = run(directPolicy(IDS, directCfg), w, {}, reg);
  for (const [name, tr] of [['hexad', h], ['direto (sem Hexad)', d]] as const) {
    log(`| ${label} | ${name} | ${ci(liftVs(u, tr, 20, 60), 4)} | ${ci(liftVs(u, tr, 60, 120), 4)} |`);
  }
}
log();

// ---------------------------------------------------------------------------------------------
log('## 6. Riscos de D6');
log();
log('**(a) Aprendizado com perfil neutro.** Desvio médio dos pesos em relação a 0,5 nas primeiras sessões (quanto o sistema explora) e sessões até a correlação passar de 0,5.');
log();
log('| sessão | desvio do peso (padrão) | desvio do peso (legado) |');
log('|---|---|---|');
for (const t of [0, 1, 2, 4, 9, 19]) log(`| ${t + 1} | ${f(weightDeviation(hexD, t))} | ${f(weightDeviation(hexS, t))} |`);
log();
for (const [name, tr] of [['padrão calibrado', hexD], ['legado v0.4', hexS]] as const) {
  const reach = tr.map((x) => {
    const idx = x.profile.findIndex((p, t) => p && pearson(p, x.hAt[t] as number[]) > 0.5);
    return idx < 0 ? Infinity : idx + 1;
  });
  const sorted = [...reach].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] as number;
  log(`- ${name}: mediana de sessões até correlação > 0,5 = ${Number.isFinite(med) ? med : `> ${N_SESSIONS}`}; ${f(mean(reach.map((r) => (Number.isFinite(r) ? 1 : 0))), 2)} dos usuários chegam lá em ${N_SESSIONS} sessões.`);
}
log();
{
  const iso = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => (i === j ? 0.25 : 0))) as never;
  log('**(b) Nível-base da recompensa.** Usuários **sem preferência real** (h = 0), com nível-base variado de 0,25 a 0,6: norma média do perfil estimado após 60 sessões (menor = menos preferência espúria) e resultado esperado.');
  log();
  log('| prior | norma do perfil estimado | resultado esperado 21–60 |');
  log('|---|---|---|');
  for (const [label, cfg] of [['nível difuso (contrato v0.2)', DEFAULT], ['isotrópico 0,25·I (contrato v0.1)', baseConfig({ priorCovariance: iso })]] as const) {
    const tr = run(hexadPolicy(label, cfg), w0, { userKind: 'neutral' });
    const norm = mean(tr.map((t) => Math.sqrt((t.profile[59] as number[]).reduce((a, v) => a + v * v, 0))));
    log(`| ${label} | ${f(norm)} | ${f(mean(tr.map((t) => windowMean(t, 'p', 20, 60))))} |`);
  }
}
log();

// ---------------------------------------------------------------------------------------------
log('## 7. Varredura preliminar de parâmetros (para balancear depois)');
log();
log('Ganho sobre o uniforme em 61–120, correlação do perfil na sessão 60 e desvio médio do peso na sessão 1 (quanto a primeira decisão se afasta do neutro), por `priorVariance` (σδ²) e `sensitivity`, com os demais parâmetros nos padrões calibrados e mundo bem especificado. **Preliminar**: o mundo sintético é meu; serve para ver a direção dos efeitos, não para escolher valores finais.');
log();
log('| σδ² | sensibilidade | ganho 61–120 | teto (perfil verdadeiro, mesmo mapeamento) | correlação na sessão 60 | desvio do peso na sessão 1 |');
log('|---|---|---|---|---|---|');
const ceilCache = new Map<number, string>();
for (const sens of [1, 4, 8, 16]) {
  ceilCache.set(sens, ci(liftVs(uni, run(profileOraclePolicy(w0, registry, sens), w0, {}, registry), 60, 120), 4));
}
for (const pv of [0.25, 1, 4]) {
  for (const sens of [1, 4, 8, 16]) {
    const tr = run(hexadPolicy('g', baseConfig({ priorVariance: pv, sensitivity: sens })), w0, { keepWeights: true });
    log(`| ${pv} | ${sens} | ${ci(liftVs(uni, tr, 60, 120), 4)} | ${ceilCache.get(sens)} | ${f(corrAt(tr, 59))} | ${f(weightDeviation(tr, 0))} |`);
  }
}
log();

// ---------------------------------------------------------------------------------------------
log('## 8. Por que o ganho fica longe do teto? Ruído de exploração');
log();
log('Antes da calibração, o desvio do peso **não diminuía** com as sessões: o sorteio de Thompson continuava ruidoso (causas: `noiseVariance` = 0,25 bem acima do ruído real do mundo simulado, ≈ 0,02, e o esquecimento mantendo a incerteza acima de zero). Varredura de `noiseVariance` e `samplingScale` em torno dos padrões calibrados (demais parâmetros nos padrões):');
log();
log('| noiseVariance | samplingScale | ganho 61–120 | correlação na sessão 120 | desvio do peso na sessão 100 |');
log('|---|---|---|---|---|');
for (const nv of [0.25, 0.05, 0.02, 0.01]) {
  for (const sc of [1, 0.5, 0.15]) {
    const tr = run(hexadPolicy('g', baseConfig({ noiseVariance: nv, samplingScale: sc })), w0, { keepWeights: true });
    log(`| ${nv} | ${sc} | ${ci(liftVs(uni, tr, 60, 120), 4)} | ${f(corrAt(tr, 119))} | ${f(weightDeviation(tr, 99))} |`);
  }
}
log();

// ---------------------------------------------------------------------------------------------
log('## 9. Início suave (F4, opção B): encolher os pesos na direção de 0,5 nos primeiros dias');
log();
log('O peso aplicado é `0,5 + k·(w − 0,5)`, com k indo de 0,25 (dia 1) a 1 em `rampDays` dias. Padrões calibrados nos demais parâmetros. Pergunta: o início suave aproxima o primeiro dia do padrão (D3) **sem anular o aprendizado**?');
log();
log('| rampDays | desvio do peso no dia 1 | correlação do perfil: dia 5 / 10 / 20 / 60 | ganho 1–7 | ganho 8–20 | ganho 61–120 |');
log('|---|---|---|---|---|---|');
for (const rd of [1, 7, 14, 28]) {
  const tr = run(hexadPolicy(`rampa ${rd}`, DEFAULT, undefined, rd), w0, { keepWeights: true }, registry);
  log(`| ${rd === 1 ? '1 (sem início suave)' : rd} | ${f(weightDeviation(tr, 0))} | ${[4, 9, 19, 59].map((t) => f(corrAt(tr, t))).join(' / ')} | ${ci(liftVs(uni, tr, 0, 7), 4)} | ${ci(liftVs(uni, tr, 7, 20), 4)} | ${ci(liftVs(uni, tr, 60, 120), 4)} |`);
}
log();

// docs/ is not versioned, so create it on a fresh clone.
const reportPath = fileURLToPath(new URL('../../../docs/SIMULACAO_F2_RESULTADOS.md', import.meta.url));
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, out.join('\n') + '\n', 'utf-8');
