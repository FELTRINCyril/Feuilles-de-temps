import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import type { Storage } from '../storage.js';

export function createCustomersRouter(storage: Storage) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const data = await storage.loadCustomers();
    res.json(data);
  });

  router.post('/', async (req, res) => {
    const { name, type } = req.body;
    const data = await storage.loadCustomers();
    const customer = { id: uuid(), name, type: type || 'externe' };
    data.customers.push(customer);
    await storage.saveCustomers(data);
    res.status(201).json(customer);
  });

  router.patch('/:id', async (req, res) => {
    const data = await storage.loadCustomers();
    const customer = data.customers.find((c) => c.id === req.params.id);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    if (typeof req.body.name === 'string') customer.name = req.body.name;
    if (req.body.type === 'interne' || req.body.type === 'externe') customer.type = req.body.type;
    if (req.body.archived !== undefined) {
      if (req.body.archived) customer.archived = true;
      else delete customer.archived;
    }
    await storage.saveCustomers(data);
    res.json(customer);
  });

  // Same rule as activities: a customer referenced by past entries is archived,
  // never removed, so history keeps its labels. Its activities follow.
  router.delete('/:id', async (req, res) => {
    const custData = await storage.loadCustomers();
    const customer = custData.customers.find((c) => c.id === req.params.id);
    if (!customer) return res.status(204).end();

    const actData = await storage.loadActivities();
    const own = actData.activities.filter((a) => a.customerId === req.params.id);
    // One pass over the history instead of one per activity, and it also catches
    // entries that name this client directly, with no activity at all.
    const used = await storage.collectUsedIds();
    const inUse = used.customerIds.has(req.params.id)
      || own.some((a) => used.activityIds.has(a.id));

    if (inUse) {
      customer.archived = true;
      for (const a of own) a.archived = true;
      await storage.saveActivities(actData);
      await storage.saveCustomers(custData);
      return res.json({ archived: true });
    }

    actData.activities = actData.activities.filter((a) => a.customerId !== req.params.id);
    custData.customers = custData.customers.filter((c) => c.id !== req.params.id);
    await storage.saveActivities(actData);
    await storage.saveCustomers(custData);
    res.json({ archived: false });
  });

  return router;
}
