import { useState, useMemo, useRef, useEffect } from 'react';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface ComboboxOption {
  id: string;
  label: string;
  sublabel?: string;
}

interface ComboboxProps {
  value: string;
  options: ComboboxOption[];
  placeholder?: string;
  emptyLabel?: string;
  createLabel?: (query: string) => string;
  onSelect: (id: string) => void;
  onCreate?: (name: string) => Promise<string>;
  disabled?: boolean;
  className?: string;
}

/** Searchable dropdown that can create a new option from the typed text when
 * nothing matches. Built on the existing Popover primitive rather than a new
 * dependency, so it works the same in the main window and the small tray popup. */
export function Combobox({
  value, options, placeholder, emptyLabel = '-- Aucun --',
  createLabel, onSelect, onCreate, disabled, className,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find(o => o.id === value);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCreating(false);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const exactMatch = options.some(o => o.label.toLowerCase() === query.trim().toLowerCase());
  const canCreate = !!onCreate && query.trim().length > 0 && !exactMatch;

  async function handleCreate() {
    if (!onCreate) return;
    const name = query.trim();
    if (!name) return;
    setCreating(true);
    try {
      const id = await onCreate(name);
      onSelect(id);
      setOpen(false);
    } finally {
      setCreating(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'w-full h-9 flex items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
            !selected && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{selected ? selected.label : (placeholder ?? emptyLabel)}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-0"
        align="start"
        onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
      >
        <div className="p-1.5 border-b border-border">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher..."
            className="w-full h-8 px-2 rounded-md bg-transparent text-sm focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered.length === 0 && canCreate) {
                e.preventDefault();
                handleCreate();
              }
            }}
          />
        </div>
        <div
          className="max-h-48 overflow-y-auto overscroll-contain p-1"
          style={{ touchAction: 'pan-y' }}
          onWheel={(e) => e.stopPropagation()}
        >
          {value !== '' && (
            <button
              type="button"
              onClick={() => { onSelect(''); setOpen(false); }}
              className="w-full text-left px-2 py-1.5 rounded text-sm text-muted-foreground hover:bg-accent"
            >
              {emptyLabel}
            </button>
          )}
          {filtered.map(o => (
            <button
              key={o.id}
              type="button"
              onClick={() => { onSelect(o.id); setOpen(false); }}
              className={cn(
                'w-full flex items-center gap-2 text-left px-2 py-1.5 rounded text-sm hover:bg-accent',
                o.id === value && 'font-medium',
              )}
            >
              <Check className={cn('h-3.5 w-3.5 shrink-0', o.id === value ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
              <span className="truncate">{o.label}</span>
              {o.sublabel && <span className="text-xs text-muted-foreground shrink-0 ml-auto">{o.sublabel}</span>}
            </button>
          ))}
          {filtered.length === 0 && !canCreate && (
            <p className="px-2 py-3 text-xs text-muted-foreground text-center">Aucun résultat</p>
          )}
        </div>
        {canCreate && (
          <div className="p-1 border-t border-border">
            <button
              type="button"
              disabled={creating}
              onClick={handleCreate}
              className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded text-sm text-primary hover:bg-accent disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {creating ? 'Création...' : (createLabel ? createLabel(query.trim()) : `Créer « ${query.trim()} »`)}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
