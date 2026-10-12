import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { Storage } from '../storage.js';
import type { TimesheetEntry } from '../types.js';
import { resolveCustomerId } from '../types.js';
import { nowTimestamp, calcTotalMinutes, roundUp15 } from '../time-utils.js';

/**
 * Keep the entry's client and activity coherent: an activity belongs to exactly
 * one client, so picking one pins the other. Only a bare client (no activity
 * chosen yet) stands on its own — which is the whole point of storing the
 * client on the entry.
 *
 * Resolved before taking the day-file lock, never inside withTimesheet.
 */
async function ownerOf(storage: Storage, activityId: string, fallback: string): Promise<string> {
  if (!activityId) return fallback;
  const { activities } = await storage.loadActivities();
  return activities.find((a) => a.id === activityId)?.customerId || fallback;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

export function createTimesheetRouter(storage: Storage) {
  const router = Router();

  router.get('/:date', async (req, res) => {
    const data = await storage.loadTimesheet(req.params.date);
    res.json(data);
  });

  router.post('/:date/entries', async (req, res) => {
    const activityId = asString(req.body.activityId);
    const customerId = await ownerOf(storage, activityId, asString(req.body.customerId));

    const entry: TimesheetEntry = {
      id: uuid(),
      customerId,
      activityId,
      description: asString(req.body.description),
      segments: [{ start: nowTimestamp(), end: null }],
      totalMinutes: 0,
      roundedMinutes: 0,
      status: 'active',
    };

    const data = await storage.withTimesheet(req.params.date, (d) => {
      d.entries.push(entry);
      d.activeEntries.push(entry.id);
    });
    res.status(201).json(data);
  });

  router.patch('/:date/entries/:id', async (req, res) => {
    const setsActivity = typeof req.body.activityId === 'string';
    const setsCustomer = typeof req.body.customerId === 'string';
    // Read outside the day-file lock: withTimesheet holds it for the whole callback.
    const activities = setsActivity || setsCustomer
      ? (await storage.loadActivities()).activities
      : [];

    let found = false;
    const data = await storage.withTimesheet(req.params.date, (d) => {
      const entry = d.entries.find((e) => e.id === req.params.id);
      if (!entry) return false;
      found = true;

      if (req.body.status === 'completed') {
        const openSeg = entry.segments.find((s) => s.end === null);
        if (openSeg) openSeg.end = nowTimestamp();
        entry.totalMinutes = calcTotalMinutes(entry.segments);
        entry.roundedMinutes = roundUp15(entry.totalMinutes);
        entry.status = 'completed';
        delete entry.autoPausedAt;
        delete entry.autoPauseReason;
        d.activeEntries = d.activeEntries.filter((id) => id !== entry.id);
        d.pausedEntries = d.pausedEntries.filter((id) => id !== entry.id);
        return;
      }

      if (typeof req.body.description === 'string') entry.description = req.body.description;
      if (req.body.deferred !== undefined) entry.deferred = !!req.body.deferred;

      if (setsActivity || setsCustomer) {
        const nextActivityId = setsActivity ? req.body.activityId : entry.activityId;
        const activity = activities.find((a) => a.id === nextActivityId);
        // An explicit client in the request wins — it is what the user just
        // picked. Failing that the activity pins its own client, and failing
        // that the entry keeps the client it already had.
        const nextCustomerId = setsCustomer
          ? req.body.customerId
          : activity?.customerId || resolveCustomerId(entry, activities);
        // An activity belonging to somebody else would make the pair lie about
        // itself, so the client wins and the activity is dropped.
        const activityFits = !activity || !activity.customerId || activity.customerId === nextCustomerId;
        entry.activityId = activityFits ? nextActivityId : '';
        entry.customerId = nextCustomerId;
      }

      if (req.body.roundedMinutes !== undefined) {
        const rounded = Math.round(Number(req.body.roundedMinutes));
        if (Number.isFinite(rounded) && rounded >= 0) entry.roundedMinutes = rounded;
      }

      // Manual duration edit on an entry with no running segment (e.g. paused).
      // Rewrite the segments to a single one of that length so the edit survives
      // resume + finish, which recompute totalMinutes/roundedMinutes from segments.
      if (req.body.totalMinutes !== undefined) {
        const openSeg = entry.segments.find((s) => s.end === null);
        const mins = Math.round(Number(req.body.totalMinutes));
        if (!openSeg && Number.isFinite(mins) && mins >= 0) {
          const start = entry.segments[0]?.start ?? new Date(Date.now() - mins * 60000).toISOString();
          const end = new Date(new Date(start).getTime() + mins * 60000).toISOString();
          entry.segments = [{ start, end }];
          entry.totalMinutes = mins;
          entry.roundedMinutes = roundUp15(mins);
        }
      }
    });

    if (!found) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  });

  // Soft delete: the entry is flagged, never removed from the file, so it can
  // always be restored (see /restore below).
  router.delete('/:date/entries/:id', async (req, res) => {
    const data = await storage.withTimesheet(req.params.date, (d) => {
      const entry = d.entries.find((e) => e.id === req.params.id);
      if (!entry) return false;
      const openSeg = entry.segments.find((s) => s.end === null);
      if (openSeg) openSeg.end = nowTimestamp();
      entry.totalMinutes = calcTotalMinutes(entry.segments);
      entry.deleted = true;
      d.activeEntries = d.activeEntries.filter((id) => id !== entry.id);
      d.pausedEntries = d.pausedEntries.filter((id) => id !== entry.id);
    });
    res.json(data);
  });

  router.post('/:date/entries/:id/restore', async (req, res) => {
    let found = false;
    const data = await storage.withTimesheet(req.params.date, (d) => {
      const entry = d.entries.find((e) => e.id === req.params.id);
      if (!entry) return false;
      found = true;
      delete entry.deleted;
      // A restored entry comes back paused: its timer was stopped on delete and
      // we must not invent the time that passed in between.
      if (entry.status !== 'completed') {
        entry.status = 'paused';
        if (!d.pausedEntries.includes(entry.id)) d.pausedEntries.push(entry.id);
      }
    });
    if (!found) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  });

  // Hard delete: actually removes the entry. Only allowed once it's already
  // in the trash (soft-deleted), so this is "empty the trash", not a shortcut
  // that bypasses the undo safety net on a live entry.
  router.delete('/:date/entries/:id/purge', async (req, res) => {
    let found = false;
    let notDeleted = false;
    const data = await storage.withTimesheet(req.params.date, (d) => {
      const entry = d.entries.find((e) => e.id === req.params.id);
      if (!entry) return false;
      if (!entry.deleted) {
        notDeleted = true;
        return false;
      }
      found = true;
      d.entries = d.entries.filter((e) => e.id !== req.params.id);
    });
    if (notDeleted) return res.status(400).json({ error: 'Entry must be soft-deleted before it can be purged' });
    if (!found) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  });

  router.post('/:date/entries/:id/pause', async (req, res) => {
    let found = false;
    const data = await storage.withTimesheet(req.params.date, (d) => {
      const entry = d.entries.find((e) => e.id === req.params.id);
      if (!entry) return false;
      found = true;

      const openSeg = entry.segments.find((s) => s.end === null);
      if (openSeg) openSeg.end = nowTimestamp();
      entry.totalMinutes = calcTotalMinutes(entry.segments);
      entry.status = 'paused';
      // A manual pause clears any "paused by the system" marker.
      delete entry.autoPausedAt;
      delete entry.autoPauseReason;

      d.activeEntries = d.activeEntries.filter((id) => id !== entry.id);
      if (!d.pausedEntries.includes(entry.id)) d.pausedEntries.push(entry.id);
    });

    if (!found) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  });

  router.post('/:date/entries/:id/resume', async (req, res) => {
    let found = false;
    const data = await storage.withTimesheet(req.params.date, (d) => {
      const entry = d.entries.find((e) => e.id === req.params.id);
      if (!entry) return false;
      found = true;

      entry.segments.push({ start: nowTimestamp(), end: null });
      entry.status = 'active';
      delete entry.autoPausedAt;
      delete entry.autoPauseReason;
      delete entry.recoveredAt;
      if (!d.activeEntries.includes(entry.id)) d.activeEntries.push(entry.id);
      d.pausedEntries = d.pausedEntries.filter((id) => id !== entry.id);
    });

    if (!found) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  });

  // Reopen a completed entry: turn it back into a running timer, keeping its
  // accumulated time. On finish it will be recomputed from the segments, so we
  // first make sure the closed segments actually reflect totalMinutes (merged or
  // manually-edited entries may carry placeholder segments), then add an open one.
  router.post('/:date/entries/:id/reopen', async (req, res) => {
    let found = false;
    const data = await storage.withTimesheet(req.params.date, (d) => {
      const entry = d.entries.find((e) => e.id === req.params.id);
      if (!entry) return false;
      found = true;

      const closedTotal = calcTotalMinutes(entry.segments);
      if (closedTotal !== entry.totalMinutes) {
        const start = entry.segments[0]?.start ?? new Date(Date.now() - entry.totalMinutes * 60000).toISOString();
        const end = new Date(new Date(start).getTime() + entry.totalMinutes * 60000).toISOString();
        entry.segments = [{ start, end }];
      }
      entry.segments.push({ start: nowTimestamp(), end: null });
      entry.status = 'active';
      if (!d.activeEntries.includes(entry.id)) d.activeEntries.push(entry.id);
      d.pausedEntries = d.pausedEntries.filter((id) => id !== entry.id);
    });

    if (!found) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  });

  // Merge: create a completed entry that keeps the real time span of the
  // originals, and soft-delete the originals so the merge can be undone.
  router.post('/:date/entries/merge', async (req, res) => {
    const { entryIds, description } = req.body;

    if (!Array.isArray(entryIds) || entryIds.length < 2) {
      return res.status(400).json({ error: 'Need at least 2 entry IDs' });
    }

    const activityId = asString(req.body.activityId);
    const customerId = await ownerOf(storage, activityId, asString(req.body.customerId));

    let error: string | null = null;
    const data = await storage.withTimesheet(req.params.date, (d) => {
      const ids = new Set(entryIds as string[]);
      const originals = d.entries.filter((e) => ids.has(e.id) && !e.deleted);
      if (originals.length < 2) {
        error = 'Entries not found';
        return false;
      }

      // Durations come from the stored entries, never from the client.
      const total = originals.reduce((sum, e) => {
        const useIndicated = Array.isArray(req.body.useIndicated)
          && req.body.useIndicated.includes(e.id);
        return sum + (useIndicated ? e.roundedMinutes : e.totalMinutes);
      }, 0);

      // Keep the real span: earliest start, latest end of the merged entries.
      const starts = originals.flatMap((e) => e.segments.map((s) => s.start)).sort();
      const ends = originals
        .flatMap((e) => e.segments.map((s) => s.end))
        .filter((v): v is string => !!v)
        .sort();
      const start = starts[0] ?? nowTimestamp();
      const end = ends[ends.length - 1] ?? start;

      const merged: TimesheetEntry = {
        id: uuid(),
        customerId,
        activityId,
        description: typeof description === 'string' ? description : '',
        segments: [{ start, end }],
        totalMinutes: total,
        roundedMinutes: roundUp15(total),
        status: 'completed',
      };
      // Carry over the "to report in Odoo" flag if any original had it.
      if (originals.some((e) => e.deferred)) merged.deferred = true;

      d.entries.push(merged);

      for (const e of originals) {
        e.deleted = true;
      }
      d.activeEntries = d.activeEntries.filter((id) => !ids.has(id));
      d.pausedEntries = d.pausedEntries.filter((id) => !ids.has(id));
    });

    if (error) return res.status(404).json({ error });
    res.status(201).json(data);
  });

  return router;
}
