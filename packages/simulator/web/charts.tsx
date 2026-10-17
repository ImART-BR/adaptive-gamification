import type { ArmDay, DemoResult } from '../src/demo.ts';
import { TYPES } from './hexad.ts';

/** Day index (0-based) under a pointer event on an SVG whose x axis spans `days` days between x0 and x1 (in viewBox units). */
function dayFromPointer(e: React.PointerEvent<SVGSVGElement>, vbWidth: number, x0: number, x1: number, days: number): number {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * vbWidth;
  const t = (x - x0) / (x1 - x0);
  return Math.max(0, Math.min(days - 1, Math.round(t * (days - 1))));
}

// ---- timeline: chance of finishing the day's queue ----------------------------------------------------------------

export function Timeline({ result, day, changeDay, onDay }: { result: DemoResult; day: number; changeDay: number | null; onDay: (i: number) => void }) {
  const W = 640;
  const H = 190;
  const L = 36;
  const R = 10;
  const T = 10;
  const B = 24;
  const n = result.adaptive.length;
  // The scale follows the two lines; the noisy dots that fall outside are simply not drawn.
  const vals = [...result.adaptive.map((d) => d.expected), ...result.control.map((d) => d.expected)];
  const lo = Math.max(0, Math.floor((Math.min(...vals) - 0.04) * 20) / 20);
  const hi = Math.min(1, Math.ceil((Math.max(...vals) + 0.04) * 20) / 20);
  const x = (i: number) => L + ((W - L - R) * i) / Math.max(1, n - 1);
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / Math.max(0.0001, hi - lo));
  const line = (arm: ArmDay[]) => arm.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d.expected).toFixed(1)}`).join(' ');
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Chance de concluir a fila do dia, ao longo dos dias, com a interface adaptativa e com a uniforme"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onDay(dayFromPointer(e, W, L, W - R, n));
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) onDay(dayFromPointer(e, W, L, W - R, n));
      }}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid-line" />
          <text x={L - 6} y={y(t) + 4} textAnchor="end" className="axis">{Math.round(t * 100)}%</text>
        </g>
      ))}
      {[1, Math.round(n / 4), Math.round(n / 2), Math.round((3 * n) / 4), n].map((d) => (
        <text key={d} x={x(d - 1)} y={H - 6} textAnchor="middle" className="axis">dia {d}</text>
      ))}
      {changeDay !== null && changeDay <= n && (
        <g>
          <line x1={x(changeDay - 1)} x2={x(changeDay - 1)} y1={T} y2={H - B} className="change-line" />
          <text x={x(changeDay - 1) + 4} y={T + 10} className="axis">o gosto muda</text>
        </g>
      )}
      {result.adaptive.map((d, i) => (d.outcome >= lo && d.outcome <= hi ? <circle key={i} cx={x(i)} cy={y(d.outcome)} r={1.6} className="dot" /> : null))}
      <path d={line(result.control)} className="line-control" />
      <path d={line(result.adaptive)} className="line-adaptive" />
      <line x1={x(day)} x2={x(day)} y1={T} y2={H - B} className="now-line" />
    </svg>
  );
}

// ---- heatmap: weight of every element on every day ------------------------------------------------------------------

export function Heatmap({ result, day, onDay }: { result: DemoResult; day: number; onDay: (i: number) => void }) {
  const rowH = 13;
  const L = 150;
  const W = 640;
  const R = 6;
  const n = result.adaptive.length;
  const rows = [...result.elementIds].sort((a, b) => result.elementType[a]! - result.elementType[b]! || result.elementLabels[a]!.localeCompare(result.elementLabels[b]!));
  const cw = (W - L - R) / n;
  const H = rows.length * rowH + 22;
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Mapa de calor: o peso de cada elemento em cada dia. Laranja = destaque, azul = reduzido."
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onDay(dayFromPointer(e, W, L, W - R, n));
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) onDay(dayFromPointer(e, W, L, W - R, n));
      }}
    >
      {rows.map((id, r) => (
        <g key={id}>
          <circle cx={6} cy={r * rowH + rowH / 2 + 8} r={3.5} fill={TYPES[result.elementType[id]!]!.color} />
          <text x={15} y={r * rowH + rowH / 2 + 12} className="axis">{result.elementLabels[id]!.slice(0, 26)}</text>
          {result.adaptive.map((d, i) => (
            <rect key={i} x={L + i * cw} y={r * rowH + 8} width={Math.ceil(cw)} height={rowH - 1} fill={weightColor(d.weights[id]!)} />
          ))}
        </g>
      ))}
      <rect x={L + day * cw - 0.5} y={4} width={Math.max(1.5, cw)} height={rows.length * rowH + 8} className="now-box" />
    </svg>
  );
}

/** Blue (reduced) -> light (normal) -> orange (featured), matching the thresholds of the app (0.3 and 0.7). */
function weightColor(w: number): string {
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i]! - v) * t));
  const blue = [84, 132, 200];
  const mid = [243, 241, 236];
  const orange = [194, 65, 12];
  const rgb = w < 0.5 ? mix(blue, mid, Math.min(1, (w - 0.1) / 0.4)) : mix(mid, orange, Math.min(1, (w - 0.5) / 0.5));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

// ---- hidden affinity x estimated profile -----------------------------------------------------------------------------

export function ProfileBars({ hidden, estimated }: { hidden: number[]; estimated: number[] | null }) {
  const norm = (v: number[]) => {
    const m = Math.max(0.0001, ...v.map(Math.abs));
    return v.map((x) => x / m);
  };
  const h = norm(hidden);
  const e = estimated ? norm(estimated) : null;
  return (
    <div className="profile-bars" role="img" aria-label="Afinidade escondida do usuário e perfil que o sistema estima">
      {TYPES.map((t, i) => (
        <div key={t.key} className="pb-row">
          <span className="pb-name" style={{ color: t.color }}>{t.name}</span>
          <span className="pb-track">
            <span className="pb-zero" />
            <span className="pb-hidden" style={bar(h[i]!)} />
            {e && <span className="pb-est" style={{ ...bar(e[i]!), background: t.color }} />}
          </span>
        </div>
      ))}
    </div>
  );
}

function bar(v: number): React.CSSProperties {
  const w = Math.abs(v) * 50;
  return { left: v >= 0 ? '50%' : `${50 - w}%`, width: `${w}%` };
}

// ---- small curve (used for the many-people average) ---------------------------------------------------------------------------

export function Sparkline({ values, day, color, lo, hi, label }: { values: number[]; day: number; color: string; lo: number; hi: number; label: string }) {
  const W = 300;
  const H = 70;
  const n = values.length;
  const x = (i: number) => 4 + ((W - 8) * i) / Math.max(1, n - 1);
  const y = (v: number) => 4 + (H - 8) * (1 - (v - lo) / Math.max(0.0001, hi - lo));
  const zero = lo < 0 && hi > 0 ? <line x1={4} x2={W - 4} y1={y(0)} y2={y(0)} className="grid-line" /> : null;
  return (
    <svg className="chart small" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {zero}
      <path d={values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} fill="none" stroke={color} strokeWidth={2} />
      <line x1={x(day)} x2={x(day)} y1={2} y2={H - 2} className="now-line" />
    </svg>
  );
}
