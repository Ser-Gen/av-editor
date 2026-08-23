import { useCallback, useRef, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import type { DroppedFile } from '../../store/editorStore';
import { buildSnapTargets, snapValue } from '../../utils/snapping';
import { buildTrackLayout, trackAtY } from './trackLayout';

/** Where a drop would land, in content coordinates, while the pointer is still holding it. */
export interface DropTarget {
  trackId: string;
  /** Snapped, frame-quantized seconds — the same number the drop will use. */
  time: number;
  top: number;
  height: number;
  /** Files being carried, where the browser will say. 0 means it would not. */
  count: number;
  /** A locked lane still shows the indicator, because the *time* is still where it says. */
  locked: boolean;
}

interface ItemWithHandle extends DataTransferItem {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
}

/**
 * Everything a drop carries, read *synchronously*.
 *
 * A `DataTransfer` is only readable during its own event: the first `await` neuters it, and
 * every item after that reads as null. So the files and the handle promises are both taken
 * out in one synchronous pass, and only then awaited.
 */
function collect(dt: DataTransfer): {
  pending: { file: File; handle: Promise<FileSystemHandle | null> | null }[];
  folders: string[];
} {
  const pending: { file: File; handle: Promise<FileSystemHandle | null> | null }[] = [];
  const folders: string[] = [];

  const items = Array.from(dt.items ?? []);
  if (items.some((i) => i.kind === 'file')) {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      // A folder from Finder arrives as an item whose file is unreadable. Naming it is
      // worth more than the empty clip that probing it would produce.
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        folders.push(entry.name);
        continue;
      }
      const file = item.getAsFile();
      if (!file) continue;
      const withHandle = item as ItemWithHandle;
      pending.push({
        file,
        handle: withHandle.getAsFileSystemHandle
          ? withHandle.getAsFileSystemHandle().catch(() => null)
          : null,
      });
    }
    return { pending, folders };
  }

  // Safari and older Firefox expose the list only as `files`, with no handles to be had.
  return { pending: Array.from(dt.files).map((file) => ({ file, handle: null })), folders };
}

function carriesFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files');
}

/**
 * Dropping files from the desktop onto a track at a time.
 *
 * The indicator can only promise the time, not the length: until the drop actually happens
 * the browser will say how many files are coming and what type they are, but not their names
 * or their bytes — so there is no duration to draw a clip-shaped preview from. A line at the
 * drop point and the lane it is over is what is actually known.
 *
 * Snapping is the same as a clip drag, ⌥ and all, but it snaps the *start* only. A clip drag
 * can snap either edge because it knows where its far edge is; here there is nothing yet, and
 * the pointer marks the in-point.
 */
export function useTimelineDrop(viewportRef: React.RefObject<HTMLDivElement | null>) {
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // dragleave fires on every child boundary the pointer crosses, so leaving is counted
  // rather than believed — otherwise the indicator flickers over every clip on the way.
  const depth = useRef(0);
  const countRef = useRef(0);

  const locate = useCallback(
    (clientX: number, clientY: number, altKey: boolean): DropTarget | null => {
      const el = viewportRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const s = useEditorStore.getState();
      const x = clientX - rect.left + s.scrollX;
      const y = clientY - rect.top + s.scrollY;

      const rows = buildTrackLayout(s.tracks);
      const track = trackAtY(rows, y);
      const row = track ? rows.find((r) => r.track.id === track.id) : undefined;
      if (!row) return null;

      const raw = Math.max(0, x / s.pxPerSec);
      const snapped = snapValue(raw, buildSnapTargets(s.clips, [], s.playhead), {
        enabled: s.snapEnabled && !altKey,
        pxPerSec: s.pxPerSec,
        fps: s.settings.fps,
      });
      s.setSnapIndicator(snapped.target);

      return {
        trackId: row.track.id,
        time: snapped.value,
        top: row.top,
        height: row.height,
        count: countRef.current,
        locked: row.track.locked,
      };
    },
    [viewportRef],
  );

  const clear = useCallback(() => {
    depth.current = 0;
    countRef.current = 0;
    setDropTarget(null);
    useEditorStore.getState().setSnapIndicator(null);
  }, []);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth.current += 1;
    if (countRef.current === 0) {
      countRef.current = Array.from(e.dataTransfer.items ?? []).filter(
        (i) => i.kind === 'file',
      ).length;
    }
  }, []);

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      // Without this the browser refuses the drop and navigates to the file instead.
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const next = locate(e.clientX, e.clientY, e.altKey);
      // dragover fires for as long as the pointer is over the lanes, moving or not. Without
      // this the whole timeline re-renders continuously for the length of the drag.
      setDropTarget((prev) =>
        prev && next && prev.trackId === next.trackId && prev.time === next.time ? prev : next,
      );
    },
    [locate],
  );

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      depth.current -= 1;
      if (depth.current <= 0) clear();
    },
    [clear],
  );

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault();
      // Both of these read the event, so both happen before anything is awaited.
      const target = locate(e.clientX, e.clientY, e.altKey);
      const { pending, folders } = collect(e.dataTransfer);
      clear();
      if (!target) return;

      const store = useEditorStore.getState();
      if (pending.length === 0) {
        store.setLibraryNotice(
          folders.length > 0
            ? `Folders cannot be dropped — open ${folders[0]} and drop the files inside.`
            : 'Nothing droppable in that.',
        );
        return;
      }

      const files: DroppedFile[] = await Promise.all(
        pending.map(async ({ file, handle }) => {
          const resolved = await (handle ?? Promise.resolve(null));
          return resolved && resolved.kind === 'file'
            ? { file, handle: resolved as FileSystemFileHandle }
            : { file };
        }),
      );

      await store.dropFilesAt(files, target.trackId, target.time);
      if (folders.length > 0) {
        const notice = useEditorStore.getState().libraryNotice ?? '';
        store.setLibraryNotice(
          `${notice} Skipped ${folders.length} folder(s) — drop the files inside them instead.`.trim(),
        );
      }
    },
    [clear, locate],
  );

  return { dropTarget, onDragEnter, onDragOver, onDragLeave, onDrop };
}
