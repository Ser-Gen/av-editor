/**
 * Keeping the open project on disk, and putting it back on the next visit.
 *
 * Three timing decisions, each one load-bearing:
 *
 *   - **Restore before subscribing.** An empty store saved over a good project would be a
 *     spectacular way to lose someone's work in the first 200 ms of a page load.
 *   - **Debounced on the document, not on every `set`.** Playhead, selection and viewport
 *     churn constantly and none of them are saved; `docEquals` is the same identity check
 *     the undo system uses, so a drag that changes nothing writes nothing.
 *   - **`visibilitychange`, not `beforeunload`.** An OPFS write is async and `beforeunload`
 *     cannot await one, so it is not a save hook at all — it is a way to feel safe while
 *     losing the last edit. `hidden` fires before the tab goes away and is the real
 *     last chance.
 */
import { useEditorStore } from '../store/editorStore';
import { docEquals, docSnapshot } from '../store/history';
import { toProjectFile } from './projectFile';
import { claimProject, loadProject, saveProject } from './projectStore';
import { requestPersistence } from './opfs';
import { onProducedFile } from './saveSignal';

const DEBOUNCE_MS = 800;

let timer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> = Promise.resolve();

/** Serialised: two overlapping writes to one file is exactly what rotation cannot survive. */
function write(): Promise<void> {
  writing = writing
    .catch(() => undefined)
    .then(() => {
      const state = useEditorStore.getState();
      // Checked here rather than only at the subscription, because `flushProject` is called
      // directly too — a read-only tab writing would overwrite the project of the tab that
      // actually owns it, which is the exact loss the claim exists to prevent.
      if (state.readOnly) return;
      return saveProject(toProjectFile(state));
    })
    .catch((e) => console.warn('[project] autosave failed', e));
  return writing;
}

export function flushProject(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  return write();
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void write();
  }, DEBOUNCE_MS);
}

/**
 * Restore, claim, then start saving. Returns a teardown for symmetry; nothing calls it in
 * the app, because the only thing that ends a session is the page going away.
 */
export async function startPersistence(): Promise<() => void> {
  const store = useEditorStore.getState();
  await requestPersistence();

  // Claimed *before* restoring, not after: `restoreProject` decides whether to sweep unused
  // media on the strength of owning the project, so it has to know by then.
  const claim = await claimProject();
  if (!claim.owned) store.setReadOnly(true);

  let loaded = null;
  try {
    loaded = await loadProject();
  } catch (e) {
    console.warn('[project] could not read the saved project', e);
  }
  if (loaded) await useEditorStore.getState().restoreProject(loaded);

  if (!claim.owned) {
    useEditorStore.getState().setLibraryNotice(
      'This project is open in another tab. You can look around, but nothing here is being saved — close the other tab and reload to take over.',
    );
    return () => {};
  }

  let previous = docSnapshot(useEditorStore.getState());
  const unsubscribe = useEditorStore.subscribe((state) => {
    const next = docSnapshot(state);
    if (docEquals(previous, next)) return;
    previous = next;
    schedule();
  });

  // A produced file skips the debounce entirely — see `saveSignal`.
  const unsubscribeProduced = onProducedFile(() => void flushProject());

  const onHidden = () => {
    if (document.visibilityState === 'hidden') void flushProject();
  };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onHidden);

  return () => {
    unsubscribe();
    unsubscribeProduced();
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', onHidden);
    claim.stop();
  };
}
