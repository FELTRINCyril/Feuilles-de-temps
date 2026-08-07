import type { Segment } from './types.js';

export function roundUp15(minutes: number): number {
  if (minutes === 0) return 0;
  return Math.ceil(minutes / 15) * 15;
}

export function calcSegmentMs(segment: Segment): number {
  if (!segment.end) return 0;
  const ms = new Date(segment.end).getTime() - new Date(segment.start).getTime();
  return ms > 0 ? ms : 0;
}

export function calcTotalMs(segments: Segment[]): number {
  return segments.reduce((sum, seg) => sum + calcSegmentMs(seg), 0);
}

/**
 * Minutes across every closed segment. Rounds only once, on the summed
 * milliseconds — rounding per segment first (the previous behaviour) drops a
 * few minutes on any day broken into several interruptions: three 9m50s
 * segments summed as minutes gave 9+9+9=27 instead of the correct 29.
 */
export function calcTotalMinutes(segments: Segment[]): number {
  const ms = calcTotalMs(segments);
  return ms > 0 ? Math.max(1, Math.floor(ms / 60000)) : 0;
}

/**
 * Same rounding rule as calcTotalMinutes, but a still-open segment counts up to
 * `now` instead of 0 — for reporting the current total of an active/paused
 * entry while it runs (e.g. in the stats API).
 */
export function calcLiveTotalMinutes(segments: Segment[], now: number = Date.now()): number {
  const ms = segments.reduce((sum, seg) => {
    const start = new Date(seg.start).getTime();
    const end = seg.end ? new Date(seg.end).getTime() : now;
    return sum + Math.max(0, end - start);
  }, 0);
  return ms > 0 ? Math.max(1, Math.floor(ms / 60000)) : 0;
}

export function nowTimestamp(): string {
  return new Date().toISOString();
}

/** Local calendar date (YYYY-MM-DD) of a Date, defaulting to now. */
export function dateStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO timestamp of 00:00:00.000 local time on the given YYYY-MM-DD. */
export function startOfDayIso(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

/** ISO timestamp of 23:59:59.999 local time on the given YYYY-MM-DD. */
export function endOfDayIso(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

/** The YYYY-MM-DD that follows the given one. */
export function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return dateStr(new Date(y, m - 1, d + 1));
}

/** Extract HH:mm from an ISO timestamp for display/CSV. */
export function toHHmm(isoOrHhmm: string): string {
  if (isoOrHhmm.includes('T')) {
    const d = new Date(isoOrHhmm);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return isoOrHhmm;
}
