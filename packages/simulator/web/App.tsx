import { useEffect, useMemo, useRef, useState } from 'react';
import type { Catalog } from '../../core/src/index.ts';
import catalogJson from '../../../spec/catalog.flashcards.json';
import { DEFAULT_PARAMS, churn, correlation, ensemble, runDemo } from '../src/demo.ts';
import type { ArmDay, DemoParams, DemoResult } from '../src/demo.ts';
import { presentationOf, orderOf } from '../../app-web/src/presentation.ts';
import { TYPES, preset } from './hexad.ts';
import { Heatmap, ProfileBars, Sparkline, Timeline } from './charts.tsx';

const catalog = catalogJson as unknown as Catalog;
const ENSEMBLE_RUNS = 30;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} p.p.`;

export function App() {
  const [params, setParams] = useState<DemoParams>(DEFAULT_PARAMS);
  const [day, setDay] = useState(0); // 0-based index of the day on screen
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4); // days per second
  const [view, setView] = useState<'both' | 'adaptive' | 'control'>('both');
  const [showProfile, setShowProfile] = useState(true);
  const [ens, setEns] = useState<{ key: string; data: ReturnType<typeof ensemble> } | null>(null);

  const result: DemoResult = useMemo(() => runDemo(catalog, params), [params]);
  const days = params.days;
  const safeDay = Math.min(day, days - 1);
  const key = JSON.stringify(params);

  // ---- playback: speed is "days per second"; the fractional part is kept between ticks ----
  const frac = useRef(0);
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      frac.current += speed * 0.1;
      const step = Math.floor(frac.current);
      if (step < 1) return;
      frac.current -= step;
      setDay((d) => {
        const next = Math.min(days - 1, d + step);
        if (next >= days - 1) setPlaying(false);
        return next;
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, speed, days]);

  const patch = (p: Partial<DemoParams>) => {
    setParams((old) => ({ ...old, ...p }));
    setPlaying(false);
  };
  const setAff = (i: number, v: number) => patch({ affinity: params.affinity.map((x, j) => (j === i ? v : x)) });
  const restart = () => {
    setDay(0);
    frac.current = 0;
    setPlaying(false);
  };

  const a = result.adaptive[safeDay] as ArmDay;
  const c = result.control[safeDay] as ArmDay;
  const hidden = result.affinityAt[safeDay] as number[];
  const counts = (arm: ArmDay) => {
    const ws = Object.values(arm.weights);
    return { featured: ws.filter((w) => presentationOf(w) === 'featured').length, compact: ws.filter((w) => presentationOf(w) === 'compact').length };
  };
  const ca = counts(a);
  const corr = a.profile ? correlation(a.profile, hidden) : 0;
  const changed = params.changeDay !== null && safeDay + 1 >= params.changeDay;
  const meanGain = (from: number, to: number) => {
    let s = 0;
    for (let i = from; i < to; i++) s += (result.adaptive[i] as ArmDay).expected - (result.control[i] as ArmDay).expected;
    return s / Math.max(1, to - from);
  };
  const gainSoFar = meanGain(0, safeDay + 1);
  const ensView = ens && ens.key === key ? ens.data : null;

  return (
    <div className="sim">
      <h1>Simulação da gamificação adaptativa</h1>
      <p className="lede">
        Um usuário falso vive vários dias no app. A afinidade dele com cada tipo Hexad fica <b>escondida</b> do sistema, que só enxerga se o
        usuário concluiu a fila e em que elementos ele clicou. Escolha o usuário, ajuste a velocidade e veja a interface mudar dia após dia.
      </p>

      <div className="sim-layout">
        <div className="controls">
          <section className="card">
            <h2>1. Usuário falso</h2>
            <div className="chip-row" role="group" aria-label="Perfis prontos">
              {TYPES.map((t, i) => (
                <button
                  key={t.key}
                  className="type-chip"
                  aria-pressed={params.affinity.every((v, j) => v === preset(i)[j])}
                  style={params.affinity.every((v, j) => v === preset(i)[j]) ? { background: t.color, borderColor: t.color } : { borderColor: t.color }}
                  onClick={() => patch({ affinity: preset(i) })}
                  title={t.hint}
                >
                  {t.name}
                </button>
              ))}
              <button className="type-chip" onClick={() => patch({ affinity: [0, 0, 0, 0, 0, 0] })} title="Nenhuma preferência: a interface não faz diferença">
                Sem preferência
              </button>
            </div>
            <p className="note">Ou misture à vontade (a afinidade é relativa: só a diferença entre os tipos conta):</p>
            {TYPES.map((t, i) => (
              <div key={t.key} className="aff-row">
                <b style={{ color: t.color }}>{t.name}</b>
                <input type="range" min={0} max={1} step={0.05} value={params.affinity[i]} onChange={(e) => setAff(i, Number(e.target.value))} aria-label={`Afinidade com ${t.name}`} />
                <output>{params.affinity[i]!.toFixed(2)}</output>
              </div>
            ))}
          </section>

          <section className="card">
            <h2>2. O mundo</h2>
            <label>
              Efeito da interface <output>{params.effect.toFixed(2)}</output>
            </label>
            <input type="range" min={0} max={1.2} step={0.05} value={params.effect} onChange={(e) => patch({ effect: Number(e.target.value) })} />
            <label>
              Ruído do dia a dia <output>{params.noise.toFixed(2)}</output>
            </label>
            <input type="range" min={0} max={0.4} step={0.01} value={params.noise} onChange={(e) => patch({ noise: Number(e.target.value) })} />
            <label>
              Chance base de concluir a fila <output>{pct(params.base)}</output>
            </label>
            <input type="range" min={0.1} max={0.8} step={0.01} value={params.base} onChange={(e) => patch({ base: Number(e.target.value) })} />
            <label>
              Duração <output>{params.days} dias</output>
            </label>
            <input type="range" min={30} max={240} step={10} value={params.days} onChange={(e) => patch({ days: Number(e.target.value) })} />
            <label>
              Início suave (dias) <output>{params.rampDays <= 1 ? 'desligado' : params.rampDays}</output>
            </label>
            <input type="range" min={1} max={21} step={1} value={params.rampDays} onChange={(e) => patch({ rampDays: Number(e.target.value) })} />
            <label>
              Semente (a “sorte” do usuário) <input type="number" value={params.seed} min={1} onChange={(e) => patch({ seed: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 80 }} />
            </label>
          </section>

          <section className="card">
            <h2>3. E se o gosto mudar?</h2>
            <label style={{ justifyContent: 'flex-start' }}>
              <span>
                <input
                  type="checkbox"
                  checked={params.changeDay !== null}
                  onChange={(e) =>
                    patch(e.target.checked ? { changeDay: Math.round(params.days / 2), affinityAfter: preset((TYPES.findIndex((_, i) => params.affinity[i] === 1) + 3) % 6) } : { changeDay: null, affinityAfter: null })
                  }
                />{' '}
                O usuário muda de gosto
              </span>
            </label>
            {params.changeDay !== null && (
              <>
                <label>
                  No dia <output>{params.changeDay}</output>
                </label>
                <input type="range" min={5} max={params.days - 5} step={1} value={params.changeDay} onChange={(e) => patch({ changeDay: Number(e.target.value) })} />
                <label>
                  Passa a gostar de
                  <select
                    value={Math.max(0, (params.affinityAfter ?? []).indexOf(1))}
                    onChange={(e) => patch({ affinityAfter: preset(Number(e.target.value)) })}
                  >
                    {TYPES.map((t, i) => (
                      <option key={t.key} value={i}>{t.name}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </section>
        </div>

        <div>
          <section className="card timebar" aria-label="Controle do tempo">
            <div className="row">
              <span className="daybig">Dia {safeDay + 1}</span>
              <span className="muted">de {days}</span>
              <span style={{ flex: 1 }} />
              <button className="btn icon" onClick={restart} title="Voltar ao dia 1" aria-label="Voltar ao início">⏮</button>
              <button className="btn icon" onClick={() => { setPlaying(false); setDay(Math.max(0, safeDay - 1)); }} aria-label="Dia anterior">◀</button>
              <button
                className="btn primary icon"
                onClick={() => {
                  if (safeDay >= days - 1) setDay(0);
                  setPlaying((p) => !p);
                }}
                aria-label={playing ? 'Pausar' : 'Reproduzir'}
              >
                {playing ? '⏸ Pausar' : '▶ Reproduzir'}
              </button>
              <button className="btn icon" onClick={() => { setPlaying(false); setDay(Math.min(days - 1, safeDay + 1)); }} aria-label="Próximo dia">▶|</button>
              <button className="btn icon" onClick={() => { setPlaying(false); setDay(Math.min(days - 1, safeDay + 7)); }} aria-label="Avançar sete dias">+7</button>
            </div>
            <input type="range" min={0} max={days - 1} value={safeDay} onChange={(e) => { setPlaying(false); setDay(Number(e.target.value)); }} aria-label="Dia" />
            <div className="row">
              <label style={{ flex: 1, minWidth: 220 }}>
                Velocidade <output>{speed} dia{speed === 1 ? '' : 's'}/s</output>
              </label>
              {[1, 4, 12, 30].map((s) => (
                <button key={s} className="btn" style={s === speed ? { borderColor: 'var(--accent)' } : undefined} onClick={() => setSpeed(s)}>{s}×</button>
              ))}
              <input type="range" min={1} max={40} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Velocidade em dias por segundo" style={{ flexBasis: '100%' }} />
            </div>
            <div className="row">
              <span className="muted">Mostrar:</span>
              {([['both', 'adaptativa × uniforme'], ['adaptive', 'só adaptativa'], ['control', 'só uniforme']] as const).map(([v, l]) => (
                <button key={v} className="btn" style={view === v ? { borderColor: 'var(--accent)' } : undefined} onClick={() => setView(v)}>{l}</button>
              ))}
            </div>
          </section>

          <div className="facts" aria-live="off">
            <span className="fact">Em destaque: <b>{ca.featured}</b> · reduzidos: <b>{ca.compact}</b></span>
            <span className="fact">Mudança da interface vs. ontem: <b>{pct(churn(result.adaptive, safeDay))}</b></span>
            <span className="fact">Concluiu a fila: <b>{pct(a.outcome)}</b> (uniforme: {pct(c.outcome)})</span>
            <span className="fact">Cliques hoje: <b>{a.clicked.length}</b></span>
            <span className="fact">Ganho esperado até aqui: <b>{signed(gainSoFar)}</b></span>
          </div>
          {changed && <p className="warn">O gosto do usuário mudou no dia {params.changeDay}. Veja quanto tempo a interface leva para acompanhar.</p>}

          <div className={`arms ${view === 'both' ? 'two' : ''}`}>
            {view !== 'control' && <Arm title="Interface adaptativa" arm={a} result={result} accent />}
            {view !== 'adaptive' && <Arm title="Interface uniforme (controle)" arm={c} result={result} />}
          </div>
          <div className="legend" aria-label="Legenda">
            <span><i style={{ background: 'var(--accent)' }} />destaque (peso ≥ 0,7)</span>
            <span><i style={{ background: 'var(--line)' }} />normal</span>
            <span><i style={{ background: 'var(--muted)', opacity: 0.5 }} />reduzido (peso ≤ 0,3)</span>
            <span>👆 o usuário clicou</span>
            <span>A cor do ponto indica o tipo Hexad ao qual o elemento mais se dirige.</span>
          </div>

          <div className="charts">
            <section className="card">
              <h2 style={{ fontSize: '1rem', marginTop: 0 }}>O que o sistema entendeu</h2>
              <label className="note"><input type="checkbox" checked={showProfile} onChange={(e) => setShowProfile(e.target.checked)} /> mostrar a estimativa do sistema</label>
              <ProfileBars hidden={hidden} estimated={showProfile ? a.profile : null} />
              <p className="note">
                Contorno = afinidade real (escondida). Barra colorida = perfil estimado hoje. Correlação entre as duas: <b>{corr.toFixed(2)}</b>. O sistema nunca vê a
                barra de contorno; ele a deduz do que acontece.
              </p>
            </section>
            <section className="card">
              <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Chance de concluir a fila</h2>
              <Timeline result={result} day={safeDay} changeDay={params.changeDay} onDay={(i) => { setPlaying(false); setDay(i); }} />
              <div className="key">
                <span><span className="sw" style={{ borderColor: 'var(--accent)' }} />adaptativa</span>
                <span><span className="sw" style={{ borderColor: '#8a8f9c', borderTopStyle: 'dashed' }} />uniforme</span>
                <span>pontos = resultado do dia, com ruído</span>
              </div>
              <p className="note">Clique ou arraste no gráfico para ir a outro dia.</p>
            </section>
            <section className="card wide">
              <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Peso de cada elemento ao longo dos dias</h2>
              <Heatmap result={result} day={safeDay} onDay={(i) => { setPlaying(false); setDay(i); }} />
              <p className="note">Laranja = em destaque, azul = reduzido. Cada linha é um elemento, agrupado pelo tipo Hexad ao qual mais se dirige.</p>
            </section>
            <section className="card wide">
              <h2 style={{ fontSize: '1rem', marginTop: 0 }}>E se fossem muitas pessoas iguais a este usuário?</h2>
              <p className="note">
                A história de uma só pessoa é ruidosa: com a sorte de cada dia, o sistema pode demorar a acertar ou errar. Aqui o mesmo usuário vive o
                mundo {ENSEMBLE_RUNS} vezes, com sortes diferentes, e mostramos a média, que é o que os critérios de avaliação usam.
              </p>
              <div className="row">
                <button className="btn primary" onClick={() => setEns({ key, data: ensemble(catalog, params, ENSEMBLE_RUNS) })}>
                  {ensView ? 'Recalcular' : `Simular ${ENSEMBLE_RUNS} vidas`}
                </button>
                {ens && !ensView && <span className="muted">Os parâmetros mudaram: recalcule.</span>}
              </div>
              {ensView && (
                <div className="ens">
                  <div>
                    <b>Ganho médio sobre a interface uniforme</b>
                    <Sparkline values={ensView.gain} day={safeDay} color="var(--accent)" lo={Math.min(0, ...ensView.gain)} hi={Math.max(0.01, ...ensView.gain)} label="Ganho médio ao longo dos dias" />
                    <span className="note">no dia {safeDay + 1}: {signed(ensView.gain[safeDay]!)} · nos últimos 30 dias: {signed(mean(ensView.gain.slice(-30)))}</span>
                  </div>
                  <div>
                    <b>Correlação média do perfil estimado com o real</b>
                    <Sparkline values={ensView.corr} day={safeDay} color="#2f9e44" lo={Math.min(0, ...ensView.corr)} hi={1} label="Correlação média ao longo dos dias" />
                    <span className="note">no dia {safeDay + 1}: {ensView.corr[safeDay]!.toFixed(2)}</span>
                  </div>
                </div>
              )}
            </section>
          </div>

          <p className="note" style={{ marginTop: 16 }}>
            <b>Leia com cuidado.</b> O mundo é sintético: nele, por construção, o usuário rende mais com elementos do tipo Hexad que ele prefere. A simulação
            mostra se o sistema <i>consegue descobrir</i> isso a partir de sinais fracos e ruidosos, não se pessoas reais funcionam assim, que é o que o
            experimento com o app vai testar. O motor usado aqui é o mesmo do app.
          </p>
        </div>
      </div>
    </div>
  );
}

const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / Math.max(1, v.length);

function Arm({ title, arm, result, accent }: { title: string; arm: ArmDay; result: DemoResult; accent?: boolean }) {
  const clicked = new Set(arm.clicked);
  return (
    <section className="card" style={accent ? { borderColor: 'var(--accent)' } : undefined}>
      <h3 className="arm-title">
        <span>{title}</span>
        <span className="muted">chance hoje: {pct(arm.expected)}</span>
      </h3>
      <div className="tiles">
        {result.elementIds.map((id) => {
          const w = arm.weights[id]!;
          const pres = presentationOf(w);
          return (
            <div key={id} className={`tile ${pres} ${clicked.has(id) ? 'clicked' : ''}`} style={{ order: orderOf(w) }} title={`peso ${w.toFixed(2)}`}>
              <span className="t-w">{w.toFixed(2)}</span>
              <span className="t-head">
                <span className="dot" style={{ background: TYPES[result.elementType[id]!]!.color }} />
                <span>{result.elementLabels[id]}</span>
              </span>
              <span className="t-bar"><span style={{ width: `${Math.round(w * 100)}%` }} /></span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
