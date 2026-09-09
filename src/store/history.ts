import type { EditorDoc, EditorState, HistoryEntry } from '../types/editor';

export const HISTORY_LIMIT = 100;

/** Everything undoable. Session state (playhead, selection, viewport…) stays out. */
export function docSnapshot(state: EditorState): EditorDoc {
  return {
    settings: state.settings,
    exportSettings: state.exportSettings,
    tracks: state.tracks,
    clips: state.clips,
    libraryOrder: state.libraryOrder,
    textLibrary: state.textLibrary,
  };
}

export function docEquals(a: EditorDoc, b: EditorDoc): boolean {
  return (
    a.settings === b.settings &&
    a.exportSettings === b.exportSettings &&
    a.tracks === b.tracks &&
    a.clips === b.clips &&
    a.libraryOrder === b.libraryOrder &&
    a.textLibrary === b.textLibrary
  );
}

export function pushEntry(past: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [...past, entry];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/** Selection survives undo only for clips that still exist. */
export function pruneSelection(selected: string[], doc: EditorDoc): string[] {
  const ids = new Set(doc.clips.map((c) => c.id));
  return selected.filter((id) => ids.has(id));
}
