import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { createApp } from '../app.js';
import { Storage } from '../storage.js';
import { dateStr, endOfDayIso, startOfDayIso, nextDate } from '../time-utils.js';
import type { TimesheetEntry } from '../types.js';

const TEST_DATA_DIR = path.join(import.meta.dirname, '../../data-test-system');

function isoAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

function runningEntry(overrides: Partial<TimesheetEntry> = {}): TimesheetEntry {
  return {
    id: 'e1',
    activityId: 'a1',
    description: 'Travail',
    segments: [{ start: isoAgo(60), end: null }],
    totalMinutes: 0,
    roundedMinutes: 0,
    status: 'active',
    ...overrides,
  };
}

describe('System API', () => {
  let app: ReturnType<typeof createApp>;
  let storage: Storage;

  beforeEach(async () => {
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
    app = createApp(TEST_DATA_DIR);
    storage = new Storage(TEST_DATA_DIR);
  });

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  async function seedToday(entries: TimesheetEntry[]) {
    const date = dateStr();
    await storage.saveTimesheet({
      date,
      entries,
      activeEntries: entries.filter(e => e.status === 'active').map(e => e.id),
      pausedEntries: entries.filter(e => e.status === 'paused').map(e => e.id),
    });
    return date;
  }

  // ── Sleep / lock ──────────────────────────────────────────────────────────

  it('suspend closes the running segment and marks why', async () => {
    const date = await seedToday([runningEntry()]);

    const res = await request(app).post('/api/system/suspend').send({ reason: 'suspend' });
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(1);

    const day = await storage.loadTimesheet(date);
    const entry = day.entries[0];
    expect(entry.status).toBe('paused');
    expect(entry.segments[0].end).not.toBeNull();
    expect(entry.autoPauseReason).toBe('suspend');
    expect(entry.totalMinutes).toBeGreaterThanOrEqual(59);
    expect(day.activeEntries).toHaveLength(0);
    expect(day.pausedEntries).toContain(entry.id);
  });

  it('suspend does not touch a paused or deleted entry', async () => {
    const date = await seedToday([
      runningEntry({ id: 'paused', status: 'paused', segments: [{ start: isoAgo(30), end: isoAgo(20) }] }),
      runningEntry({ id: 'gone', deleted: true }),
    ]);

    const res = await request(app).post('/api/system/suspend').send({ reason: 'lock' });
    expect(res.body.paused).toBe(0);

    const day = await storage.loadTimesheet(date);
    expect(day.entries.find(e => e.id === 'gone')!.segments[0].end).toBeNull();
  });

  it('a short lock resumes by itself, a long absence stays paused', async () => {
    const date = await seedToday([
      runningEntry({ id: 'short', autoPausedAt: isoAgo(1), autoPauseReason: 'lock', status: 'paused', segments: [{ start: isoAgo(30), end: isoAgo(1) }] }),
      runningEntry({ id: 'long', autoPausedAt: isoAgo(45), autoPauseReason: 'suspend', status: 'paused', segments: [{ start: isoAgo(90), end: isoAgo(45) }] }),
    ]);

    const res = await request(app).post('/api/system/resume').send({});
    expect(res.body.resumed).toBe(1);
    expect(res.body.stillPaused).toBe(1);

    const day = await storage.loadTimesheet(date);
    const short = day.entries.find(e => e.id === 'short')!;
    const long = day.entries.find(e => e.id === 'long')!;
    expect(short.status).toBe('active');
    expect(short.segments.some(s => s.end === null)).toBe(true);
    expect(short.autoPausedAt).toBeUndefined();
    // The 45 min of absence are neither counted nor restarted
    expect(long.status).toBe('paused');
    expect(long.segments.every(s => s.end !== null)).toBe(true);
    expect(long.autoPauseReason).toBe('suspend');
  });

  it('resume does not restart a timer the user paused manually', async () => {
    const date = await seedToday([
      runningEntry({ id: 'manual', status: 'paused', segments: [{ start: isoAgo(30), end: isoAgo(1) }] }),
    ]);
    const res = await request(app).post('/api/system/resume').send({});
    expect(res.body.resumed).toBe(0);
    const day = await storage.loadTimesheet(date);
    expect(day.entries[0].status).toBe('paused');
  });

  // ── Crash / quit recovery ─────────────────────────────────────────────────

  it('recover closes an orphan segment at the last heartbeat, not at now', async () => {
    const lastSeen = isoAgo(120);
    await storage.touchRuntime(lastSeen);
    const date = await seedToday([runningEntry({ segments: [{ start: isoAgo(180), end: null }] })]);

    const res = await request(app).post('/api/system/recover').send({});
    expect(res.body.recovered).toBe(1);

    const day = await storage.loadTimesheet(date);
    const entry = day.entries[0];
    expect(entry.segments[0].end).toBe(lastSeen);
    expect(entry.recoveredAt).toBe(lastSeen);
    expect(entry.status).toBe('paused');
    // 3 h of open segment, only the 1 h before the app died is counted
    expect(entry.totalMinutes).toBeGreaterThanOrEqual(59);
    expect(entry.totalMinutes).toBeLessThanOrEqual(61);
  });

  it('recover never writes an end before the start', async () => {
    await storage.touchRuntime(isoAgo(300));
    const date = await seedToday([runningEntry({ segments: [{ start: isoAgo(60), end: null }] })]);

    await request(app).post('/api/system/recover').send({});
    const entry = (await storage.loadTimesheet(date)).entries[0];
    expect(entry.segments[0].end).toBe(entry.segments[0].start);
    expect(entry.totalMinutes).toBe(0);
  });

  it('without a heartbeat, recover leaves today alone and caps a past day', async () => {
    const past = '2026-02-20';
    await storage.saveTimesheet({
      date: past,
      entries: [runningEntry({ id: 'old', segments: [{ start: `${past}T08:00:00.000Z`, end: null }] })],
      activeEntries: ['old'],
      pausedEntries: [],
    });
    const today = await seedToday([runningEntry({ id: 'now' })]);

    const res = await request(app).post('/api/system/recover').send({});
    expect(res.body.recovered).toBe(1);

    expect((await storage.loadTimesheet(past)).entries[0].segments[0].end).toBe(endOfDayIso(past));
    // Today's running timer is left running: guessing would be worse
    expect((await storage.loadTimesheet(today)).entries[0].segments[0].end).toBeNull();
  });

  it('heartbeat records the time the app was last alive', async () => {
    const res = await request(app).post('/api/system/heartbeat').send({});
    expect(res.body.ok).toBe(true);
    expect((await storage.readRuntime()).lastSeenAt).toBe(res.body.at);
  });

  // ── Midnight ──────────────────────────────────────────────────────────────

  it('rollover closes a timer at 23:59:59 and continues it the next day', async () => {
    const past = '2026-02-20';
    await storage.saveTimesheet({
      date: past,
      entries: [runningEntry({ id: 'night', activityId: 'a9', description: 'Nuit', segments: [{ start: `${past}T20:00:00.000Z`, end: null }] })],
      activeEntries: ['night'],
      pausedEntries: [],
    });

    const res = await request(app).post('/api/system/rollover').send({});
    expect(res.body.splits.length).toBeGreaterThanOrEqual(1);

    const closed = (await storage.loadTimesheet(past)).entries[0];
    expect(closed.segments[0].end).toBe(endOfDayIso(past));
    expect(closed.status).toBe('completed');
    expect(closed.splitAtMidnight).toBe(true);
    expect(closed.roundedMinutes % 15).toBe(0);

    const after = nextDate(past);
    const dayAfter = await storage.loadTimesheet(after);
    const cont = dayAfter.entries.find(e => e.continuedFrom === 'night');
    expect(cont).toBeDefined();
    expect(cont!.activityId).toBe('a9');
    expect(cont!.description).toBe('Nuit');
    expect(cont!.segments[0].start).toBe(startOfDayIso(after));
  });

  it('rollover chains across several days and stops at today', async () => {
    const start = dateStr(new Date(Date.now() - 3 * 86400000));
    await storage.saveTimesheet({
      date: start,
      entries: [runningEntry({ id: 'forgotten', segments: [{ start: startOfDayIso(start), end: null }] })],
      activeEntries: ['forgotten'],
      pausedEntries: [],
    });

    await request(app).post('/api/system/rollover').send({});

    // Every past day is closed, only today still runs
    const today = dateStr();
    for (const date of await storage.listDates()) {
      const day = await storage.loadTimesheet(date);
      const stillOpen = day.entries.some(e => e.segments.some(s => s.end === null));
      expect(stillOpen).toBe(date === today);
    }
    const todayDay = await storage.loadTimesheet(today);
    expect(todayDay.entries.some(e => e.splitAtMidnight)).toBe(true);
  });

  it('rollover leaves today and paused entries untouched', async () => {
    const date = await seedToday([
      runningEntry({ id: 'today' }),
      runningEntry({ id: 'paused', status: 'paused', segments: [{ start: isoAgo(30), end: isoAgo(10) }] }),
    ]);

    const res = await request(app).post('/api/system/rollover').send({});
    expect(res.body.splits).toHaveLength(0);

    const day = await storage.loadTimesheet(date);
    expect(day.entries.find(e => e.id === 'today')!.segments[0].end).toBeNull();
    expect(day.entries.find(e => e.id === 'paused')!.status).toBe('paused');
  });
});
