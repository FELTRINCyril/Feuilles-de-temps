import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { Storage } from '../storage.js';

export function createActivitiesRouter(storage: Storage) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const data = await storage.loadActivities();
    res.json(data);
  });

  router.post('/', async (req, res) => {
    const { name, customerId } = req.body;
    const data = await storage.loadActivities();
    const activity = { id: uuid(), name, customerId: customerId || '' };
    data.activities.push(activity);
    await storage.saveActivities(data);
    res.status(201).json(activity);
  });

  router.patch('/:id', async (req, res) => {
    const data = await storage.loadActivities();
    const activity = data.activities.find((a) => a.id === req.params.id);
    if (!activity) return res.status(404).json({ error: 'Not found' });
    // Only known fields, so a stray payload can't pollute the file.
    if (typeof req.body.name === 'string') activity.name = req.body.name;
    if (typeof req.body.customerId === 'string') activity.customerId = req.body.customerId;
    if (req.body.archived !== undefined) {
      if (req.body.archived) activity.archived = true;
      else delete activity.archived;
    }
    await storage.saveActivities(data);
    res.json(activity);
  });

  // Deleting an activity that past entries point to would leave them unlabelled
  // for good, so a used activity is archived instead: hidden from the pickers,
  // still resolving its name in history, exports and stats.
  router.delete('/:id', async (req, res) => {
    const data = await storage.loadActivities();
    const activity = data.activities.find((a) => a.id === req.params.id);
    if (!activity) return res.status(204).end();

    if (await storage.isActivityUsed(req.params.id)) {
      activity.archived = true;
      await storage.saveActivities(data);
      return res.json({ archived: true, activity });
    }

    data.activities = data.activities.filter((a) => a.id !== req.params.id);
    await storage.saveActivities(data);
    res.json({ archived: false });
  });

  return router;
}
