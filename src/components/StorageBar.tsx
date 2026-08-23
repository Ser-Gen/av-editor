/**
 * What the browser is holding, and what is left.
 *
 * Bytes alone do not answer the question anyone actually has, so the Record panel converts
 * the same free figure into minutes of recording. Here — in the library, where files
 * accumulate and get deleted — bytes are the right unit, because the action available is
 * "delete something", and size is what decides which something.
 *
 * `persisted` is shown as a separate word on purpose: plenty of free space and evictable
 * storage still loses a project, and they fail independently.
 */
import { useState } from 'react';
import { useStorageBudget } from '../hooks/useStorageBudget';
import { budgetLevel, formatBytes } from '../utils/storageBudget';
import { clearEverything } from '../project/projectStore';

export function StorageBar() {
  const { budget, breakdown } = useStorageBudget();
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  if (!budget || budget.quota <= 0) return null;

  const level = budgetLevel(budget);
  const usedFraction = Math.min(1, budget.usage / budget.quota);

  const onClear = async () => {
    setClearing(true);
    await clearEverything();
    // A reload is the honest way to show a cleared store: half this app's state lives in
    // module-level caches that were built from files that no longer exist.
    location.reload();
  };

  return (
    <div className={`storage-bar storage-bar--${level}`}>
      <div className="storage-bar-track" aria-hidden>
        <div className="storage-bar-fill" style={{ width: `${usedFraction * 100}%` }} />
      </div>
      <div className="storage-bar-line">
        <span className="storage-bar-figure">
          {formatBytes(budget.usage)} of {formatBytes(budget.quota)}
        </span>
        <span className="storage-bar-word" title={
          budget.persisted
            ? 'The browser has been asked not to evict this data.'
            : 'The browser may evict this data to reclaim space. Safari also evicts after 7 days without a visit — save a copy to a folder to be safe.'
        }>
          {budget.persisted ? 'Persistent' : 'Can be evicted'}
        </span>
        <button type="button" className="storage-bar-clear" onClick={() => setConfirming(true)}>
          Clear everything
        </button>
      </div>

      {confirming && (
        <div className="modal-backdrop" onClick={() => !clearing && setConfirming(false)}>
          <div className="modal storage-clear" onClick={(e) => e.stopPropagation()}>
            <h2>Clear everything</h2>
            <p>
              This deletes the saved project, every recording, every file this app produced,
              and the export scratch. Imported files on your own disk are untouched.
              <strong> It cannot be undone.</strong>
            </p>
            {breakdown && (
              <ul className="storage-breakdown">
                <li><span>Project</span><span>{formatBytes(breakdown.project)}</span></li>
                <li><span>Produced media</span><span>{formatBytes(breakdown.media)}</span></li>
                <li><span>Recordings</span><span>{formatBytes(breakdown.recordings)}</span></li>
                <li><span>Export scratch</span><span>{formatBytes(breakdown.exports)}</span></li>
                <li className="storage-breakdown-total">
                  <span>Frees</span><span>{formatBytes(breakdown.total)}</span>
                </li>
              </ul>
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => setConfirming(false)} disabled={clearing}>
                Cancel
              </button>
              <button type="button" className="is-danger" onClick={onClear} disabled={clearing}>
                {clearing ? 'Clearing…' : 'Clear everything'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
