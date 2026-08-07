import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { Storage } from '../storage.js';
import type { TimesheetEntry, TimesheetDay } from '../types.js';
import {
  nowTimestamp, calcTotalMinutes, roundUp15,
  dateStr, startOfDayIso, endOfDayIso, nextDate,
} from '../time-utils.js';

/**
 * System-driven timer maintenance. The point of all of this is that a running
 * timer must never count time the user did not work: the Mac going to sleep, the
 * session being locked, the app being quit, or a day boundary being crossed all
 * close the open segment at the last moment we know was real work.
 *
 * Nothing here ever deletes an entry or shortens an already-closed segment.
 */

/** A lock shorter than this is treated as a blink: the timer resumes by itself. */
const AUTO_RESUME_MAX_ABSENCE_MS = 2 * 60 * 1000;

/** How many recent day files to look at when hunting for open segments. */
const SCAN_DAYS = 14;

type AutoPauseReason = 'suspend' | 'lock' | 'quit';

function openSegments(entry: TimesheetEntry) {
  return entry.segments.filter((s) => s.end === null);
}

function hasOpenSegment(day: TimesheetDay): boolean {
  return day.entries.some((e) => !e.deleted && openSegments(e).length > 0);
}

/** Close every open segment of the entry at `at`, without ever going backwards. */
function closeOpenSegmentsAt(entry: TimesheetEntry, at: string): boolean {
  let changed = false;
  for (const seg of openSegments(entry)) {
    const start = new Date(seg.start).getTime();
    const end = new Date(at).getTime();
    // Never write an end before the start (clock changes, stale lastSeenAt).
    seg.end = end >= start ? at : seg.start;
    changed = true;
  }
  if (changed) entry.totalMinutes = calcTotalMinutes(entry.segments);
  return changed;
}

function markPaused(day: TimesheetDay, entry: TimesheetEntry): void {
  entry.status = 'paused';
  day.activeEntries = day.activeEntries.filter((id) => id !== entry.id);
  if (!day.pausedEntries.includes(entry.id)) day.pausedEntries.push(entry.id);
}

export function createSystemRouter(storage: Storage) {
  const router = Router();

  /** Recent dates plus today, oldest first, deduplicated. */
  async function datesToScan(): Promise<string[]> {
    const recent = await storage.recentDates(SCAN_DAYS);
    return [...new Set([...recent, dateStr()])].sort();
  }

  // The Mac went to sleep / the session got locked / the app is quitting: stop
  // the clock now, and remember it was us so a short absence can resume itself.
  router.post('/suspend', async (req, res) => {
    const reason: AutoPauseReason =
      req.body?.reason === 'lock' || req.body?.reason === 'quit' ? req.body.reason : 'suspend';
    const at = nowTimestamp();
    let paused = 0;

    for (const date of await datesToScan()) {
      await storage.withTimesheet(date, (day) => {
        let changed = false;
        for (const entry of day.entries) {
          if (entry.deleted || openSegments(entry).length === 0) continue;
          closeOpenSegmentsAt(entry, at);
          entry.autoPausedAt = at;
          entry.autoPauseReason = reason;
          markPaused(day, entry);
          paused++;
          changed = true;
        }
        return changed;
      });
    }

    await storage.touchRuntime(at);
    res.json({ paused, at, reason });
  });

  // Back from sleep / unlocked: only timers we paused ourselves a very short
  // time ago restart on their own. Longer absences stay paused and keep their
  // marker so the UI can say why.
  router.post('/resume', async (req, res) => {
    const at = nowTimestamp();
    const now = new Date(at).getTime();
    let resumed = 0;
    let stillPaused = 0;

    for (const date of await datesToScan()) {
      await storage.withTimesheet(date, (day) => {
        let changed = false;
        for (const entry of day.entries) {
          if (entry.deleted || !entry.autoPausedAt || entry.status !== 'paused') continue;
          const absence = now - new Date(entry.autoPausedAt).getTime();
          if (absence <= AUTO_RESUME_MAX_ABSENCE_MS) {
            entry.segments.push({ start: at, end: null });
            entry.status = 'active';
            delete entry.autoPausedAt;
            delete entry.autoPauseReason;
            day.pausedEntries = day.pausedEntries.filter((id) => id !== entry.id);
            if (!day.activeEntries.includes(entry.id)) day.activeEntries.push(entry.id);
            resumed++;
            changed = true;
          } else {
            stillPaused++;
          }
        }
        return changed;
      });
    }

    await storage.touchRuntime(at);
    res.json({ resumed, stillPaused, at });
  });

  // Called periodically while the app runs, so that after a crash or a forced
  // quit we know when it was last alive.
  router.post('/heartbeat', async (_req, res) => {
    const at = nowTimestamp();
    await storage.touchRuntime(at);
    res.json({ ok: true, at });
  });

  // Startup: a segment still open means the app stopped without closing it.
  // Close it at the last moment the app was known to be alive rather than
  // counting the whole downtime.
  router.post('/recover', async (_req, res) => {
    const { lastSeenAt } = await storage.readRuntime();
    const today = dateStr();
    let recovered = 0;

    for (const date of await datesToScan()) {
      await storage.withTimesheet(date, (day) => {
        let changed = false;
        for (const entry of day.entries) {
          if (entry.deleted || openSegments(entry).length === 0) continue;

          // Without a heartbeat (first run after upgrade) we have no idea when
          // the app died. Cap a past day at its own end and leave today's timer
          // running rather than guessing.
          let closeAt = lastSeenAt;
          if (!closeAt) {
            if (date >= today) continue;
            closeAt = endOfDayIso(date);
          }
          // A day's timer can never legitimately run past that day.
          const dayEnd = endOfDayIso(date);
          if (new Date(closeAt).getTime() > new Date(dayEnd).getTime()) closeAt = dayEnd;

          closeOpenSegmentsAt(entry, closeAt);
          entry.recoveredAt = closeAt;
          markPaused(day, entry);
          recovered++;
          changed = true;
        }
        return changed;
      });
    }

    res.json({ recovered, lastSeenAt: lastSeenAt ?? null });
  });

  // A timer that crosses midnight would otherwise pile all its hours onto the
  // day it was started, which is the wrong date for the Odoo export. Close it at
  // 23:59:59 and continue it on the next day.
  router.post('/rollover', async (_req, res) => {
    const today = dateStr();
    const splits: { from: string; to: string; entries: number }[] = [];

    // Each split can push work into the next day, which may itself need a split
    // (a timer left running for several days). Bounded to stay safe.
    for (let guard = 0; guard < 60; guard++) {
      const dates = (await datesToScan()).filter((d) => d < today);
      let target: string | null = null;
      for (const date of dates) {
        if (hasOpenSegment(await storage.loadTimesheet(date))) {
          target = date;
          break;
        }
      }
      if (!target) break;

      const continuations: TimesheetEntry[] = [];
      const closeAt = endOfDayIso(target);

      await storage.withTimesheet(target, (day) => {
        for (const entry of day.entries) {
          if (entry.deleted || openSegments(entry).length === 0) continue;

          closeOpenSegmentsAt(entry, closeAt);
          entry.status = 'completed';
          entry.roundedMinutes = roundUp15(entry.totalMinutes);
          entry.splitAtMidnight = true;
          delete entry.autoPausedAt;
          delete entry.autoPauseReason;
          day.activeEntries = day.activeEntries.filter((id) => id !== entry.id);
          day.pausedEntries = day.pausedEntries.filter((id) => id !== entry.id);

          continuations.push({
            id: uuid(),
            activityId: entry.activityId,
            description: entry.description,
            segments: [{ start: startOfDayIso(nextDate(target!)), end: null }],
            totalMinutes: 0,
            roundedMinutes: 0,
            status: 'active',
            splitAtMidnight: true,
            continuedFrom: entry.id,
          });
        }
      });

      const to = nextDate(target);
      if (continuations.length > 0) {
        await storage.withTimesheet(to, (day) => {
          for (const entry of continuations) {
            day.entries.push(entry);
            day.activeEntries.push(entry.id);
          }
        });
      }
      splits.push({ from: target, to, entries: continuations.length });
    }

    res.json({ splits });
  });

  return router;
}
