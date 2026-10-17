// Names and colors of the six Hexad types, in the fixed order used by the core.
export const TYPES = [
  { key: 'achiever', name: 'Achiever', hint: 'busca domínio e conquistas', color: '#2f6fdd' },
  { key: 'player', name: 'Player', hint: 'busca pontos e recompensas', color: '#c2255c' },
  { key: 'socialiser', name: 'Socialiser', hint: 'busca vínculo com os outros', color: '#2f9e44' },
  { key: 'freeSpirit', name: 'Free Spirit', hint: 'busca autonomia e exploração', color: '#0f9aa8' },
  { key: 'disruptor', name: 'Disruptor', hint: 'busca mudar o sistema', color: '#7048e8' },
  { key: 'philanthropist', name: 'Philanthropist', hint: 'busca ajudar os outros', color: '#b7791f' },
] as const;

/** Affinity vector with one dominant type (and optionally a second one). */
export function preset(dominant: number, second?: number): number[] {
  const v = [0, 0, 0, 0, 0, 0];
  v[dominant] = 1;
  if (second !== undefined) v[second] = 0.5;
  return v;
}
