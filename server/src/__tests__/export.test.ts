import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { createApp } from '../app.js';
import { Storage } from '../storage.js';

const TEST_DATA_DIR = path.join(import.meta.dirname, '../../data-test-export');

describe('Export API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
    app = createApp(TEST_DATA_DIR);

    const storage = new Storage(TEST_DATA_DIR);
    await storage.saveActivities({
      activities: [
        { id: 'p1', name: 'Client ABC', customerId: '' },
      ],
    });
    await storage.saveTimesheet({
      date: '2026-02-20',
      entries: [
        {
          id: 'e1',
          activityId: 'p1',
          description: 'Worked on migration',
          segments: [
            { start: '2026-02-20T08:00:00.000Z', end: '2026-02-20T10:15:00.000Z' },
            { start: '2026-02-20T11:00:00.000Z', end: '2026-02-20T12:00:00.000Z' },
          ],
          totalMinutes: 195,
          roundedMinutes: 195,
          status: 'completed',
        },
      ],
      activeEntries: [],
      pausedEntries: [],
    });
  });

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('GET /api/export/:date returns CSV', async () => {
    const res = await request(app)
      .get('/api/export/2026-02-20')
      .query({ format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(2); // header + 1 entry
    expect(lines[0]).toContain('Date');
    expect(lines[1]).toContain('Client ABC');
  });

  it('CSV opens straight in Excel FR: BOM, semicolons, CRLF', async () => {
    const res = await request(app).get('/api/export/2026-02-20');
    expect(res.text.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
    expect(res.text).toContain('\r\n');
    const header = res.text.replace('﻿', '').split('\r\n')[0];
    expect(header.split(';')).toContain('Activité');
    expect(header.split(';')).toContain('À reporter');
  });

  it('CSV skips deleted and unfinished entries', async () => {
    const storage = new Storage(TEST_DATA_DIR);
    await storage.withTimesheet('2026-02-20', (day) => {
      day.entries.push({
        id: 'e2', activityId: 'p1', description: 'Supprimée',
        segments: [{ start: '2026-02-20T13:00:00.000Z', end: '2026-02-20T14:00:00.000Z' }],
        totalMinutes: 60, roundedMinutes: 60, status: 'completed', deleted: true,
      });
      day.entries.push({
        id: 'e3', activityId: 'p1', description: 'En cours',
        segments: [{ start: '2026-02-20T15:00:00.000Z', end: null }],
        totalMinutes: 0, roundedMinutes: 0, status: 'active',
      });
    });

    const res = await request(app).get('/api/export/2026-02-20');
    expect(res.text).not.toContain('Supprimée');
    expect(res.text).not.toContain('En cours');
    expect(res.text).toContain('Worked on migration');
  });

  it('CSV quotes the separator and defuses formulas', async () => {
    const storage = new Storage(TEST_DATA_DIR);
    await storage.withTimesheet('2026-02-21', (day) => {
      day.entries.push({
        id: 'e4', activityId: 'p1', description: 'Analyse ; devis =SUM(A1)',
        segments: [{ start: '2026-02-21T08:00:00.000Z', end: '2026-02-21T09:00:00.000Z' }],
        totalMinutes: 60, roundedMinutes: 60, status: 'completed',
      });
      day.entries.push({
        id: 'e5', activityId: 'p1', description: '=cmd|calc',
        segments: [{ start: '2026-02-21T10:00:00.000Z', end: '2026-02-21T11:00:00.000Z' }],
        totalMinutes: 60, roundedMinutes: 60, status: 'completed',
      });
    });

    const res = await request(app).get('/api/export/2026-02-21');
    expect(res.text).toContain('"Analyse ; devis =SUM(A1)"');
    expect(res.text).toContain("'=cmd|calc");
  });

  it('range export only reads the days that exist', async () => {
    const res = await request(app)
      .get('/api/export')
      .query({ from: '2020-01-01', to: '2026-12-31' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Worked on migration');
  });
});
