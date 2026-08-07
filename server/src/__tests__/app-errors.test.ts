import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { createApp } from '../app.js';

const TEST_DATA_DIR = path.join(import.meta.dirname, '../../data-test-app-errors');

describe('App error handling', () => {
  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('unknown route returns a 404 JSON error instead of hanging', async () => {
    const app = createApp(TEST_DATA_DIR);
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  it('malformed JSON body returns 400 with a readable message', async () => {
    const app = createApp(TEST_DATA_DIR);
    const res = await request(app)
      .post('/api/activities')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Requête invalide');
    expect(res.body.message).toBeDefined();
  });

  it('an unexpected server error is logged and returns a generic 500, never a stack trace', async () => {
    // dataDir is a file, not a directory: any write path (ensureDir -> mkdir)
    // throws ENOTDIR, producing a real unhandled rejection from a route.
    await fs.mkdir(path.dirname(TEST_DATA_DIR), { recursive: true });
    await fs.writeFile(TEST_DATA_DIR, 'not a directory');
    const app = createApp(TEST_DATA_DIR);

    const res = await request(app)
      .post('/api/activities')
      .send({ name: 'X', customerId: '' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Erreur serveur');
    expect(res.body.message).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/ENOTDIR|at Object|node_modules/);
  });
});
