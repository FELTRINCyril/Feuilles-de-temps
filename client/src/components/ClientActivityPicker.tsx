import { useMemo } from 'react';
import { Combobox } from '@/components/ui/combobox';
import * as api from '../api';
import type { Activity, Customer } from '../types';

export interface ClientActivitySelection {
  customerId: string;
  activityId: string;
}

interface Props {
  customers: Customer[];
  activities: Activity[];
  value: ClientActivitySelection;
  /** Always receives both halves: the client stands on its own, so picking one
   * without an activity is a complete, saveable choice. */
  onChange: (next: ClientActivitySelection) => void;
  /** Re-fetches the parent's customer/activity lists after a create, so they
   * stay in sync. The picker itself doesn't wait for that round-trip: it
   * already has the new id from the create response. */
  onDataChanged: () => void | Promise<void>;
  showArchived?: boolean;
  className?: string;
}

/**
 * Two chained fields — client, then that client's activities — replacing a
 * single flat activity dropdown. Both fields are searchable and can create a
 * new client/activity from the typed text when nothing matches; a new
 * activity is always linked to whichever client is currently selected here.
 */
export function ClientActivityPicker({
  customers, activities, value, onChange, onDataChanged, showArchived = false, className,
}: Props) {
  const { customerId, activityId } = value;

  const customerOptions = useMemo(() => (
    customers
      .filter(c => showArchived || !c.archived || c.id === customerId)
      .map(c => ({ id: c.id, label: c.name, sublabel: c.archived ? '(archivée)' : undefined }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'))
  ), [customers, showArchived, customerId]);

  const activityOptions = useMemo(() => (
    activities
      .filter(a => a.customerId === customerId && (showArchived || !a.archived || a.id === activityId))
      .map(a => ({ id: a.id, label: a.name, sublabel: a.archived ? '(archivée)' : undefined }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'))
  ), [activities, customerId, showArchived, activityId]);

  async function createCustomer(name: string): Promise<string> {
    const created = await api.createCustomer({ name, type: 'externe' });
    await onDataChanged();
    return created.id;
  }

  async function createActivity(name: string): Promise<string> {
    const created = await api.createActivity({ name, customerId });
    await onDataChanged();
    return created.id;
  }

  function selectCustomer(id: string) {
    // An activity that belonged to the previous client no longer applies.
    const keepsActivity = activities.some(a => a.id === activityId && a.customerId === id);
    onChange({ customerId: id, activityId: keepsActivity ? activityId : '' });
  }

  function selectActivity(id: string) {
    const activity = activities.find(a => a.id === id);
    onChange({ customerId: activity?.customerId || customerId, activityId: id });
  }

  return (
    <div className={className ?? 'grid grid-cols-2 gap-2'}>
      <Combobox
        value={customerId}
        options={customerOptions}
        placeholder="-- Client --"
        emptyLabel="-- Aucun client --"
        createLabel={(name) => `Créer le client « ${name} »`}
        onSelect={selectCustomer}
        onCreate={createCustomer}
      />
      <Combobox
        value={activityId}
        options={activityOptions}
        placeholder="-- Activité --"
        emptyLabel="-- Aucune activité --"
        createLabel={(name) => (
          customerId ? `Créer l'activité « ${name} »` : `Créer l'activité « ${name} » (sans client)`
        )}
        onSelect={selectActivity}
        onCreate={createActivity}
      />
    </div>
  );
}
