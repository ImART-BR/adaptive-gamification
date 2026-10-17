import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { orderOf, presentationOf } from './presentation.ts';
import { trackExposure, trackInteraction } from './track.ts';

/** Today's weight of each game element, decided by the server (control: all 0.5; adaptive: from the core). */
export const WeightsContext = createContext<Record<string, number>>({});


/**
 * Wraps one game element of the catalog and applies the weight the server decided:
 * - weight >= 0.7: highlighted (accent border) and placed earlier in grids;
 * - weight <= 0.3: reduced to its title plus a "Ver detalhes" button, placed later; the user can always expand it;
 * - otherwise: normal.
 * It reports an exposure when at least half of it has been visible for 600 ms (once per mount; the server stamps the
 * weight as the prominence) and an interaction when the user clicks, focuses or types inside it.
 */
export function GameElement({ id, className = '', children }: { id: string; className?: string; children: ReactNode }) {
  const weights = useContext(WeightsContext);
  const weight = weights[id] ?? 0.5;
  const mode = presentationOf(weight);
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let timeout: number | undefined;
    let reported = false;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.5);
        if (visible && !reported && timeout === undefined) {
          timeout = window.setTimeout(() => {
            reported = true;
            trackExposure(id, weight);
          }, 600);
        } else if (!visible && timeout !== undefined) {
          window.clearTimeout(timeout);
          timeout = undefined;
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    io.observe(node);
    return () => {
      io.disconnect();
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [id, weight]);

  const reduced = mode === 'compact' && !expanded;
  return (
    <section
      ref={ref}
      data-element={id}
      data-weight={weight.toFixed(2)}
      className={`card element ${mode === 'featured' ? 'featured' : ''} ${reduced ? 'compact' : ''} ${className}`}
      style={{ order: orderOf(weight) }}
      onClickCapture={() => trackInteraction(id)}
      onFocusCapture={() => trackInteraction(id)}
    >
      {children}
      {reduced && (
        <button className="btn compact-toggle" onClick={() => setExpanded(true)}>
          Ver detalhes
        </button>
      )}
    </section>
  );
}
