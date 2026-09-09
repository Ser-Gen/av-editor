import { useCallback, useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { MediaLibrary } from './components/MediaLibrary';
import { PreviewPanel } from './components/PreviewPanel';
import { Inspector } from './components/Inspector';
import { Timeline } from './components/Timeline/Timeline';
import { TextAddModal } from './components/TextAddModal';
import { useUrlMediaImport } from './hooks/useUrlMediaImport';
import { useEditorStore } from './store/editorStore';
// Defined beside the eraser, so "Clear everything" cannot drift out of date with what is
// actually written.
import {
  INSPECTOR_WIDTH_KEY,
  LIBRARY_WIDTH_KEY,
  TIMELINE_HEIGHT_KEY,
} from './project/projectStore';
import { PanelSplitter } from './components/PanelSplitter';
import { clampPanelWidth, clampTimelineHeight } from './utils/panelLayout';

const DEFAULT_LIBRARY_WIDTH = 220;
const DEFAULT_INSPECTOR_WIDTH = 280;

/** A stored size that is missing, corrupt or now impossible falls back to the default. */
function storedSize(key: string, fallback: number, clamp: (px: number) => number): number {
  const raw = Number(localStorage.getItem(key));
  return Number.isFinite(raw) && raw > 0 ? clamp(raw) : fallback;
}

export default function App() {
  useUrlMediaImport();
  const [textModalOpen, setTextModalOpen] = useState(false);
  const addTextClip = useEditorStore((s) => s.addTextClip);

  // Clamped against the window, not stored blindly: a layout saved on a 32-inch display must
  // not open on a laptop with both sidebars wider than the screen and no preview between them.
  const clampWidth = useCallback((px: number) => clampPanelWidth(px, window.innerWidth), []);
  const clampHeight = useCallback((px: number) => clampTimelineHeight(px, window.innerHeight), []);

  const [timelineHeight, setTimelineHeight] = useState(() =>
    storedSize(TIMELINE_HEIGHT_KEY, 280, (px) => clampTimelineHeight(px, window.innerHeight)),
  );
  const [libraryWidth, setLibraryWidth] = useState(() =>
    storedSize(LIBRARY_WIDTH_KEY, DEFAULT_LIBRARY_WIDTH, (px) => clampPanelWidth(px, window.innerWidth)),
  );
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    storedSize(INSPECTOR_WIDTH_KEY, DEFAULT_INSPECTOR_WIDTH, (px) => clampPanelWidth(px, window.innerWidth)),
  );

  useEffect(() => {
    localStorage.setItem(TIMELINE_HEIGHT_KEY, String(Math.round(timelineHeight)));
  }, [timelineHeight]);
  useEffect(() => {
    localStorage.setItem(LIBRARY_WIDTH_KEY, String(Math.round(libraryWidth)));
  }, [libraryWidth]);
  useEffect(() => {
    localStorage.setItem(INSPECTOR_WIDTH_KEY, String(Math.round(inspectorWidth)));
  }, [inspectorWidth]);

  // A window that shrinks can make a stored width illegal; re-clamping is cheaper than
  // discovering it as a preview squeezed to nothing.
  useEffect(() => {
    const onResize = () => {
      setLibraryWidth((w) => clampPanelWidth(w, window.innerWidth));
      setInspectorWidth((w) => clampPanelWidth(w, window.innerWidth));
      setTimelineHeight((h) => clampTimelineHeight(h, window.innerHeight));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /*
   * A file dropped anywhere the app does not handle would otherwise make the browser leave
   * the page and open it. The timeline's handlers sit closer to the target and run first,
   * so `defaultPrevented` is how this tells "already placed" from "landed nowhere" — and
   * landing nowhere is worth a word, since the alternative is a drag that silently does
   * nothing at all.
   */
  useEffect(() => {
    // Required on dragover or the drop event never fires, here or on the timeline.
    const allow = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
    };
    const stray = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
      e.preventDefault();
      useEditorStore
        .getState()
        .setLibraryNotice('Drop media onto a timeline track to place it there.');
    };
    window.addEventListener('dragover', allow);
    window.addEventListener('drop', stray);
    return () => {
      window.removeEventListener('dragover', allow);
      window.removeEventListener('drop', stray);
    };
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable
    ) {
      return;
    }

    const store = useEditorStore.getState();
    const mod = e.metaKey || e.ctrlKey;
    const frame = 1 / store.settings.fps;

    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if (mod && e.code === 'KeyY') {
      e.preventDefault();
      store.redo();
      return;
    }
    if (mod && e.code === 'KeyA') {
      e.preventDefault();
      store.selectAll();
      return;
    }
    if (mod && e.code === 'KeyD') {
      e.preventDefault();
      store.duplicateSelected();
      return;
    }
    if (mod && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
      e.preventDefault();
      store.zoomAt(1.3, store.viewportWidth / 2);
      return;
    }
    if (mod && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
      e.preventDefault();
      store.zoomAt(1 / 1.3, store.viewportWidth / 2);
      return;
    }

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        store.setPlaying(!store.isPlaying);
        break;
      case 'KeyS':
        e.preventDefault();
        store.splitSelectedAtPlayhead();
        break;
      case 'KeyN':
        store.toggleSnap();
        break;
      case 'KeyZ':
        if (e.shiftKey) store.zoomToFit();
        else store.zoomToSelection();
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        // ⇧ still forces a ripple; without it the mode decides.
        store.removeSelected(e.shiftKey || store.rippleEnabled);
        break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        const direction = e.code === 'ArrowRight' ? 1 : -1;
        if (store.selectedClipIds.length > 0) {
          store.nudgeSelected(direction * (e.shiftKey ? store.settings.fps : 1));
        } else {
          store.setPlaying(false);
          store.setPlayhead(store.playhead + direction * (e.shiftKey ? 1 : frame));
        }
        break;
      }
      case 'Comma':
      case 'Period': {
        e.preventDefault();
        const direction = e.code === 'Period' ? 1 : -1;
        store.setPlaying(false);
        store.setPlayhead(store.playhead + direction * (e.shiftKey ? 1 : frame));
        break;
      }
      case 'BracketLeft':
      case 'BracketRight':
        // Jump between the selected clip's keyframes.
        e.preventDefault();
        store.setPlaying(false);
        store.jumpToKeyframe(e.code === 'BracketRight' ? 1 : -1);
        break;
      case 'Home':
        e.preventDefault();
        store.setPlaying(false);
        store.setPlayhead(0);
        break;
      case 'End':
        e.preventDefault();
        store.setPlaying(false);
        store.setPlayhead(store.getProjectDuration());
        break;
      default:
        break;
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  return (
    <div className="app">
      <Toolbar />
      <div className="main-row">
        <MediaLibrary width={libraryWidth} onAddText={() => setTextModalOpen(true)} />
        <PanelSplitter
          axis="x"
          size={libraryWidth}
          clamp={clampWidth}
          onChange={setLibraryWidth}
          resetTo={DEFAULT_LIBRARY_WIDTH}
          title="Drag to resize the library — double-click to reset"
        />
        <PreviewPanel />
        <PanelSplitter
          axis="x"
          size={inspectorWidth}
          invert
          clamp={clampWidth}
          onChange={setInspectorWidth}
          resetTo={DEFAULT_INSPECTOR_WIDTH}
          title="Drag to resize the inspector — double-click to reset"
        />
        <Inspector width={inspectorWidth} />
      </div>

      <PanelSplitter
        axis="y"
        size={timelineHeight}
        invert
        clamp={clampHeight}
        onChange={setTimelineHeight}
        title="Drag to resize the timeline"
      />

      <div className="timeline-slot" style={{ height: timelineHeight }}>
        <Timeline />
      </div>

      {textModalOpen && (
        <TextAddModal
          onClose={() => setTextModalOpen(false)}
          onSubmit={(text, template, keepInLibrary) => {
            if (keepInLibrary) {
              const editor = useEditorStore.getState();
              const id = editor.addTextObject(text, template);
              editor.addTextObjectToTimeline(id);
            } else {
              addTextClip(text, template);
            }
          }}
        />
      )}
    </div>
  );
}
