import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import * as api from '../api';
import type { StatsData } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { DatePicker } from '@/components/ui/date-picker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function startOfWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const day = date.getDay();
  const diff = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - diff);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function endOfWeek(dateStr: string): string {
  const start = startOfWeek(dateStr);
  const [y, m, d] = start.split('-').map(Number);
  const date = new Date(y, m - 1, d + 6);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfMonth(dateStr: string): string {
  return dateStr.slice(0, 7) + '-01';
}

function endOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

function formatH(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, '0')}`;
}

function shortDate(dateStr: string): string {
  const [, m, d] = dateStr.split('-');
  return `${d}/${m}`;
}

function formatDateFR(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const days = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  return `${days[date.getDay()]}. ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

function formatMonthFR(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number);
  const months = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  return `${months[m - 1]} ${y}`;
}

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#94a3b8'];

/** Resolve a CSS custom property to its computed value. */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Hook that returns resolved chart theme colors, updating on dark/light switch. */
function useChartTheme() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setTick(t => t + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return useMemo(() => ({
    primary: cssVar('--primary'),
    tempo: cssVar('--tempo'),
    foreground: cssVar('--foreground'),
    mutedForeground: cssVar('--muted-foreground'),
    card: cssVar('--card'),
    border: cssVar('--border'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [tick]);
}

function Top3Legend({ payload }: { payload?: Array<{ value: string; color: string; payload?: { hours?: number } }> }) {
  if (!payload?.length) return null;
  const sorted = [...payload].sort((a, b) => (b.payload?.hours ?? 0) - (a.payload?.hours ?? 0));
  const items = sorted.slice(0, 3);
  return (
    <ul className="list-none p-0 mt-2 text-xs min-h-[5.5rem] space-y-1">
      {items.map((entry, i) => (
        <li key={i} className="flex items-center gap-1.5 text-muted-foreground">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: entry.color }} />
          <span style={{ color: entry.color }}>{entry.value}</span> : {entry.payload?.hours ?? 0}h
        </li>
      ))}
      {payload.length > 3 && (
        <li className="text-muted-foreground">+{payload.length - 3} autres</li>
      )}
    </ul>
  );
}

function PieTooltip({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; payload: { fill: string; totalHours?: number } }> }) {
  if (!active || !payload?.length) return null;
  const { name, value, payload: p } = payload[0];
  const pct = p.totalHours ? Math.round(value / p.totalHours * 100) : 0;
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2 text-sm text-foreground shadow-md">
      <span style={{ color: p.fill }}>{name}</span> : {value}h ({pct}%)
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Period = 'day' | 'week' | 'month' | 'custom';

const periodButtons: { key: Period; label: string }[] = [
  { key: 'day', label: 'Jour' },
  { key: 'week', label: 'Semaine' },
  { key: 'month', label: 'Mois' },
  { key: 'custom', label: 'Personnalisé' },
];

export default function StatsPage() {
  const [period, setPeriod] = useState<Period>('week');
  const [refDate, setRefDate] = useState(todayStr);
  const [customFrom, setCustomFrom] = useState(todayStr);
  const [customTo, setCustomTo] = useState(todayStr);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const range = period === 'custom'
    ? { from: customFrom, to: customTo }
    : period === 'day'
      ? { from: refDate, to: refDate }
      : period === 'week'
        ? { from: startOfWeek(refDate), to: endOfWeek(refDate) }
        : { from: startOfMonth(refDate), to: endOfMonth(refDate) };

  const refresh = useCallback(async () => {
    try {
      const data = await api.getStats(range.from, range.to);
      setStats(data);
      setLoadError(null);
    } catch {
      setLoadError("Impossible de contacter le serveur local. Vérifiez que l'application est bien lancée.");
    }
  }, [range.from, range.to]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  function shiftPeriod(offset: number) {
    const [y, m, d] = refDate.split('-').map(Number);
    if (period === 'day') {
      const date = new Date(y, m - 1, d + offset);
      setRefDate(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
    } else if (period === 'week') {
      const date = new Date(y, m - 1, d + offset * 7);
      setRefDate(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
    } else {
      const date = new Date(y, m - 1 + offset, 1);
      setRefDate(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`);
    }
  }

  const periodLabel = period === 'custom'
    ? `${shortDate(range.from)} — ${shortDate(range.to)}`
    : period === 'day'
      ? formatDateFR(refDate)
      : period === 'week'
        ? `${shortDate(range.from)} — ${shortDate(range.to)}`
        : formatMonthFR(refDate);

  const today = todayStr();
  const isCurrentPeriod = period === 'day'
    ? refDate === today
    : period === 'week'
      ? startOfWeek(refDate) === startOfWeek(today)
      : period === 'month'
        ? refDate.slice(0, 7) === today.slice(0, 7)
        : true;

  const currentPeriodLabel = period === 'day'
    ? "Aujourd'hui"
    : period === 'week'
      ? 'Cette semaine'
      : period === 'month'
        ? 'Ce mois'
        : '';

  const theme = useChartTheme();

  if (!stats) {
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

  const dayData = stats.byDay.map(d => ({ ...d, label: shortDate(d.date), hours: +(d.minutes / 60).toFixed(1) }));

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {loadError && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => refresh()}>Réessayer</Button>
        </div>
      )}
      {/* Period navigation */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex rounded-md border border-border overflow-hidden shrink-0">
          {periodButtons.map(({ key, label }) => (
            <button
              key={key}
              className={`px-3 py-1.5 text-sm border-none cursor-pointer transition-colors ${
                period === key
                  ? 'bg-primary text-primary-foreground font-medium'
                  : 'bg-card text-muted-foreground hover:bg-accent'
              }`}
              onClick={() => setPeriod(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {period === 'custom' ? (
          <div className="flex items-center gap-2">
            <DatePicker value={customFrom} onChange={setCustomFrom} className="w-auto" />
            <span className="text-muted-foreground shrink-0">—</span>
            <DatePicker value={customTo} onChange={setCustomTo} className="w-auto" align="end" />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => shiftPeriod(-1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-semibold tabular-nums min-w-[10em] text-center">
              {periodLabel}
            </span>
            <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => shiftPeriod(1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            {currentPeriodLabel && !isCurrentPeriod && (
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setRefDate(todayStr())}>
                <CalendarDays className="h-3 w-3" />
                {currentPeriodLabel}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Summary cards */}
      {(() => {
        const cards: { value: string; label: string }[] = [
          { value: formatH(stats.totalRoundedMinutes), label: 'Total' },
          { value: String(stats.entryCount), label: 'Entrées' },
        ];
        if (period === 'week' || period === 'month' || period === 'custom') {
          const avgDay = stats.byDay.length > 0 ? Math.round(stats.totalRoundedMinutes / stats.byDay.length) : 0;
          cards.push({ value: formatH(avgDay), label: 'Moy / jour' });
        }
        if (period === 'month' || period === 'custom') {
          const weeks = new Set(stats.byDay.map(d => startOfWeek(d.date)));
          const avgWeek = weeks.size > 0 ? Math.round(stats.totalRoundedMinutes / weeks.size) : 0;
          cards.push({ value: formatH(avgWeek), label: 'Moy / semaine' });
        }
        return (
          <div className={`grid gap-4 sm:gap-4`} style={{ gridTemplateColumns: `repeat(${cards.length}, minmax(0, 1fr))` }}>
            {cards.map(({ value, label }) => (
              <Card key={label} className="py-5 gap-0 shadow-xs">
                <CardContent>
                  <div className="font-mono text-3xl font-medium tracking-tight tabular-nums">{value}</div>
                  <div className="text-xs text-muted-foreground mt-1.5">{label}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        );
      })()}

      {/* Daily bar chart */}
      {dayData.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Heures par jour</h2>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={dayData}>
              <CartesianGrid strokeDasharray="3 3" stroke={theme.border} />
              <XAxis dataKey="label" tick={{ fill: theme.mutedForeground, fontSize: 12 }} />
              <YAxis tick={{ fill: theme.mutedForeground, fontSize: 12 }} unit="h" />
              <Tooltip
                contentStyle={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 6 }}
                labelStyle={{ color: theme.foreground }}
                cursor={{ fill: theme.border, opacity: 0.3 }}
                formatter={(value: unknown) => [`${value ?? 0}h`, 'Heures']}
              />
              <Bar dataKey="hours" fill={theme.tempo} radius={[5, 5, 0, 0]} maxBarSize={44} />
            </BarChart>
          </ResponsiveContainer>
        </section>
      )}

      {/* By customer & type pies */}
      <div className="flex gap-4 lg:gap-6 max-sm:flex-col">
        {stats.byCustomer.length > 0 && (
          <section className="flex-1 min-w-0 space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Par client</h2>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={stats.byCustomer.map(c => ({ ...c, hours: +(c.minutes / 60).toFixed(1), totalHours: +(stats.totalRoundedMinutes / 60).toFixed(1) }))}
                  dataKey="hours"
                  nameKey="name"
                  cx="50%" cy="50%"
                  outerRadius={90}
                  innerRadius={58}
                  paddingAngle={2}
                  stroke="none"
                >
                  {stats.byCustomer.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip content={<PieTooltip />} />
                <Legend content={<Top3Legend />} />
              </PieChart>
            </ResponsiveContainer>
          </section>
        )}

        {stats.byType.length > 0 && (
          <section className="flex-1 min-w-0 space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Interne / Externe</h2>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={stats.byType.map(t => ({ ...t, label: t.type.charAt(0).toUpperCase() + t.type.slice(1), hours: +(t.minutes / 60).toFixed(1), totalHours: +(stats.totalRoundedMinutes / 60).toFixed(1) }))}
                  dataKey="hours"
                  nameKey="label"
                  cx="50%" cy="50%"
                  outerRadius={90}
                  innerRadius={58}
                  paddingAngle={2}
                  stroke="none"
                >
                  {stats.byType.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip content={<PieTooltip />} />
                <Legend content={<Top3Legend />} />
              </PieChart>
            </ResponsiveContainer>
          </section>
        )}
      </div>

      {/* By activity charts row */}
      <div className="flex gap-4 lg:gap-6 max-sm:flex-col">
        {stats.byActivity.length > 0 && (
          <section className="flex-1 min-w-0 space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Par activité (détaillé)</h2>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={stats.byActivity.map(a => ({ ...a, label: a.customerName ? `${a.name} — ${a.customerName}` : a.name, hours: +(a.minutes / 60).toFixed(1), totalHours: +(stats.totalRoundedMinutes / 60).toFixed(1) }))}
                  dataKey="hours"
                  nameKey="label"
                  cx="50%" cy="50%"
                  outerRadius={90}
                  innerRadius={58}
                  paddingAngle={2}
                  stroke="none"
                >
                  {stats.byActivity.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip content={<PieTooltip />} />
                <Legend content={<Top3Legend />} />
              </PieChart>
            </ResponsiveContainer>
          </section>
        )}

        {stats.byActivity.length > 0 && (
          <section className="flex-1 min-w-0 space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Par activité</h2>
            {(() => {
              const grouped = stats.byActivity.reduce<Record<string, number>>((acc, a) => {
                acc[a.name] = (acc[a.name] || 0) + a.minutes;
                return acc;
              }, {});
              const totalHours = +(stats.totalRoundedMinutes / 60).toFixed(1);
              const data = Object.entries(grouped).map(([name, minutes]) => ({ name, hours: +(minutes / 60).toFixed(1), totalHours }));
              return (
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie data={data} dataKey="hours" nameKey="name" cx="50%" cy="50%" outerRadius={90}
                  innerRadius={58}
                  paddingAngle={2} stroke="none">
                      {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip content={<PieTooltip />} />
                    <Legend content={<Top3Legend />} />
                  </PieChart>
                </ResponsiveContainer>
              );
            })()}
          </section>
        )}
      </div>

      {stats.byDay.length === 0 && (
        <p className="text-muted-foreground text-center mt-8">
          Aucune donnée pour cette période.
        </p>
      )}
    </div>
  );
}
