import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { createApp } from '../app.js';

const TEST_DATA_DIR = path.join(import.meta.dirname, '../../data-test-activities');

describe('Activities API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
    app = createApp(TEST_DATA_DIR);
  });

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('GET /api/activities returns empty list initially', async () => {
    const res = await request(app).get('/api/activities');
    expect(res.status).toBe(200);
    expect(res.body.activities).toEqual([]);
  });

  it('POST /api/activities creates an activity', async () => {
    const res = await request(app)
      .post('/api/activities')
      .send({ name: 'Client ABC', customerId: 'c1' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Client ABC');
    expect(res.body.id).toBeDefined();
  });

  it('PATCH /api/activities/:id updates an activity', async () => {
    const create = await request(app)
      .post('/api/activities')
      .send({ name: 'Old', customerId: '' });
    const res = await request(app)
      .patch(`/api/activities/${create.body.id}`)
      .send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
  });

  it('DELETE /api/activities/:id removes an unused activity', async () => {
    const create = await request(app)
      .post('/api/activities')
      .send({ name: 'ToDelete', customerId: '' });
    const res = await request(app).delete(`/api/activities/${create.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(false);
    const list = await request(app).get('/api/activities');
    expect(list.body.activities).toHaveLength(0);
  });

  it('DELETE archives an activity that entries point to, instead of erasing it', async () => {
    const create = await request(app)
      .post('/api/activities')
      .send({ name: 'Used', customerId: 'c1' });
    await request(app)
      .post('/api/timesheet/2026-02-20/entries')
      .send({ activityId: create.body.id, description: 'W' });

    const res = await request(app).delete(`/api/activities/${create.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);

    // Still there, so past entries keep their label
    const list = await request(app).get('/api/activities');
    expect(list.body.activities).toHaveLength(1);
    expect(list.body.activities[0].archived).toBe(true);
  });

  it('PATCH archived:false un-archives', async () => {
    const create = await request(app)
      .post('/api/activities')
      .send({ name: 'Used', customerId: 'c1' });
    await request(app)
      .post('/api/timesheet/2026-02-20/entries')
      .send({ activityId: create.body.id, description: 'W' });
    await request(app).delete(`/api/activities/${create.body.id}`);

    const res = await request(app)
      .patch(`/api/activities/${create.body.id}`)
      .send({ archived: false });
    expect(res.body.archived).toBeUndefined();
  });

  it('PATCH ignores unknown fields', async () => {
    const create = await request(app)
      .post('/api/activities')
      .send({ name: 'A', customerId: '' });
    const res = await request(app)
      .patch(`/api/activities/${create.body.id}`)
      .send({ name: 'B', injected: 'nope' });
    expect(res.body.name).toBe('B');
    expect(res.body.injected).toBeUndefined();
  });
});
