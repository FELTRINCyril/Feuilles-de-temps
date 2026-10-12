import type { TimesheetDay, TimesheetEntry, ActivitiesData, CustomersData, Customer, Activity } from './types';

// Relative path works in every mode: Vite dev proxies /api to :3001,
// and the packaged Electron app serves the frontend from :3001 itself.
export const BASE = '/api';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// Timesheet
export const getTimesheet = (date: string) =>
  json<TimesheetDay>(`/timesheet/${date}`);

export const createEntry = (date: string, body: { customerId?: string; activityId: string; description: string }) =>
  json<TimesheetDay>(`/timesheet/${date}/entries`, { method: 'POST', body: JSON.stringify(body) });

export const updateEntry = (date: string, id: string, body: Record<string, unknown>) =>
  json<TimesheetDay>(`/timesheet/${date}/entries/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

export const deleteEntry = (date: string, id: string) =>
  json<TimesheetDay>(`/timesheet/${date}/entries/${id}`, { method: 'DELETE' });

export const pauseEntry = (date: string, id: string) =>
  json<TimesheetDay>(`/timesheet/${date}/entries/${id}/pause`, { method: 'POST' });

export const resumeEntry = (date: string, id: string) =>
  json<TimesheetDay>(`/timesheet/${date}/entries/${id}/resume`, { method: 'POST' });

export const reopenEntry = (date: string, id: string) =>
  json<TimesheetDay>(`/timesheet/${date}/entries/${id}/reopen`, { method: 'POST' });

export const restoreEntry = (date: string, id: string) =>
  json<TimesheetDay>(`/timesheet/${date}/entries/${id}/restore`, { method: 'POST' });

/** Actually removes an entry. Only works once it's already soft-deleted. */
export const purgeEntry = (date: string, id: string) =>
  json<TimesheetDay>(`/timesheet/${date}/entries/${id}/purge`, { method: 'DELETE' });

// Customers
export const getCustomers = () =>
  json<CustomersData>('/customers');

export const createCustomer = (body: { name: string; type: string }) =>
  json<Customer>('/customers', { method: 'POST', body: JSON.stringify(body) });

export const updateCustomer = (id: string, body: Record<string, unknown>) =>
  json<Customer>(`/customers/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

/** Resolves to { archived: true } when history forced an archive instead. */
export const deleteCustomer = (id: string) =>
  json<{ archived: boolean }>(`/customers/${id}`, { method: 'DELETE' });

// Activities
export const getActivities = () =>
  json<ActivitiesData>('/activities');

export const createActivity = (body: { name: string; customerId: string }) =>
  json<Activity>('/activities', { method: 'POST', body: JSON.stringify(body) });

export const updateActivity = (id: string, body: Record<string, unknown>) =>
  json<Activity>(`/activities/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

/** Resolves to { archived: true } when the activity is used by past entries. */
export const deleteActivity = (id: string) =>
  json<{ archived: boolean }>(`/activities/${id}`, { method: 'DELETE' });

// Export
export const getExportUrl = (date: string) =>
  `${BASE}/export/${date}?format=csv`;

export const getExportRangeUrl = (from: string, to: string) =>
  `${BASE}/export?from=${from}&to=${to}&format=csv`;

// Stats
export interface StatsData {
  period: { from: string; to: string };
  totalMinutes: number;
  totalRoundedMinutes: number;
  entryCount: number;
  byDay: { date: string; minutes: number }[];
  byCustomer: { id: string; name: string; type: string; minutes: number }[];
  byActivity: { id: string; name: string; customerName: string; minutes: number }[];
  byType: { type: string; minutes: number }[];
}

export const getStats = (from: string, to: string) =>
  json<StatsData>(`/stats?from=${from}&to=${to}`);

// Merge. Durations are recomputed server-side from the stored entries;
// useIndicated lists the entries whose rounded ("indiqué") value should be used.
export const mergeEntries = (date: string, body: {
  entryIds: string[];
  customerId: string;
  activityId: string;
  description: string;
  useIndicated: string[];
}) =>
  json<TimesheetDay>(`/timesheet/${date}/entries/merge`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

// Deferred
export const getDeferred = () =>
  json<{ date: string; entry: TimesheetEntry }[]>('/deferred');
