import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { createApp } from '../app.js';

const TEST_DATA_DIR = path.join(import.meta.dirname, '../../data-test-timesheet');
const DATE = '2026-02-20';

describe('Timesheet API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
    app = createApp(TEST_DATA_DIR);
  });

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('GET /api/timesheet/:date returns empty day', async () => {
    const res = await request(app).get(`/api/timesheet/${DATE}`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.activeEntries).toHaveLength(0);
  });

  it('POST creates entry and starts timer', async () => {
    const res = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1',  description: 'Working' });
    expect(res.status).toBe(201);
    const entry = res.body.entries.find(
      (e: any) => e.activityId === 'p1',
    );
    expect(entry.status).toBe('active');
    expect(entry.segments).toHaveLength(1);
    expect(entry.segments[0].end).toBeNull();
    expect(res.body.activeEntries).toContain(entry.id);
  });

  it('POST /pause pauses active entry', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1',  description: 'W' });
    const entryId = create.body.activeEntries[0];
    const res = await request(app)
      .post(`/api/timesheet/${DATE}/entries/${entryId}/pause`);
    expect(res.status).toBe(200);
    const entry = res.body.entries.find((e: any) => e.id === entryId);
    expect(entry.status).toBe('paused');
    expect(entry.segments[0].end).not.toBeNull();
    expect(res.body.activeEntries).toHaveLength(0);
    expect(res.body.pausedEntries).toContain(entryId);
  });

  it('POST /resume resumes paused entry', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1',  description: 'W' });
    const entryId = create.body.activeEntries[0];
    await request(app)
      .post(`/api/timesheet/${DATE}/entries/${entryId}/pause`);
    const res = await request(app)
      .post(`/api/timesheet/${DATE}/entries/${entryId}/resume`);
    expect(res.status).toBe(200);
    const entry = res.body.entries.find((e: any) => e.id === entryId);
    expect(entry.status).toBe('active');
    expect(entry.segments).toHaveLength(2);
    expect(entry.segments[1].end).toBeNull();
    expect(res.body.activeEntries).toContain(entryId);
    expect(res.body.pausedEntries).not.toContain(entryId);
  });

  it('parallel timers: new entry does not pause existing active', async () => {
    const a = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: 'Task A' });
    const idA = a.body.activeEntries[0];

    const b = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p2', description: 'Task B' });

    expect(b.body.activeEntries).toHaveLength(2);
    expect(b.body.activeEntries).toContain(idA);
    const entryA = b.body.entries.find((e: any) => e.id === idA);
    expect(entryA.status).toBe('active');
  });

  it('pause one of multiple active entries', async () => {
    const a = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: 'Task A' });
    const b = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p2', description: 'Task B' });
    const idA = a.body.activeEntries[0];

    const res = await request(app)
      .post(`/api/timesheet/${DATE}/entries/${idA}/pause`);
    expect(res.body.activeEntries).not.toContain(idA);
    expect(res.body.activeEntries).toHaveLength(1);
    expect(res.body.pausedEntries).toContain(idA);
  });

  it('PATCH updates entry description', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1',  description: 'Old' });
    const entryId = create.body.activeEntries[0];
    const res = await request(app)
      .patch(`/api/timesheet/${DATE}/entries/${entryId}`)
      .send({ description: 'New' });
    const entry = res.body.entries.find((e: any) => e.id === entryId);
    expect(entry.description).toBe('New');
  });

  it('PATCH with status=completed stops timer and rounds', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1',  description: 'W' });
    const entryId = create.body.activeEntries[0];
    const res = await request(app)
      .patch(`/api/timesheet/${DATE}/entries/${entryId}`)
      .send({ status: 'completed' });
    const entry = res.body.entries.find((e: any) => e.id === entryId);
    expect(entry.status).toBe('completed');
    expect(entry.segments[0].end).not.toBeNull();
    expect(entry.roundedMinutes % 15).toBe(0);
    expect(res.body.activeEntries).toHaveLength(0);
  });

  it('DELETE soft-deletes the entry and stops its timer', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1',  description: 'W' });
    const entryId = create.body.activeEntries[0];
    const res = await request(app)
      .delete(`/api/timesheet/${DATE}/entries/${entryId}`);
    expect(res.status).toBe(200);
    // Kept in the file so it can be restored, but out of the running lists
    const entry = res.body.entries.find((e: any) => e.id === entryId);
    expect(entry.deleted).toBe(true);
    expect(entry.segments.every((s: any) => s.end !== null)).toBe(true);
    expect(res.body.activeEntries).toHaveLength(0);
    expect(res.body.pausedEntries).toHaveLength(0);
  });

  it('POST /restore brings a deleted entry back, paused', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: 'W' });
    const entryId = create.body.activeEntries[0];
    await request(app).delete(`/api/timesheet/${DATE}/entries/${entryId}`);

    const res = await request(app).post(`/api/timesheet/${DATE}/entries/${entryId}/restore`);
    expect(res.status).toBe(200);
    const entry = res.body.entries.find((e: any) => e.id === entryId);
    expect(entry.deleted).toBeUndefined();
    expect(entry.status).toBe('paused');
    expect(res.body.pausedEntries).toContain(entryId);
    // No time invented while it was deleted
    expect(entry.segments.every((s: any) => s.end !== null)).toBe(true);
  });

  it('restoring a deleted completed entry keeps it completed', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: 'W' });
    const entryId = create.body.activeEntries[0];
    await request(app)
      .patch(`/api/timesheet/${DATE}/entries/${entryId}`)
      .send({ status: 'completed' });
    await request(app).delete(`/api/timesheet/${DATE}/entries/${entryId}`);

    const res = await request(app).post(`/api/timesheet/${DATE}/entries/${entryId}/restore`);
    const entry = res.body.entries.find((e: any) => e.id === entryId);
    expect(entry.status).toBe('completed');
    expect(res.body.pausedEntries).not.toContain(entryId);
  });

  it('DELETE /purge refuses to remove an entry that is not in the trash', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: 'W' });
    const entryId = create.body.activeEntries[0];

    const res = await request(app).delete(`/api/timesheet/${DATE}/entries/${entryId}/purge`);
    expect(res.status).toBe(400);
    const day = await request(app).get(`/api/timesheet/${DATE}`);
    expect(day.body.entries.find((e: any) => e.id === entryId)).toBeDefined();
  });

  it('DELETE /purge permanently removes a soft-deleted entry', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: 'W' });
    const entryId = create.body.activeEntries[0];
    await request(app).delete(`/api/timesheet/${DATE}/entries/${entryId}`);

    const res = await request(app).delete(`/api/timesheet/${DATE}/entries/${entryId}/purge`);
    expect(res.status).toBe(200);
    expect(res.body.entries.find((e: any) => e.id === entryId)).toBeUndefined();

    // Gone for good: restore can no longer bring it back
    const restore = await request(app).post(`/api/timesheet/${DATE}/entries/${entryId}/restore`);
    expect(restore.status).toBe(404);
  });

  it('concurrent PATCHes on the same day do not lose each other', async () => {
    const a = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: '' });
    const idA = a.body.activeEntries[0];
    const b = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p2', description: '' });
    const idB = b.body.activeEntries.find((id: string) => id !== idA);

    // Both windows editing at the same time: neither write may be dropped
    await Promise.all([
      request(app).patch(`/api/timesheet/${DATE}/entries/${idA}`).send({ description: 'from window A' }),
      request(app).patch(`/api/timesheet/${DATE}/entries/${idB}`).send({ description: 'from popup B' }),
    ]);

    const res = await request(app).get(`/api/timesheet/${DATE}`);
    expect(res.body.entries.find((e: any) => e.id === idA).description).toBe('from window A');
    expect(res.body.entries.find((e: any) => e.id === idB).description).toBe('from popup B');
  });

  it('PATCH on a missing entry returns 404 and writes nothing', async () => {
    const res = await request(app)
      .patch(`/api/timesheet/${DATE}/entries/does-not-exist`)
      .send({ description: 'x' });
    expect(res.status).toBe(404);
  });

  it('merge keeps the real time span, sums stored durations and is undoable', async () => {
    const a = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: 'A' });
    const idA = a.body.activeEntries[0];
    await request(app).post(`/api/timesheet/${DATE}/entries/${idA}/pause`);
    await request(app).patch(`/api/timesheet/${DATE}/entries/${idA}`).send({ totalMinutes: 20 });
    await request(app).patch(`/api/timesheet/${DATE}/entries/${idA}`).send({ status: 'completed' });

    const b = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: 'B' });
    const idB = b.body.activeEntries[0];
    await request(app).post(`/api/timesheet/${DATE}/entries/${idB}/pause`);
    await request(app).patch(`/api/timesheet/${DATE}/entries/${idB}`).send({ totalMinutes: 10 });
    await request(app).patch(`/api/timesheet/${DATE}/entries/${idB}`).send({ status: 'completed' });

    const res = await request(app)
      .post(`/api/timesheet/${DATE}/entries/merge`)
      .send({ entryIds: [idA, idB], activityId: 'p1', description: 'A / B' });
    expect(res.status).toBe(201);

    const merged = res.body.entries.find((e: any) => e.description === 'A / B');
    // 20 + 10 recomputed server-side, rounded up to 30
    expect(merged.totalMinutes).toBe(30);
    expect(merged.roundedMinutes).toBe(30);
    // Real span kept, not the merge timestamp
    const starts = [idA, idB].map(id => res.body.entries.find((e: any) => e.id === id).segments[0].start).sort();
    expect(merged.segments[0].start).toBe(starts[0]);
    expect(merged.segments[0].end).not.toBe(merged.segments[0].start);
    // Originals are soft-deleted, so the merge can be undone
    for (const id of [idA, idB]) {
      expect(res.body.entries.find((e: any) => e.id === id).deleted).toBe(true);
    }
  });

  it('merge refuses unknown entries', async () => {
    const res = await request(app)
      .post(`/api/timesheet/${DATE}/entries/merge`)
      .send({ entryIds: ['nope-1', 'nope-2'], activityId: '', description: '' });
    expect(res.status).toBe(404);
  });

  it('PATCH ignores garbage values instead of storing them', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: 'W' });
    const entryId = create.body.activeEntries[0];
    const res = await request(app)
      .patch(`/api/timesheet/${DATE}/entries/${entryId}`)
      .send({ roundedMinutes: 'beaucoup', description: { evil: true } });
    const entry = res.body.entries.find((e: any) => e.id === entryId);
    expect(entry.roundedMinutes).toBe(0);
    expect(entry.description).toBe('W');
  });

  it('PATCH totalMinutes edits a paused entry and survives resume+finish', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: 'W' });
    const entryId = create.body.activeEntries[0];
    await request(app).post(`/api/timesheet/${DATE}/entries/${entryId}/pause`);

    // Edit the accumulated time + description while paused
    const edit = await request(app)
      .patch(`/api/timesheet/${DATE}/entries/${entryId}`)
      .send({ totalMinutes: 40, description: 'Corrigé' });
    const edited = edit.body.entries.find((e: any) => e.id === entryId);
    expect(edited.totalMinutes).toBe(40);
    expect(edited.roundedMinutes).toBe(45);
    expect(edited.description).toBe('Corrigé');
    expect(edited.segments).toHaveLength(1);

    // Resume then finish: the manual 40 min must still be the floor of the total
    await request(app).post(`/api/timesheet/${DATE}/entries/${entryId}/resume`);
    const done = await request(app)
      .patch(`/api/timesheet/${DATE}/entries/${entryId}`)
      .send({ status: 'completed' });
    const finished = done.body.entries.find((e: any) => e.id === entryId);
    expect(finished.status).toBe('completed');
    expect(finished.totalMinutes).toBeGreaterThanOrEqual(40);
  });

  it('POST /reopen turns a completed entry back into a running timer, keeping its time', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: 'W' });
    const entryId = create.body.activeEntries[0];
    // Pause to accumulate a fixed duration, then edit it to a known value, then finish
    await request(app).post(`/api/timesheet/${DATE}/entries/${entryId}/pause`);
    await request(app)
      .patch(`/api/timesheet/${DATE}/entries/${entryId}`)
      .send({ totalMinutes: 30 });
    await request(app)
      .patch(`/api/timesheet/${DATE}/entries/${entryId}`)
      .send({ status: 'completed' });

    const res = await request(app).post(`/api/timesheet/${DATE}/entries/${entryId}/reopen`);
    expect(res.status).toBe(200);
    const entry = res.body.entries.find((e: any) => e.id === entryId);
    expect(entry.status).toBe('active');
    expect(entry.segments.some((s: any) => s.end === null)).toBe(true);
    expect(res.body.activeEntries).toContain(entryId);
    // Closed segments still represent the accumulated 30 min
    const closed = entry.segments.filter((s: any) => s.end !== null);
    const closedTotal = closed.reduce((sum: number, s: any) =>
      sum + Math.floor((new Date(s.end).getTime() - new Date(s.start).getTime()) / 60000), 0);
    expect(closedTotal).toBe(30);
  });

  it('PATCH totalMinutes does not rewrite a running (active) entry', async () => {
    const create = await request(app)
      .post(`/api/timesheet/${DATE}/entries`)
      .send({ activityId: 'p1', description: 'W' });
    const entryId = create.body.activeEntries[0];
    const res = await request(app)
      .patch(`/api/timesheet/${DATE}/entries/${entryId}`)
      .send({ totalMinutes: 40 });
    const entry = res.body.entries.find((e: any) => e.id === entryId);
    // Still running: open segment preserved, no manual rewrite
    expect(entry.segments.some((s: any) => s.end === null)).toBe(true);
    expect(entry.totalMinutes).toBe(0);
  });
});
