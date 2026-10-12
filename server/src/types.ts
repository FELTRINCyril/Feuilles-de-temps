export type CustomerType = 'interne' | 'externe';

export interface Activity {
  id: string;
  name: string;
  customerId: string;
  /** Archived activities stay in the file so past entries keep their label,
   * but are hidden from the pickers. Set instead of deleting when used. */
  archived?: boolean;
}

export interface ActivitiesData {
  activities: Activity[];
}

export interface Customer {
  id: string;
  name: string;
  type: CustomerType;
  /** Same as Activity.archived: kept for history, hidden from the pickers. */
  archived?: boolean;
}

export interface CustomersData {
  customers: Customer[];
}

export interface Segment {
  start: string; // ISO timestamp or HH:mm (legacy)
  end: string | null; // null = timer running
}

export type EntryStatus = 'active' | 'paused' | 'completed';

export interface TimesheetEntry {
  id: string;
  /** The entry's client. Stored on the entry itself rather than derived from
   * the activity, so an entry can carry a client with no activity yet, and so
   * re-pointing an activity at another client never rewrites past history.
   * Absent on entries written before this field existed: read it through
   * resolveCustomerId(), which falls back to the activity's client. */
  customerId?: string;
  activityId: string;
  description: string;
  segments: Segment[];
  totalMinutes: number;
  roundedMinutes: number;
  status: EntryStatus;
  deferred?: boolean;
  /** Soft delete: the entry stays in the file (nothing is ever erased) but is
   * hidden from the UI, the exports and the stats. Restorable. */
  deleted?: boolean;
  /** Set when the entry was paused by the system (Mac asleep, session locked)
   * rather than by the user, so the UI can explain it and a short absence can
   * be resumed automatically. */
  autoPausedAt?: string;
  autoPauseReason?: 'suspend' | 'lock' | 'quit';
  /** Set when a segment left open by a crash/quit was closed at the last time
   * the app was known to be alive, instead of counting the whole downtime. */
  recoveredAt?: string;
  /** Set on the entry that was closed at 23:59:59 when a timer crossed
   * midnight, and on the continuation entry created on the next day. */
  splitAtMidnight?: boolean;
  continuedFrom?: string;
}

/**
 * The client an entry belongs to. Entries written before `customerId` existed
 * only recorded the activity, so their client is still derived from it; every
 * read path (UI, CSV, stats) must go through here rather than looking the
 * activity up itself.
 */
export function resolveCustomerId(
  entry: Pick<TimesheetEntry, 'customerId' | 'activityId'>,
  activities: Pick<Activity, 'id' | 'customerId'>[],
): string {
  if (typeof entry.customerId === 'string') return entry.customerId;
  return activities.find((a) => a.id === entry.activityId)?.customerId ?? '';
}

export interface TimesheetDay {
  date: string; // YYYY-MM-DD
  entries: TimesheetEntry[];
  activeEntries: string[];
  pausedEntries: string[];
}
