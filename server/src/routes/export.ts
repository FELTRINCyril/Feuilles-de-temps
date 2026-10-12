import { Router } from 'express';
import type { Response } from 'express';
import type { Storage } from '../storage.js';
import type { TimesheetEntry } from '../types.js';
import { resolveCustomerId } from '../types.js';
import { toHHmm } from '../time-utils.js';

export function createExportRouter(storage: Storage) {
  const router = Router();

  router.get('/:date', async (req, res) => {
    const activities = await storage.loadActivities();
    const customers = await storage.loadCustomers();
    const day = await storage.loadTimesheet(req.params.date);
    const rows = exportable(day.entries).map((e) =>
      entryToCsvRow(e, activities.activities, customers.customers, day.date),
    );
    sendCsv(res, `timesheet-${req.params.date}.csv`, rows);
  });

  router.get('/', async (req, res) => {
    const { from, to } = req.query as { from: string; to: string };
    const activities = await storage.loadActivities();
    const customers = await storage.loadCustomers();
    const allRows: string[] = [];

    // Only the days that actually exist, instead of walking the calendar.
    const dates = (await storage.listDates()).filter((d) => d >= from && d <= to);
    for (const dateStr of dates) {
      const day = await storage.loadTimesheet(dateStr);
      allRows.push(
        ...exportable(day.entries).map((e) =>
          entryToCsvRow(e, activities.activities, customers.customers, dateStr),
        ),
      );
    }

    sendCsv(res, `timesheet-${from}-to-${to}.csv`, allRows);
  });

  return router;
}

const SEP = ';';

const CSV_COLUMNS = [
  'Date', 'Client', 'Type', 'Activité', 'Description', 'Heure début', 'Heure fin',
  'Durée réelle (min)', 'Durée arrondie (min)', 'Segments', 'Interruptions', 'À reporter',
];

interface ActivityRow { id: string; name: string; customerId: string }
interface CustomerRow { id: string; name: string; type: string }

/** Deleted entries are hidden, and a running or paused timer has no final duration. */
function exportable(entries: TimesheetEntry[]): TimesheetEntry[] {
  return entries.filter((e) => !e.deleted && e.status === 'completed');
}

function sendCsv(res: Response, filename: string, rows: string[]): void {
  const csv = [CSV_COLUMNS.join(SEP), ...rows].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  // UTF-8 BOM: without it Excel (fr) mangles the accents. CRLF + ';' so it also
  // splits the columns without an import wizard.
  res.send('﻿' + csv + '\r\n');
}

function entryToCsvRow(
  entry: TimesheetEntry,
  activities: ActivityRow[],
  customers: CustomerRow[],
  date: string,
): string {
  const activity = activities.find((a) => a.id === entry.activityId);
  const customer = customers.find((c) => c.id === resolveCustomerId(entry, activities));
  const closed = entry.segments.filter((s) => s.end);
  const firstStart = entry.segments[0]?.start ? toHHmm(entry.segments[0].start) : '';
  const lastEnd = closed.length > 0 ? toHHmm(closed[closed.length - 1].end!) : '';
  const interruptions = Math.max(0, entry.segments.length - 1);

  return [
    date,
    csvEscape(customer?.name ?? ''),
    customer?.type ?? '',
    csvEscape(activity?.name ?? (entry.activityId ? '(activité supprimée)' : '')),
    csvEscape(entry.description),
    firstStart,
    lastEnd,
    entry.totalMinutes,
    entry.roundedMinutes,
    entry.segments.length,
    interruptions,
    entry.deferred ? 'oui' : '',
  ].join(SEP);
}

function csvEscape(value: string): string {
  // A leading =, +, - or @ makes Excel treat the cell as a formula.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (safe.includes(SEP) || safe.includes('"') || /[\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
