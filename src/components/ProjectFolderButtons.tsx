/**
 * Save a copy of the project to a folder, and open one back.
 *
 * Two buttons and no state to speak of, because the design deliberately has no live link:
 * this writes a folder or reads one, and that is the whole feature. Everything the API makes
 * hard — watching, rescanning, permission on every load — comes from *keeping* a link, which
 * is exactly what is not being done here.
 *
 * Outside Chromium there is no directory picker at all, so the same button downloads the
 * project JSON alone and says plainly that the media is not in it. A half-working button
 * that silently omits the media would be worse than an honest one.
 */
import { useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { toProjectFile } from '../project/projectFile';
import {
  folderPickerAvailable,
  pickProjectFolder,
  readBundle,
  writeBundle,
} from '../project/folderBundle';
import { flushProject } from '../project/autosave';
import type { MediaAsset } from '../types/editor';

export function ProjectFolderButtons() {
  const [busy, setBusy] = useState<string | null>(null);
  const setLibraryNotice = useEditorStore((s) => s.setLibraryNotice);
  const restoreProject = useEditorStore((s) => s.restoreProject);
  const available = folderPickerAvailable();

  const saveCopy = async () => {
    const state = useEditorStore.getState();
    if (state.libraryOrder.length === 0 && state.clips.length === 0) {
      setLibraryNotice('There is nothing to save yet.');
      return;
    }
    if (!available) {
      const blob = new Blob([JSON.stringify(toProjectFile(state))], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'project.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setLibraryNotice(
        'Saved project.json. This browser has no folder picker, so the media is not included — the timeline will reopen with its files offline.',
      );
      return;
    }

    const dir = await pickProjectFolder('readwrite');
    if (!dir) return;
    setBusy('Saving…');
    try {
      const assets = state.libraryOrder
        .map((id) => state.mediaLibrary[id])
        .filter((a): a is MediaAsset => !!a);
      const result = await writeBundle(dir, toProjectFile(state), assets, (done, total) =>
        setBusy(`Saving ${done} of ${total}…`),
      );
      setLibraryNotice(
        result.skipped.length === 0
          ? `Saved a copy: ${result.written} file(s) plus the project.`
          : `Saved a copy: ${result.written} file(s). ${result.skipped.length} were offline and could not be included.`,
      );
    } catch (e) {
      setLibraryNotice(`Could not save a copy: ${e instanceof Error ? e.message : 'failed'}.`);
    } finally {
      setBusy(null);
    }
  };

  const openCopy = async () => {
    const dir = await pickProjectFolder('read');
    if (!dir) return;
    setBusy('Opening…');
    try {
      const bundle = await readBundle(dir);
      if (!bundle) {
        setLibraryNotice('That folder does not contain a project.json this app can read.');
        return;
      }
      // The folder's own bytes are handed straight in, so nothing is offline and nothing was
      // copied: the session reads out of the folder the user just pointed at.
      await restoreProject(bundle.loaded, bundle.files);
      // The opened project is now the autosaved one; write it through immediately so a
      // refresh does not silently reopen whatever was there before.
      await flushProject();
      const missing = bundle.loaded.assets.filter((a) => !bundle.files.has(a.id)).length;
      setLibraryNotice(
        missing === 0
          ? 'Opened the project from that folder.'
          : `Opened the project. ${missing} file(s) were not in the folder and are offline.`,
      );
    } catch (e) {
      setLibraryNotice(`Could not open that folder: ${e instanceof Error ? e.message : 'failed'}.`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="project-folder">
      <button type="button" onClick={() => void saveCopy()} disabled={!!busy}>
        {busy ?? 'Save a copy…'}
      </button>
      {available && (
        <button type="button" onClick={() => void openCopy()} disabled={!!busy}>
          Open a copy…
        </button>
      )}
    </div>
  );
}
