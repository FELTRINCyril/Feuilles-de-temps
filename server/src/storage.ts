import fs from 'fs/promises';
import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { CustomersData, ActivitiesData, TimesheetDay } from './types.js';

export class Storage {
  private writeLocks = new Map<string, Promise<void>>();

  constructor(private dataDir: string) {}

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  /**
   * Run fn with exclusive access to filePath: concurrent callers queue behind
   * each other instead of interleaving. This is what makes read-modify-write
   * safe (see withTimesheet) — without it two requests can both read the same
   * state and the second one silently overwrites the first one's changes.
   */
  private async runExclusive<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLocks.get(filePath) ?? Promise.resolve();
    // Run fn whether the previous op succeeded or failed, but never before it.
    const op = prev.then(fn, fn);
    this.writeLocks.set(filePath, op.then(() => {}, () => {}));
    return op;
  }

  private async atomicWrite(filePath: string, data: string): Promise<void> {
    await this.runExclusive(filePath, () => this.doAtomicWrite(filePath, data));
  }

  private async doAtomicWrite(filePath: string, data: string): Promise<void> {
    const tmp = filePath + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      // Sync write + fsync to ensure data hits disk before rename
      const fd = openSync(tmp, 'w');
      writeSync(fd, data);
      fsyncSync(fd);
      closeSync(fd);
      renameSync(tmp, filePath);
    } catch (err) {
      try { unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  async loadActivities(): Promise<ActivitiesData> {
    const filePath = path.join(this.dataDir, 'activities.json');
    let raw: string | null = null;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (raw !== null) {
      const data = JSON.parse(raw) as ActivitiesData;
      for (const a of data.activities) {
        if (!('customerId' in a)) (a as any).customerId = '';
        delete (a as any).category;
        delete (a as any).tasks;
      }
      return data;
    }
    // Migration: try loading from legacy projects.json
    try {
      const legacyRaw = await fs.readFile(
        path.join(this.dataDir, 'projects.json'),
        'utf-8',
      );
      const legacy = JSON.parse(legacyRaw);
      const activities = (legacy.projects || []).map((p: any) => {
        if (!('customerId' in p)) p.customerId = '';
        delete p.category;
        delete p.tasks;
        return p;
      });
      const data: ActivitiesData = { activities };
      await this.saveActivities(data);
      return data;
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
      return { activities: [] };
    }
  }

  async saveActivities(data: ActivitiesData): Promise<void> {
    await this.ensureDir();
    await this.atomicWrite(
      path.join(this.dataDir, 'activities.json'),
      JSON.stringify(data, null, 2),
    );
  }

  async loadCustomers(): Promise<CustomersData> {
    const filePath = path.join(this.dataDir, 'customers.json');
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') return { customers: [] };
      throw err;
    }
    const data = JSON.parse(raw) as CustomersData;
    for (const c of data.customers) {
      if (!c.type) c.type = 'externe';
    }
    return data;
  }

  async saveCustomers(data: CustomersData): Promise<void> {
    await this.ensureDir();
    await this.atomicWrite(
      path.join(this.dataDir, 'customers.json'),
      JSON.stringify(data, null, 2),
    );
  }

  async loadTimesheet(date: string): Promise<TimesheetDay> {
    const filePath = path.join(this.dataDir, `${date}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { date, entries: [], activeEntries: [], pausedEntries: [] };
      }
      throw err;
    }
    const data = JSON.parse(raw) as TimesheetDay;
    // Migration: activeEntry → activeEntries
    const rawData = data as any;
    if ('activeEntry' in rawData) {
      data.activeEntries = rawData.activeEntry ? [rawData.activeEntry] : [];
      delete rawData.activeEntry;
    }
    if (!data.activeEntries) {
      data.activeEntries = [];
    }
    // Migrate: rename projectId → activityId in existing entries
    for (const entry of data.entries) {
      if ('projectId' in entry && !('activityId' in entry)) {
        (entry as any).activityId = (entry as any).projectId;
        delete (entry as any).projectId;
      }
    }
    return data;
  }

  async listDates(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.dataDir);
      return files
        .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .map(f => f.replace('.json', ''))
        .sort();
    } catch {
      return [];
    }
  }

  async saveTimesheet(data: TimesheetDay): Promise<void> {
    await this.ensureDir();
    await this.atomicWrite(
      path.join(this.dataDir, `${data.date}.json`),
      JSON.stringify(data, null, 2),
    );
  }

  /**
   * Read-modify-write a day file under an exclusive lock: the only safe way to
   * mutate a timesheet. Every route must go through this rather than
   * loadTimesheet + saveTimesheet, which can lose concurrent updates.
   *
   * Return false from fn to skip the write (e.g. entry not found).
   */
  async withTimesheet(
    date: string,
    fn: (data: TimesheetDay) => boolean | void | Promise<boolean | void>,
  ): Promise<TimesheetDay> {
    await this.ensureDir();
    const filePath = path.join(this.dataDir, `${date}.json`);
    return this.runExclusive(filePath, async () => {
      const data = await this.loadTimesheet(date);
      const result = await fn(data);
      if (result !== false) {
        await this.doAtomicWrite(filePath, JSON.stringify(data, null, 2));
      }
      return data;
    });
  }

  /**
   * Whether any recorded entry points at this activity. Soft-deleted entries
   * count as users: they can be restored and would need their label back.
   */
  async isActivityUsed(activityId: string): Promise<boolean> {
    if (!activityId) return false;
    for (const date of await this.listDates()) {
      const day = await this.loadTimesheet(date);
      if (day.entries.some((e) => e.activityId === activityId)) return true;
    }
    return false;
  }

  /** The n most recent dates that have a day file, oldest first. */
  async recentDates(n: number): Promise<string[]> {
    const dates = await this.listDates();
    return dates.slice(-n);
  }

  /**
   * lastSeenAt is refreshed periodically while the app runs. On startup it tells
   * us when the app was last known to be alive, so a segment left open by a
   * quit/crash/battery-death can be closed there instead of counting the whole
   * downtime as worked time.
   */
  async readRuntime(): Promise<{ lastSeenAt?: string }> {
    try {
      const raw = await fs.readFile(path.join(this.dataDir, 'runtime.json'), 'utf-8');
      return JSON.parse(raw);
    } catch (err: any) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
  }

  async touchRuntime(at: string): Promise<void> {
    await this.ensureDir();
    await this.atomicWrite(
      path.join(this.dataDir, 'runtime.json'),
      JSON.stringify({ lastSeenAt: at }, null, 2),
    );
  }
}
