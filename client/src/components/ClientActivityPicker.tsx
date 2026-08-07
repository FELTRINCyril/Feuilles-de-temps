import { useState, useEffect, useMemo } from 'react';
import { Combobox } from '@/components/ui/combobox';
import * as api from '../api';
import type { Activity, Customer } from '../types';

interface Props {
  customers: Customer[];
  activities: Activity[];
  activityId: string;
  onChange: (activityId: string) => void;
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
  customers, activities, activityId, onChange, onDataChanged, showArchived = false, className,
}: Props) {
  const currentActivity = activities.find(a => a.id === activityId);
  const [customerId, setCustomerId] = useState(currentActivity?.customerId ?? '');

  // Switching to a different entry (a different activityId from outside) resets
  // which client is shown, since this component's local customerId otherwise
  // wouldn't know about it.
  useEffect(() => {
    setCustomerId(activities.find(a => a.id === activityId)?.customerId ?? '');
  }, [activityId, activities]);

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

  return (
    <div className={className ?? 'grid grid-cols-2 gap-2'}>
      <Combobox
        value={customerId}
        options={customerOptions}
        placeholder="-- Client --"
        emptyLabel="-- Aucun client --"
        createLabel={(name) => `Créer le client « ${name} »`}
        onSelect={(id) => {
          setCustomerId(id);
          // An activity that belonged to the previous client no longer applies.
          if (currentActivity && currentActivity.customerId !== id) onChange('');
        }}
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
        onSelect={onChange}
        onCreate={createActivity}
      />
    </div>
  );
}
