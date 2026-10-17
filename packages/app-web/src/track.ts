// Research event reporting. The client only reports exposure and interaction with game elements;
// the server stamps user, session and time, and produces the outcome events itself.
import { post } from './api.ts';

interface Pending {
  type: 'exposure' | 'interaction';
  elementId: string;
  prominence?: number;
}

let queue: Pending[] = [];
let timer: number | undefined;
const lastInteraction = new Map<string, number>();

function flush(): void {
  timer = undefined;
  if (queue.length === 0) return;
  const events = queue.slice(0, 100);
  queue = queue.slice(100);
  post('/api/events', { events }).catch(() => {
    // Tracking must never break the app; drop on failure (keeps the log free of duplicates).
  });
  if (queue.length > 0) schedule();
}

function schedule(): void {
  if (timer === undefined) timer = window.setTimeout(flush, 4000);
}

/** The element was shown. In the static MVP prominence is always 1; with the experiment on it comes from the core's weight. */
export function trackExposure(elementId: string, prominence = 1): void {
  queue.push({ type: 'exposure', elementId, prominence });
  schedule();
}

/** The user did something with the element. At most one event per element every 2 seconds. */
export function trackInteraction(elementId: string): void {
  const now = Date.now();
  if (now - (lastInteraction.get(elementId) ?? 0) < 2000) return;
  lastInteraction.set(elementId, now);
  queue.push({ type: 'interaction', elementId });
  schedule();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (timer !== undefined) window.clearTimeout(timer);
    flush();
  }
});
