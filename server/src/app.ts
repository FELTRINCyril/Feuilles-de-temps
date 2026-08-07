import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { Storage } from './storage.js';
import { createCustomersRouter } from './routes/customers.js';
import { createActivitiesRouter } from './routes/activities.js';
import { createTimesheetRouter } from './routes/timesheet.js';
import { createExportRouter } from './routes/export.js';
import { createStatsRouter } from './routes/stats.js';
import { createDeferredRouter } from './routes/deferred.js';
import { createSystemRouter } from './routes/system.js';

export function createApp(dataDir: string, opts?: { staticDir?: string }) {
  const app = express();
  const storage = new Storage(dataDir);

  app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:3001'] }));
  app.use(express.json());

  // Validate date parameters to prevent path traversal
  app.param('date', (req, res, next, value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/customers', createCustomersRouter(storage));
  app.use('/api/activities', createActivitiesRouter(storage));
  app.use('/api/timesheet', createTimesheetRouter(storage));
  app.use('/api/export', createExportRouter(storage));
  app.use('/api/stats', createStatsRouter(storage));
  app.use('/api/deferred', createDeferredRouter(storage));
  app.use('/api/system', createSystemRouter(storage));

  // Serve frontend static files if --static-dir is provided
  if (opts?.staticDir) {
    app.use(express.static(opts.staticDir));
    // SPA fallback: serve index.html for non-API routes
    app.use((_req, res, next) => {
      if (_req.path.startsWith('/api')) return next();
      res.sendFile(path.join(opts.staticDir!, 'index.html'));
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Express 5 forwards a rejected async handler here automatically, so every
  // route above is covered without an explicit try/catch or wrapper. Without
  // this, an unhandled error left the client waiting forever (a bare
  // connection reset) instead of a JSON error it can show the user.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ->`, err);
    if (res.headersSent) return;
    // A malformed JSON body throws a SyntaxError from express.json() before any
    // route runs; everything else is an unexpected server bug.
    // The message is only echoed back for a bad request (e.g. malformed JSON):
    // useful and harmless. A 500 is an actual server bug — its detail goes to
    // the console log above, never to the client.
    if (err instanceof SyntaxError) {
      return res.status(400).json({ error: 'Requête invalide', message });
    }
    res.status(500).json({ error: 'Erreur serveur' });
  });

  return app;
}
