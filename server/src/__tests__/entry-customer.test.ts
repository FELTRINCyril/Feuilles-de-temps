import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { createApp } from '../app.js';

const TEST_DATA_DIR = path.join(import.meta.dirname, '../../data-test-entry-customer');
const DATE = '2026-02-21';

/**
 * An entry stores its own client. Before that it only stored the activity and
 * the client was derived from it, so choosing a client without an activity
 * saved nothing at all, and re-pointing an activity at another client silently
 * rewrote the client of every past entry using it.
 */
describe('Entry client', () => {
  let app: ReturnType<typeof createApp>;
  let customerA: string;
  let customerB: string;
  let activityA: string;
  let activityB: string;

  async function createEntry(body: Record<string, unknown>) {
    const res = await request(app).post(`/api/timesheet/${DATE}/entries`).send(body);
    return res.body.entries[res.body.entries.length - 1];
  }

  async function readEntry(id: string) {
    const res = await request(app).get(`/api/timesheet/${DATE}`);
    return res.body.entries.find((e: any) => e.id === id);
  }

  beforeEach(async () => {
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
    app = createApp(TEST_DATA_DIR);

    customerA = (await request(app).post('/api/customers').send({ name: 'A', type: 'interne' })).body.id;
    customerB = (await request(app).post('/api/customers').send({ name: 'B', type: 'externe' })).body.id;
    activityA = (await request(app).post('/api/activities').send({ name: 'Dev', customerId: customerA })).body.id;
    activityB = (await request(app).post('/api/activities').send({ name: 'Dev', customerId: customerB })).body.id;
  });

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('keeps a client chosen without any activity', async () => {
    const entry = await createEntry({ customerId: customerA, activityId: '' });
    expect(await readEntry(entry.id)).toMatchObject({ customerId: customerA, activityId: '' });
  });

  it('keeps the client when the activity is cleared afterwards', async () => {
    const entry = await createEntry({ customerId: customerA, activityId: activityA });
    await request(app)
      .patch(`/api/timesheet/${DATE}/entries/${entry.id}`)
      .send({ customerId: customerA, activityId: '' });
    expect(await readEntry(entry.id)).toMatchObject({ customerId: customerA, activityId: '' });
  });

  it('pins the client to the activity when only an activity is sent', async () => {
    const entry = await createEntry({ activityId: activityB, description: '' });
    expect(entry.customerId).toBe(customerB);
  });

  it('drops an activity that belongs to another client', async () => {
    const entry = await createEntry({ customerId: customerA, activityId: activityA });
    await request(app)
      .patch(`/api/timesheet/${DATE}/entries/${entry.id}`)
      .send({ customerId: customerB });
    expect(await readEntry(entry.id)).toMatchObject({ customerId: customerB, activityId: '' });
  });

  it('does not rewrite past entries when an activity changes client', async () => {
    const entry = await createEntry({ customerId: customerA, activityId: activityA });
    await request(app).patch(`/api/activities/${activityA}`).send({ customerId: customerB });
    expect((await readEntry(entry.id)).customerId).toBe(customerA);
  });

  it('exports the client of an entry that has no activity', async () => {
    const entry = await createEntry({ customerId: customerA, activityId: '' });
    await request(app).patch(`/api/timesheet/${DATE}/entries/${entry.id}`).send({ status: 'completed' });

    const csv = (await request(app).get(`/api/export/${DATE}`)).text;
    const row = csv.split('\r\n').find((l) => l.startsWith(DATE))!;
    expect(row.split(';')[1]).toBe('A');
    expect(row.split(';')[2]).toBe('interne');
  });

  it('archives a client still used by an entry that has no activity', async () => {
    await createEntry({ customerId: customerA, activityId: '' });
    const res = await request(app).delete(`/api/customers/${customerA}`);
    expect(res.body.archived).toBe(true);
  });

  it('counts unlabelled time in the stats breakdowns', async () => {
    const entry = await createEntry({ activityId: '', description: 'rien' });
    await request(app).patch(`/api/timesheet/${DATE}/entries/${entry.id}`).send({ status: 'completed' });

    const stats = (await request(app).get(`/api/stats?from=${DATE}&to=${DATE}`)).body;
    const sum = (rows: { minutes: number }[]) => rows.reduce((s, r) => s + r.minutes, 0);
    expect(sum(stats.byCustomer)).toBe(stats.totalRoundedMinutes);
    expect(sum(stats.byActivity)).toBe(stats.totalRoundedMinutes);
    expect(sum(stats.byType)).toBe(stats.totalRoundedMinutes);
  });

  it('reads the client of a legacy entry from its activity', async () => {
    // A day file as written before customerId existed.
    await fs.writeFile(
      path.join(TEST_DATA_DIR, `${DATE}.json`),
      JSON.stringify({
        date: DATE,
        entries: [{
          id: 'legacy', activityId: activityA, description: '',
          segments: [{ start: `${DATE}T09:00:00.000Z`, end: `${DATE}T10:00:00.000Z` }],
          totalMinutes: 60, roundedMinutes: 60, status: 'completed',
        }],
        activeEntries: [], pausedEntries: [],
      }),
    );

    const csv = (await request(app).get(`/api/export/${DATE}`)).text;
    expect(csv.split('\r\n').find((l) => l.startsWith(DATE))!.split(';')[1]).toBe('A');
  });
});
