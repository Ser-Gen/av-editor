/**
 * How full the store is, refreshed when it can plausibly have changed.
 *
 * `navigator.storage.estimate()` covers the whole origin — OPFS media, recordings, export
 * scratch, IndexedDB — so one figure is honest for the entire app. It is not free, and it is
 * not interesting between frames: it is read on mount, whenever the library changes, and
 * whenever a caller says something was written.
 */
import { useCallback, useEffect, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { budgetOf } from '../utils/storageBudget';
import type { StorageBudget } from '../utils/storageBudget';
import { isPersisted } from '../project/opfs';
import { storageBreakdown } from '../project/projectStore';
import type { StorageBreakdown } from '../project/projectStore';

export interface StorageReading {
  budget: StorageBudget | null;
  breakdown: StorageBreakdown | null;
  refresh: () => void;
}

export function useStorageBudget(): StorageReading {
  const [budget, setBudget] = useState<StorageBudget | null>(null);
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(null);
  const mediaLibrary = useEditorStore((s) => s.mediaLibrary);
  // The *phase*, not the job: a running preset republishes `processJob` on every progress
  // tick, and re-estimating storage sixty times a job would be pure waste.
  const jobPhase = useEditorStore((s) => s.processJob?.phase ?? null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const estimate = (await navigator.storage?.estimate?.()) ?? {};
        const persisted = await isPersisted();
        const parts = await storageBreakdown();
        if (cancelled) return;
        setBudget(budgetOf(estimate.usage ?? 0, estimate.quota ?? 0, persisted));
        setBreakdown(parts);
      } catch {
        if (!cancelled) setBudget(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // A finished preset job writes a file; the library changing covers imports and deletes.
  }, [mediaLibrary, jobPhase, tick]);

  return { budget, breakdown, refresh };
}
