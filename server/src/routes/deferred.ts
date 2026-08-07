import { Router } from 'express';
import type { Storage } from '../storage.js';

export function createDeferredRouter(storage: Storage) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const dates = await storage.listDates();
    const results: { date: string; entry: any }[] = [];

    for (const date of dates) {
      const day = await storage.loadTimesheet(date);
      for (const entry of day.entries) {
        if (entry.deferred && !entry.deleted) {
          results.push({ date, entry });
        }
      }
    }

    res.json(results);
  });

  return router;
}
