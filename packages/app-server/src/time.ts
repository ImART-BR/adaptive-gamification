// Day boundaries. The study runs in Brazil: a "day" is a calendar day in America/Sao_Paulo (UTC-3, no DST since 2019).
export const TZ_OFFSET_MIN = -180;
const MS_DAY = 86_400_000;

/** Whole days since 1970-01-01 in the study's local time. */
export function dayNumber(ms: number): number {
  return Math.floor((ms + TZ_OFFSET_MIN * 60_000) / MS_DAY);
}

/** 'YYYY-MM-DD' of a day number. */
export function dayString(day: number): string {
  return new Date(day * MS_DAY).toISOString().slice(0, 10);
}

/** Day number of the Monday of the week containing `day`. */
export function weekStartDay(day: number): number {
  // 1970-01-01 was a Thursday: (day + 3) % 7 === 0 for Mondays.
  return day - ((day + 3) % 7);
}
