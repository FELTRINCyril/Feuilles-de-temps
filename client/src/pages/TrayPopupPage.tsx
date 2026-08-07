import { useState, useEffect, useCallback, useRef } from 'react';
import type { TimesheetDay, TimesheetEntry, ActivitiesData, CustomersData } from '../types';
import * as api from '../api';
import * as desktop from '../desktop';
import { Play, Pause, CircleStop, Trash2, Plus, X, Clock, ChevronLeft, Maximize2 } from 'lucide-react';
import { ClientActivityPicker } from '../components/ClientActivityPicker';

async function updateTrayTitle(text: string) {
  desktop.setTrayTitle(text);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimer(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, '0')}`;
}

function parseTimestamp(value: string): Date {
  if (value.includes('T')) return new Date(value);
  const [h, m] = value.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function computeElapsedSeconds(entry: TimesheetEntry): number {
  let totalSec = 0;
  for (const seg of entry.segments) {
    const startMs = parseTimestamp(seg.start).getTime();
    if (seg.end) {
      totalSec += Math.floor((parseTimestamp(seg.end).getTime() - startMs) / 1000);
    } else {
      totalSec += Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    }
  }
  return totalSec;
}

function entryLabel(entry: TimesheetEntry, activities: ActivitiesData, customersList: { id: string; name: string }[]): string {
  const activity = activities.activities.find(a => a.id === entry.activityId);
  if (activity) return activityOptionLabel(activity, customersList);
  const startTime = entry.segments[0]?.start;
  if (startTime) {
    const d = parseTimestamp(startTime);
    return `Démarré à ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return 'Timer';
}

function activityOptionLabel(activity: { name: string; customerId: string }, customersList: { id: string; name: string }[]): string {
  const customer = customersList.find(c => c.id === activity.customerId);
  return customer ? `${customer.name} - ${activity.name}` : activity.name;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TrayPopupPage() {
  const [day, setDay] = useState<TimesheetDay | null>(null);
  const [activities, setActivities] = useState<ActivitiesData>({ activities: [] });
  const [customers, setCustomers] = useState<CustomersData>({ customers: [] });
  const [elapsedMap, setElapsedMap] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  // The app runs for days on end: this must follow the calendar, otherwise the
  // popup keeps reading and writing yesterday's file.
  const [currentDate, setCurrentDate] = useState(todayStr);

  useEffect(() => {
    const id = setInterval(() => {
      const today = todayStr();
      setCurrentDate(prev => (prev === today ? prev : today));
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // Whether archived clients/activities should be offered in the picker
  const [showArchived, setShowArchived] = useState(() => localStorage.getItem('showArchived') === '1');
  useEffect(() => {
    const handler = () => setShowArchived(localStorage.getItem('showArchived') === '1');
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // Edit panel state
  const [editingEntry, setEditingEntry] = useState<TimesheetEntry | null>(null);
  const [editActivityId, setEditActivityId] = useState('');
  const [editDescription, setEditDescription] = useState('');

  useEffect(() => {
    const prevHtmlBg = document.documentElement.style.background;
    const prevBodyBg = document.body.style.background;
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      document.documentElement.style.background = prevHtmlBg;
      document.body.style.background = prevBodyBg;
    };
  }, []);

  const syncChannel = useRef(new BroadcastChannel('tempo-sync'));
  useEffect(() => () => syncChannel.current.close(), []);

  const refresh = useCallback(async (notify = false) => {
    try {
      const [t, a, c] = await Promise.all([api.getTimesheet(currentDate), api.getActivities(), api.getCustomers()]);
      setDay(t);
      setActivities(a);
      setCustomers(c);
      if (notify) syncChannel.current.postMessage('refresh');
    } catch { /* ignore */ }
  }, [currentDate]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    syncChannel.current.onmessage = () => refresh();
  }, [refresh]);
  useEffect(() => desktop.onSystemSync(() => { refresh(); }), [refresh]);
  useEffect(() => {
    // Only poll while the popup is actually on screen: hidden, it would keep
    // waking the machine up for nothing.
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (id === null) id = setInterval(refresh, 2000); };
    const stop = () => { if (id !== null) { clearInterval(id); id = null; } };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { refresh(); start(); } else { stop(); }
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refresh]);

  const activeEntries: TimesheetEntry[] =
    day?.activeEntries
      ?.map(id => day.entries.find(e => e.id === id))
      .filter((e): e is TimesheetEntry => !!e) ?? [];
  const pausedEntries: TimesheetEntry[] =
    day?.pausedEntries
      .map(id => day.entries.find(e => e.id === id))
      .filter((e): e is TimesheetEntry => !!e) ?? [];

  // Elapsed ticker
  useEffect(() => {
    if (activeEntries.length === 0) {
      setElapsedMap({});
      if (pausedEntries.length > 0) {
        updateTrayTitle('⏸');
      } else {
        updateTrayTitle('');
      }
      return;
    }
    function tick() {
      const map: Record<string, number> = {};
      for (const entry of activeEntries) {
        map[entry.id] = computeElapsedSeconds(entry);
      }
      setElapsedMap(map);
      if (activeEntries.length === 1) {
        updateTrayTitle(formatTimer(map[activeEntries[0].id] ?? 0));
      } else {
        updateTrayTitle(`${activeEntries.length} actifs`);
      }
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [activeEntries.length, activeEntries.map(e => e.id).join(','), pausedEntries.length]);

  // Popup auto-hide on blur is handled by the Electron main process (electron/main.js)

  async function close() {
    desktop.closeTrayPopup();
  }

  async function handlePause(entry: TimesheetEntry) {
    setLoading(true);
    try {
      await api.pauseEntry(currentDate, entry.id);
      await refresh(true);
    } finally { setLoading(false); }
  }

  async function handleFinish(entry: TimesheetEntry) {
    setLoading(true);
    try {
      await api.updateEntry(currentDate, entry.id, { status: 'completed' });
      await refresh(true);
    } finally { setLoading(false); }
  }

  async function handleCancel(entry: TimesheetEntry) {
    setLoading(true);
    try {
      await api.deleteEntry(currentDate, entry.id);
      await refresh(true);
    } finally { setLoading(false); }
  }

  async function handleResume(id: string) {
    setLoading(true);
    try {
      await api.resumeEntry(currentDate, id);
      await refresh(true);
    } finally { setLoading(false); }
  }

  async function handleQuickStart() {
    setLoading(true);
    try {
      await api.createEntry(currentDate, { activityId: '', description: '' });
      await refresh(true);
    } finally { setLoading(false); }
  }

  function openEdit(entry: TimesheetEntry) {
    setEditingEntry(entry);
    setEditActivityId(entry.activityId);
    setEditDescription(entry.description);
  }

  async function saveEdit() {
    if (!editingEntry) return;
    const updates: Record<string, unknown> = {};
    if (editActivityId !== editingEntry.activityId) updates.activityId = editActivityId;
    if (editDescription !== editingEntry.description) updates.description = editDescription;
    if (Object.keys(updates).length > 0) {
      setLoading(true);
      try {
        await api.updateEntry(currentDate, editingEntry.id, updates);
        await refresh(true);
      } finally { setLoading(false); }
    }
    setEditingEntry(null);
  }

  // ── Edit panel view ──────────────────────────────────────────────────────
  if (editingEntry) {
    // Keep entry fresh from day data
    const freshEntry = day?.entries.find(e => e.id === editingEntry.id) ?? editingEntry;
    const isActive = day?.activeEntries?.includes(freshEntry.id) ?? false;

    return (
      <div
        className="flex flex-col h-screen bg-popover text-foreground select-none overflow-hidden"
        style={{ borderRadius: '12px' }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <button
            onClick={() => setEditingEntry(null)}
            className="flex items-center justify-center w-6 h-6 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-semibold text-foreground">Détails</span>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Timer display if active */}
          {isActive && (
            <div className="text-center py-2">
              <span className="font-mono text-3xl font-bold tabular-nums tracking-tight text-foreground">
                {formatTimer(elapsedMap[freshEntry.id] ?? 0)}
              </span>
            </div>
          )}

          {/* Client + activity */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Client / Activité</label>
            <ClientActivityPicker
              customers={customers.customers}
              activities={activities.activities}
              activityId={editActivityId}
              showArchived={showArchived}
              onDataChanged={refresh}
              onChange={setEditActivityId}
              className="grid grid-cols-1 gap-1.5"
            />
          </div>

          {/* Description */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Description</label>
            <textarea
              value={editDescription}
              onChange={e => setEditDescription(e.target.value)}
              placeholder="(optionnel)"
              rows={3}
              className="w-full rounded-lg border border-border bg-card px-2.5 py-2 text-sm resize-none"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="border-t border-border p-3 space-y-2">
          <button
            onClick={saveEdit}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:opacity-90 transition-all duration-150 disabled:opacity-50"
          >
            Enregistrer
          </button>
          <div className="flex gap-2">
            {isActive ? (
              <>
                <button
                  onClick={() => { handlePause(freshEntry); setEditingEntry(null); }}
                  disabled={loading}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold border border-border bg-card hover:bg-accent transition-all duration-150 disabled:opacity-50"
                >
                  <Pause className="h-3.5 w-3.5" /> Pause
                </button>
                <button
                  onClick={() => { handleFinish(freshEntry); setEditingEntry(null); }}
                  disabled={loading}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold border border-border bg-card hover:bg-accent transition-all duration-150 disabled:opacity-50"
                >
                  <CircleStop className="h-3.5 w-3.5" /> Terminer
                </button>
              </>
            ) : (
              <button
                onClick={() => { handleResume(freshEntry.id); setEditingEntry(null); }}
                disabled={loading}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold bg-primary/10 text-primary hover:bg-primary/20 transition-all duration-150 disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" /> Reprendre
              </button>
            )}
            <button
              onClick={() => { handleCancel(freshEntry); setEditingEntry(null); }}
              disabled={loading}
              className="flex items-center justify-center px-3 py-2 rounded-xl text-xs font-semibold border border-destructive/30 text-destructive hover:bg-destructive/10 transition-all duration-150 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main list view ──────────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col h-screen bg-popover text-foreground select-none overflow-hidden"
      style={{ borderRadius: '12px' }}
    >
      {/* ── Header ── */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-border"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Feuilles de temps</span>
        </div>
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={() => desktop.openMainWindow()}
            title="Ouvrir l'application"
            className="flex items-center justify-center w-6 h-6 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={close}
            className="flex items-center justify-center w-6 h-6 rounded-full text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ── Active timers ── */}
        {activeEntries.length > 0 ? (
          <div>
            {activeEntries.map(entry => (
              <div
                key={entry.id}
                className="p-4 border-b border-border cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => openEdit(entry)}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                  </span>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">En cours</p>
                </div>
                <p className="text-sm font-semibold truncate mb-3 mt-1 text-foreground">
                  {entryLabel(entry, activities, customers.customers)}
                </p>

                <div className="flex justify-center mb-4">
                  <span
                    className="font-mono text-4xl font-bold tabular-nums tracking-tight text-foreground"
                    style={{ letterSpacing: '-0.02em' }}
                  >
                    {formatTimer(elapsedMap[entry.id] ?? 0)}
                  </span>
                </div>

                <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                  <button
                    onClick={() => handlePause(entry)}
                    disabled={loading}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold border border-border bg-card hover:bg-accent transition-all duration-150 disabled:opacity-50"
                  >
                    <Pause className="h-4 w-4" />
                    Pause
                  </button>
                  <button
                    onClick={() => handleFinish(entry)}
                    disabled={loading}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:opacity-90 transition-all duration-150 disabled:opacity-50"
                  >
                    <CircleStop className="h-4 w-4" />
                    Terminer
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 py-6 text-center border-b border-border">
            <p className="text-sm text-muted-foreground">Aucun timer en cours</p>
          </div>
        )}

        {/* ── Paused timers ── */}
        {pausedEntries.length > 0 && (
          <div className="px-2 py-2">
            <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              En pause
            </p>
            {pausedEntries.map(entry => (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-2 px-2 py-2.5 rounded-xl hover:bg-accent transition-colors cursor-pointer"
                onClick={() => openEdit(entry)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning shrink-0" />
                  <span className="text-sm truncate">{entryLabel(entry, activities, customers.customers)}</span>
                  <span className="text-xs text-muted-foreground shrink-0 font-mono">
                    {formatDuration(entry.totalMinutes)}
                  </span>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleResume(entry.id); }}
                  disabled={loading}
                  className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-primary/10 text-primary hover:bg-primary/20 transition-all duration-150 disabled:opacity-50"
                >
                  <Play className="h-3 w-3" />
                  Reprendre
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Footer: new timer ── */}
      <div className="border-t border-border p-2">
        <button
          onClick={handleQuickStart}
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 px-3 py-3 rounded-xl text-sm font-semibold text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-150 disabled:opacity-50 group"
        >
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/10 group-hover:bg-primary/20 transition-colors">
            <Plus className="h-3 w-3 text-primary" />
          </div>
          Nouveau timer
        </button>
      </div>
    </div>
  );
}
