// How a weight decided by the core becomes interface. One place, shared by the app and by the
// visual simulation, so what you see in the simulation is exactly the rule the app applies.

/** Weight at or above which an element is shown featured, and at or below which it is shown reduced (never hidden). */
export const FEATURED_AT = 0.7;
export const COMPACT_AT = 0.3;

export type Presentation = 'featured' | 'normal' | 'compact';

export function presentationOf(weight: number): Presentation {
  return weight >= FEATURED_AT ? 'featured' : weight <= COMPACT_AT ? 'compact' : 'normal';
}

/** CSS `order` of an element in a grid: higher weight, earlier. */
export function orderOf(weight: number): number {
  return Math.round((1 - weight) * 20) + 1;
}
