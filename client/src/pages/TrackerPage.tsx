import { useState, useEffect, useCallback, useRef } from 'react';
import type { TimesheetDay, TimesheetEntry, ActivitiesData, CustomersData } from '../types';
import * as api from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { ChevronLeft, ChevronRight, Play, Pause, CircleStop, Trash2, RotateCcw, CalendarDays, Clock, Merge, Pencil, Undo2, MoonStar, Scissors } from 'lucide-react';
import { onSystemSync } from '../desktop';
import { ClientActivityPicker } from '../components/ClientActivityPicker';

// The menu bar title is owned by the tray popup alone (see TrayPopupPage): it is
// always alive and always on today, whereas this page can be showing any date.

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function roundUp15(minutes: number): number {
  if (minutes === 0) return 0;
  return Math.ceil(minutes / 15) * 15;
}

function isManualDuration(entry: TimesheetEntry): boolean {
  return entry.roundedMinutes !== roundUp15(entry.totalMinutes);
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, '0')}`;
}

/**
 * `now` caps an open segment's end. Pass Date.now() when the entry's day is
 * today (the normal ticking timer); when browsing a past day, pass that day's
 * 23:59:59 instead, otherwise an entry left open on an old day (a pre-rollover
 * leftover) would show a chrono counting up from real now, hours or days off.
 */
function computeElapsedSeconds(entry: TimesheetEntry, now: number): number {
  let totalSec = 0;
  for (const seg of entry.segments) {
    const startMs = parseTimestamp(seg.start).getTime();
    if (seg.end) {
      totalSec += Math.floor((parseTimestamp(seg.end).getTime() - startMs) / 1000);
    } else {
      totalSec += Math.max(0, Math.floor((now - startMs) / 1000));
    }
  }
  return totalSec;
}

/** ms of 23:59:59.999 local time on the given YYYY-MM-DD. */
function endOfDayMs(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

function formatTimer(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function entryLabel(entry: TimesheetEntry, activities: { id: string; name: string; customerId: string }[], customersList: { id: string; name: string }[]): string {
  const activity = activities.find(a => a.id === entry.activityId);
  if (activity) return activityOptionLabel(activity, customersList);
  const startTime = entry.segments[0]?.start;
  if (startTime) {
    const d = parseTimestamp(startTime);
    return `Timer démarré à ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return 'Timer';
}

function activityOptionLabel(activity: { name: string; customerId: string }, customersList: { id: string; name: string }[]): string {
  const customer = customersList.find(c => c.id === activity.customerId);
  return customer ? `${customer.name} - ${activity.name}` : activity.name;
}

// Activity name only, for table rows where the customer has its own column
function activityNameOnly(entry: TimesheetEntry, activitiesList: { id: string; name: string }[]): string {
  return activitiesList.find(a => a.id === entry.activityId)?.name ?? '';
}

function resolveCustomerName(activityId: string, activitiesList: { id: string; customerId: string }[], customersList: { id: string; name: string }[]): string {
  const activity = activitiesList.find(a => a.id === activityId);
  if (!activity) return '';
  return customersList.find(c => c.id === activity.customerId)?.name ?? '';
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateFR(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  return `${days[date.getDay()]}. ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

function parseTimestamp(value: string): Date {
  if (value.includes('T')) return new Date(value);
  const [h, m] = value.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

function hhmm(iso: string): string {
  const d = parseTimestamp(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Why this entry stopped on its own, in plain words, or null if the user did it. */
function autoStopReason(entry: TimesheetEntry): string | null {
  if (entry.recoveredAt) {
    return `Clôturée à ${hhmm(entry.recoveredAt)} : l'app s'est arrêtée, le temps d'arrêt n'a pas été compté`;
  }
  if (!entry.autoPausedAt) return null;
  const at = hhmm(entry.autoPausedAt);
  if (entry.autoPauseReason === 'lock') return `En pause depuis ${at} : session verrouillée`;
  if (entry.autoPauseReason === 'quit') return `En pause depuis ${at} : application fermée`;
  return `En pause depuis ${at} : Mac en veille`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TrackerPage() {
  const [currentDate, setCurrentDate] = useState(() => localStorage.getItem('trackerDate') || todayStr());
  const [day, setDay] = useState<TimesheetDay | null>(null);
  const [activities, setActivities] = useState<ActivitiesData>({ activities: [] });
  const [customers, setCustomers] = useState<CustomersData>({ customers: [] });
  const [elapsedMap, setElapsedMap] = useState<Record<string, number>>({});
  const [editingEntry, setEditingEntry] = useState<TimesheetEntry | null>(null);
  const [editActivityId, setEditActivityId] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editMinutes, setEditMinutes] = useState('');

  // Daily target (minutes), user-adjustable by clicking the value under the bar
  const [targetMinutes, setTargetMinutes] = useState(() => {
    const stored = parseInt(localStorage.getItem('dailyTargetMinutes') ?? '', 10);
    return Number.isFinite(stored) && stored > 0 ? stored : 420;
  });
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState('');

  // Merge state
  const [selectedForMerge, setSelectedForMerge] = useState<Set<string>>(new Set());
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeUseIndicated, setMergeUseIndicated] = useState<Record<string, boolean>>({});
  const [mergeActivityId, setMergeActivityId] = useState('');
  const [mergeDescription, setMergeDescription] = useState('');

  // Last soft-deleted entry, so the deletion can be undone right away
  const [undoDelete, setUndoDelete] = useState<{ id: string; label: string } | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const syncChannel = useRef(new BroadcastChannel('tempo-sync'));
  useEffect(() => () => syncChannel.current.close(), []);

  const refresh = useCallback(async (notify = false) => {
    try {
      const [t, a, c] = await Promise.all([
        api.getTimesheet(currentDate),
        api.getActivities(),
        api.getCustomers(),
      ]);
      setDay(t);
      setActivities(a);
      setCustomers(c);
      setLoadError(null);
      if (notify) syncChannel.current.postMessage('refresh');
    } catch {
      // Keep whatever was last loaded on screen; only the banner tells the
      // user something is wrong, instead of "Chargement..." forever.
      setLoadError("Impossible de contacter le serveur local. Vérifiez que l'application est bien lancée.");
    }
  }, [currentDate]);

  useEffect(() => { refresh(); }, [refresh]);
  // The main process may have paused or split timers (sleep, lock, midnight)
  useEffect(() => onSystemSync(() => { refresh(); }), [refresh]);
  // Listen for cross-window sync events (from popup/navbar)
  useEffect(() => {
    syncChannel.current.onmessage = () => refresh();
  }, [refresh]);
  useEffect(() => { localStorage.setItem('trackerDate', currentDate); }, [currentDate]);
  // Listen for date changes from deferred entries menu
  useEffect(() => {
    const handler = () => {
      const stored = localStorage.getItem('trackerDate');
      if (stored && stored !== currentDate) setCurrentDate(stored);
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [currentDate]);

  // Whether archived clients/activities should be offered in the pickers,
  // set from Settings; kept in sync if changed in another window.
  const [showArchived, setShowArchived] = useState(() => localStorage.getItem('showArchived') === '1');
  useEffect(() => {
    const handler = () => setShowArchived(localStorage.getItem('showArchived') === '1');
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  function shiftDate(offset: number) {
    const [y, m, d] = currentDate.split('-').map(Number);
    const date = new Date(y, m - 1, d + offset);
    setCurrentDate(
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    );
  }

  const activeEntries: TimesheetEntry[] =
    day?.activeEntries
      ?.map(id => day.entries.find(e => e.id === id))
      .filter((e): e is TimesheetEntry => !!e) ?? [];

  const pausedEntries: TimesheetEntry[] =
    day?.pausedEntries
      .map(id => day.entries.find(e => e.id === id))
      .filter((e): e is TimesheetEntry => !!e) ?? [];

  useEffect(() => {
    if (activeEntries.length === 0) {
      setElapsedMap({});
      return;
    }
    function tick() {
      const now = currentDate === todayStr() ? Date.now() : endOfDayMs(currentDate);
      const map: Record<string, number> = {};
      for (const entry of activeEntries) {
        map[entry.id] = computeElapsedSeconds(entry, now);
      }
      setElapsedMap(map);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [activeEntries.length, activeEntries.map(e => e.id).join(','), currentDate]);

  const completedEntries: TimesheetEntry[] =
    day?.entries.filter(e => e.status === 'completed' && !e.deleted) ?? [];

  // Soft-deleted entries stay in the file: they can always be brought back.
  const deletedEntries: TimesheetEntry[] = day?.entries.filter(e => e.deleted) ?? [];

  const completedMinutes = completedEntries.reduce((s, e) => s + e.roundedMinutes, 0);
  const activeMinutes = activeEntries.reduce((sum, e) => sum + Math.round((elapsedMap[e.id] ?? 0) / 60), 0);
  // A paused entry never has an open segment, so no reference "now" is needed
  // (and none is read during render, which the lint rules here forbid).
  const pausedMinutes = pausedEntries.reduce((sum, e) => sum + Math.round(computeElapsedSeconds(e, 0) / 60), 0);
  const totalMinutes = completedMinutes + activeMinutes + pausedMinutes;
  const completedPct = Math.min(100, (completedMinutes / targetMinutes) * 100);
  const activePct = Math.min(100 - completedPct, (activeMinutes / targetMinutes) * 100);
  const pausedPct = Math.min(100 - completedPct - activePct, (pausedMinutes / targetMinutes) * 100);

  function saveTarget() {
    const hours = parseFloat(targetInput.replace(',', '.'));
    if (Number.isFinite(hours) && hours > 0 && hours <= 24) {
      const minutes = Math.round(hours * 60);
      setTargetMinutes(minutes);
      localStorage.setItem('dailyTargetMinutes', String(minutes));
    }
    setEditingTarget(false);
  }

  async function handlePause(entry: TimesheetEntry) {
    if (!day) return;
    await api.updateEntry(currentDate, entry.id, {
      description: entry.description,
      activityId: entry.activityId,
    });
    await api.pauseEntry(currentDate, entry.id);
    await refresh(true);
  }

  async function handleFinish(entry: TimesheetEntry) {
    if (!day) return;
    await api.updateEntry(currentDate, entry.id, {
      description: entry.description,
      activityId: entry.activityId,
    });
    await api.updateEntry(currentDate, entry.id, { status: 'completed' });
    await refresh(true);
  }

  async function handleResume(id: string) {
    await api.resumeEntry(currentDate, id);
    await refresh(true);
  }

  async function handleReopen(id: string) {
    await api.reopenEntry(currentDate, id);
    await refresh(true);
  }

  async function handleDuplicate(entry: TimesheetEntry) {
    await api.createEntry(currentDate, {
      activityId: entry.activityId,
      description: entry.description,
    });
    await refresh(true);
  }

  async function handleToggleDeferred(entry: TimesheetEntry) {
    await api.updateEntry(currentDate, entry.id, { deferred: !entry.deferred });
    await refresh(true);
  }

  function toggleMergeSelection(id: string) {
    setSelectedForMerge(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function openMergeDialog() {
    const entries = completedEntries.filter(e => selectedForMerge.has(e.id));
    if (entries.length < 2) return;
    // Pre-select: use "indicated" if user manually changed the duration
    const useIndicated: Record<string, boolean> = {};
    for (const e of entries) {
      useIndicated[e.id] = isManualDuration(e);
    }
    setMergeUseIndicated(useIndicated);
    setMergeActivityId(entries[0].activityId);
    setMergeDescription(entries.map(e => e.description).filter(Boolean).join(' / '));
    setMergeOpen(true);
  }

  async function handleMerge() {
    const entries = completedEntries.filter(e => selectedForMerge.has(e.id));
    if (entries.length < 2) return;

    await api.mergeEntries(currentDate, {
      entryIds: entries.map(e => e.id),
      activityId: mergeActivityId,
      description: mergeDescription,
      useIndicated: entries.filter(e => mergeUseIndicated[e.id]).map(e => e.id),
    });

    setSelectedForMerge(new Set());
    setMergeOpen(false);
    await refresh(true);
  }

  async function handleDeleteEntry(id: string) {
    const entry = day?.entries.find(e => e.id === id);
    await api.deleteEntry(currentDate, id);
    // Nothing is erased on the server, so offer to put it straight back
    setUndoDelete({
      id,
      label: entry ? entryLabel(entry, activities.activities, customers.customers) : 'Entrée',
    });
    await refresh(true);
  }

  async function handleRestoreEntry(id: string) {
    await api.restoreEntry(currentDate, id);
    setUndoDelete(prev => (prev?.id === id ? null : prev));
    await refresh(true);
  }

  async function handlePurgeEntry(entry: TimesheetEntry) {
    const label = entryLabel(entry, activities.activities, customers.customers);
    if (!confirm(`Supprimer définitivement "${label}" ? Cette action est irréversible.`)) return;
    await api.purgeEntry(currentDate, entry.id);
    setUndoDelete(prev => (prev?.id === entry.id ? null : prev));
    await refresh(true);
  }

  async function handleQuickStart() {
    await api.createEntry(currentDate, { activityId: '', description: '' });
    await refresh(true);
  }

  function openEditModal(entry: TimesheetEntry) {
    setEditingEntry(entry);
    setEditActivityId(entry.activityId);
    setEditDescription(entry.description);
    // Completed entries expose their rounded ("indiqué") duration; paused/active
    // ones expose the real elapsed time.
    setEditMinutes(String(entry.status === 'completed' ? entry.roundedMinutes : entry.totalMinutes));
  }

  async function saveEditModal() {
    if (!editingEntry) return;
    const updates: Record<string, unknown> = {};
    if (editActivityId !== editingEntry.activityId) updates.activityId = editActivityId;
    if (editDescription !== editingEntry.description) updates.description = editDescription;
    const parsedMin = parseInt(editMinutes, 10);
    if (!isNaN(parsedMin)) {
      if (editingEntry.status === 'completed') {
        if (parsedMin !== editingEntry.roundedMinutes) updates.roundedMinutes = parsedMin;
      } else if (parsedMin !== editingEntry.totalMinutes) {
        // Paused entry: rewrite the accumulated time (server rewrites segments).
        updates.totalMinutes = parsedMin;
      }
    }
    if (Object.keys(updates).length > 0) {
      await api.updateEntry(currentDate, editingEntry.id, updates);
      await refresh(true);
    }
    setEditingEntry(null);
  }

  useEffect(() => {
    if (!undoDelete) return;
    const id = setTimeout(() => setUndoDelete(null), 10000);
    return () => clearTimeout(id);
  }, [undoDelete]);

  if (!day) {
    return (
      <div className="text-center text-muted-foreground py-12">
        {loadError ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => refresh()}>Réessayer</Button>
          </div>
        ) : 'Chargement...'}
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {loadError && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => refresh()}>Réessayer</Button>
        </div>
      )}
      {/* ===== Day header: date left, daily total right ===== */}
      <div className="flex items-end justify-between gap-4">
        <div className="flex items-center gap-2">
          <h1 className="font-display text-2xl font-semibold tracking-tight tabular-nums">
            {formatDateFR(currentDate)}
          </h1>
          <div className="flex items-center gap-0.5 ml-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => shiftDate(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => shiftDate(1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          {currentDate !== todayStr() && (
            <Button variant="outline" size="sm" className="ml-1" onClick={() => setCurrentDate(todayStr())}>
              <CalendarDays className="h-3.5 w-3.5" />
              Aujourd'hui
            </Button>
          )}
        </div>
        <p className="text-sm font-mono text-muted-foreground pb-0.5">
          <span className="text-foreground font-medium">{formatDuration(totalMinutes)}</span>
          {' / '}
          {editingTarget ? (
            <input
              autoFocus
              type="number"
              min={0.5}
              max={24}
              step={0.5}
              defaultValue={targetMinutes / 60}
              onChange={(e) => setTargetInput(e.target.value)}
              onBlur={saveTarget}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTarget();
                if (e.key === 'Escape') setEditingTarget(false);
              }}
              className="w-14 h-6 px-1 text-center text-sm font-mono rounded-md border border-input bg-card focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          ) : (
            <button
              onClick={() => { setTargetInput(String(targetMinutes / 60)); setEditingTarget(true); }}
              title="Modifier l'objectif quotidien"
              className="underline decoration-dotted decoration-muted-foreground/60 underline-offset-4 hover:text-foreground transition-colors cursor-pointer"
            >
              {formatDuration(targetMinutes)}
            </button>
          )}
          {pausedMinutes > 0 && (
            <span className="text-muted-foreground/60"> · dont {formatDuration(pausedMinutes)} en pause</span>
          )}
        </p>
      </div>

      {/* ===== Progress (stacked: completed + active blue + paused greyed) ===== */}
      <div className="bg-muted relative h-1.5 w-full overflow-hidden rounded-full flex">
        <div
          className="bg-foreground h-full transition-[width] duration-700 ease-out"
          style={{ width: `${completedPct}%` }}
        />
        <div
          className="bg-tempo h-full transition-[width] duration-700 ease-out"
          style={{ width: `${activePct}%` }}
        />
        <div
          className="bg-muted-foreground/40 h-full transition-[width] duration-700 ease-out"
          style={{ width: `${pausedPct}%` }}
        />
      </div>

      {/* ===== Active Tasks ===== */}
      {activeEntries.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">En cours</h2>
          {activeEntries.map(entry => (
            <Card key={entry.id} className="py-5 gap-4 shadow-sm">
              <CardContent className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="space-y-2.5 min-w-0">
                  <div className="flex items-center gap-2 text-xs font-medium text-tempo">
                    <span className="h-2 w-2 rounded-full bg-tempo animate-tempo-pulse" aria-hidden="true" />
                    En cours
                  </div>
                  <ClientActivityPicker
                    customers={customers.customers}
                    activities={activities.activities}
                    activityId={entry.activityId}
                    showArchived={showArchived}
                    onDataChanged={refresh}
                    onChange={async (activityId) => {
                      await api.updateEntry(currentDate, entry.id, { activityId });
                      await refresh(true);
                    }}
                  />
                  <Input
                    placeholder="Description..."
                    value={entry.description}
                    onChange={async (e) => {
                      setDay(prev => {
                        if (!prev) return prev;
                        return {
                          ...prev,
                          entries: prev.entries.map(ent =>
                            ent.id === entry.id ? { ...ent, description: e.target.value } : ent
                          ),
                        };
                      });
                    }}
                    onBlur={async (e) => {
                      await api.updateEntry(currentDate, entry.id, { description: e.target.value });
                    }}
                  />
                </div>
                <div className="flex flex-col items-end gap-3 sm:pl-8">
                  <div className="font-mono text-5xl font-medium tabular-nums tracking-tight">
                    {formatTimer(elapsedMap[entry.id] ?? 0)}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => handleFinish(entry)}>
                      <CircleStop className="h-3.5 w-3.5" />
                      Terminer
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handlePause(entry)} title="Pause">
                      <Pause className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => handleDeleteEntry(entry.id)}
                      title="Supprimer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      {/* ===== Paused Tasks ===== */}
      {pausedEntries.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">En pause</h2>
          <div className="space-y-2">
            {pausedEntries.map(entry => (
              <Card key={entry.id} className="py-3 gap-0">
                <CardContent className="flex items-center justify-between gap-3">
                  <div className="min-w-0 pl-[13px]">
                    <p className="text-sm truncate">
                      <span className="font-medium">{entryLabel(entry, activities.activities, customers.customers)}</span>
                      <span className="font-mono text-xs text-muted-foreground"> · {formatDuration(entry.totalMinutes)}</span>
                    </p>
                    {entry.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{entry.description}</p>
                    )}
                    {autoStopReason(entry) && (
                      <p className="flex items-center gap-1 text-xs text-warning mt-0.5 truncate">
                        <MoonStar className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {autoStopReason(entry)}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Button variant="outline" size="sm" onClick={() => handleResume(entry.id)}>
                      <Play className="h-3.5 w-3.5" />
                      Reprendre
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEditModal(entry)}
                      title="Modifier"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => handleDeleteEntry(entry.id)}
                      title="Supprimer"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* ===== Quick Start ===== */}
      <div className="text-center">
        <Button size="lg" onClick={handleQuickStart} className="font-medium px-6 shadow-sm hover:opacity-90 transition-opacity">
          <Play className="h-4 w-4" />
          Lancer une nouvelle feuille de temps
        </Button>
      </div>

      {/* ===== Completed Entries ===== */}
      {completedEntries.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Terminées</h2>
            <span className="text-xs font-mono text-muted-foreground/60">{completedEntries.length}</span>
          </div>
          <div className="rounded-lg border border-border overflow-hidden">
            <Table className="table-fixed w-full">
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="w-9"></TableHead>
                  <TableHead className="w-[14%] text-xs font-medium text-muted-foreground">Client</TableHead>
                  <TableHead className="w-[16%] text-xs font-medium text-muted-foreground">Activité</TableHead>
                  <TableHead className="text-xs font-medium text-muted-foreground">Description</TableHead>
                  <TableHead className="w-[4.5rem] text-xs font-medium text-muted-foreground text-right">Réel</TableHead>
                  <TableHead className="w-[4.5rem] text-xs font-medium text-muted-foreground text-right">Durée</TableHead>
                  <TableHead className="w-[8.5rem]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {completedEntries.map(entry => (
                  <TableRow key={entry.id} className={`group ${entry.deferred ? 'bg-warning/5 hover:bg-warning/10' : ''}`}>
                    <TableCell className="pl-3 pr-1">
                      <input
                        type="checkbox"
                        checked={selectedForMerge.has(entry.id)}
                        onChange={() => toggleMergeSelection(entry.id)}
                        className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer align-middle"
                      />
                    </TableCell>
                    <TableCell className="truncate text-muted-foreground">
                      {resolveCustomerName(entry.activityId, activities.activities, customers.customers) || '—'}
                    </TableCell>
                    <TableCell className="truncate cursor-pointer" onClick={() => openEditModal(entry)}>
                      {activityNameOnly(entry, activities.activities) || '—'}
                    </TableCell>
                    <TableCell className="truncate cursor-pointer" onClick={() => openEditModal(entry)}>
                      {entry.splitAtMidnight && (
                        <span title="Coupée à minuit (le timer a changé de jour)">
                          <Scissors className="inline h-3 w-3 mr-1 text-muted-foreground align-[-1px]" />
                        </span>
                      )}
                      {entry.description || <span className="text-muted-foreground/50">—</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground text-right">
                      {formatDuration(entry.totalMinutes)}
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs font-medium text-right cursor-pointer"
                      onClick={() => openEditModal(entry)}
                    >
                      {formatDuration(entry.roundedMinutes)}
                    </TableCell>
                    <TableCell>
                      <div className={`flex gap-0.5 justify-end transition-opacity ${entry.deferred ? '' : 'opacity-0 group-hover:opacity-100'}`}>
                        <Button
                          variant={entry.deferred ? 'default' : 'ghost'}
                          size="icon-xs"
                          onClick={() => handleToggleDeferred(entry)}
                          title={entry.deferred ? 'Reporté — cliquer pour retirer' : 'À reporter'}
                          className={entry.deferred ? '' : 'text-muted-foreground hover:text-foreground'}
                        >
                          <Clock className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => handleReopen(entry.id)}
                          title="Remettre en cours"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Play className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => handleDuplicate(entry)}
                          title="Relancer (nouvelle entrée)"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => handleDeleteEntry(entry.id)}
                          title="Supprimer"
                          className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {selectedForMerge.size >= 2 && (
            <div className="flex items-center justify-between mt-3 p-3 rounded-lg border border-primary/30 bg-primary/5">
              <span className="text-sm font-medium">{selectedForMerge.size} entrées sélectionnées</span>
              <Button size="sm" onClick={openMergeDialog}>
                <Merge className="h-3.5 w-3.5" />
                Fusionner
              </Button>
            </div>
          )}
        </section>
      )}

      {/* ===== Deleted entries (nothing is ever erased on disk) ===== */}
      {deletedEntries.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Supprimées ({deletedEntries.length})
          </h2>
          <div className="rounded-lg border border-dashed border-border divide-y divide-border">
            {deletedEntries.map(entry => (
              <div key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <p className="text-sm text-muted-foreground truncate">
                  <span className="line-through">
                    {entryLabel(entry, activities.activities, customers.customers)}
                    {entry.description ? ` · ${entry.description}` : ''}
                  </span>
                  <span className="font-mono text-xs"> · {formatDuration(entry.totalMinutes)}</span>
                </p>
                <div className="flex gap-1.5 shrink-0">
                  <Button variant="outline" size="sm" onClick={() => handleRestoreEntry(entry.id)}>
                    <Undo2 className="h-3.5 w-3.5" />
                    Restaurer
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handlePurgeEntry(entry)}
                    title="Supprimer définitivement"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ===== Undo toast ===== */}
      {undoDelete && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border border-border bg-popover px-4 py-3 shadow-lg animate-in fade-in slide-in-from-bottom-2">
          <span className="text-sm">
            Entrée supprimée : <span className="font-medium">{undoDelete.label}</span>
          </span>
          <Button size="sm" variant="outline" onClick={() => handleRestoreEntry(undoDelete.id)}>
            <Undo2 className="h-3.5 w-3.5" />
            Annuler
          </Button>
          <button
            onClick={() => setUndoDelete(null)}
            title="Fermer"
            className="text-muted-foreground hover:text-foreground text-sm"
          >
            ✕
          </button>
        </div>
      )}

      {/* ===== Merge Modal ===== */}
      <Dialog open={mergeOpen} onOpenChange={(open) => { if (!open) setMergeOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Fusionner {selectedForMerge.size} entrées</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Entry list with toggle */}
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {completedEntries.filter(e => selectedForMerge.has(e.id)).map(entry => (
                <div key={entry.id} className="p-2.5 rounded-lg border border-border bg-card space-y-2">
                  <div>
                    <p className="text-sm font-medium truncate">{entryLabel(entry, activities.activities, customers.customers)}</p>
                    {entry.description && <p className="text-xs text-muted-foreground line-clamp-2">{entry.description}</p>}
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setMergeUseIndicated(prev => ({ ...prev, [entry.id]: false }))}
                      className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                        !mergeUseIndicated[entry.id]
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      Réel : {formatDuration(entry.totalMinutes)}
                    </button>
                    <button
                      onClick={() => setMergeUseIndicated(prev => ({ ...prev, [entry.id]: true }))}
                      className={`flex-1 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                        mergeUseIndicated[entry.id]
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      Indiqué : {formatDuration(entry.roundedMinutes)}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Total */}
            <div className="p-3 rounded-lg bg-accent/50 text-center">
              <p className="text-xs text-muted-foreground mb-1">Durée résultante</p>
              <p className="text-lg font-bold tabular-nums">
                {formatDuration(roundUp15(
                  completedEntries
                    .filter(e => selectedForMerge.has(e.id))
                    .reduce((sum, e) => sum + (mergeUseIndicated[e.id] ? e.roundedMinutes : e.totalMinutes), 0)
                ))}
              </p>
              <p className="text-xs text-muted-foreground">
                ({completedEntries
                  .filter(e => selectedForMerge.has(e.id))
                  .reduce((sum, e) => sum + (mergeUseIndicated[e.id] ? e.roundedMinutes : e.totalMinutes), 0)} min réel → arrondi 15min)
              </p>
            </div>

            {/* Activity */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Activité</label>
              <ClientActivityPicker
                customers={customers.customers}
                activities={activities.activities}
                activityId={mergeActivityId}
                showArchived={showArchived}
                onDataChanged={refresh}
                onChange={setMergeActivityId}
              />
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Description</label>
              <Textarea
                value={mergeDescription}
                onChange={e => setMergeDescription(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergeOpen(false)}>Annuler</Button>
            <Button onClick={handleMerge}>
              <Merge className="h-4 w-4" />
              Fusionner
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Edit Modal ===== */}
      <Dialog open={!!editingEntry} onOpenChange={(open) => { if (!open) setEditingEntry(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifier l'entrée</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Activité</label>
              <ClientActivityPicker
                customers={customers.customers}
                activities={activities.activities}
                activityId={editActivityId}
                showArchived={showArchived}
                onDataChanged={refresh}
                onChange={setEditActivityId}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Description</label>
              <Textarea
                value={editDescription}
                onChange={e => setEditDescription(e.target.value)}
                rows={4}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-muted-foreground">Durée (minutes)</label>
              <Input
                type="number"
                value={editMinutes}
                onChange={e => setEditMinutes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingEntry(null)}>Annuler</Button>
            <Button onClick={saveEditModal}>Enregistrer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
