import { useCallback, useEffect, useRef, useState } from 'react';
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
import { TIMELINE_HEIGHT_KEY } from './project/projectStore';

const MIN_TIMELINE_HEIGHT = 140;

function initialTimelineHeight(): number {
  const stored = Number(localStorage.getItem(TIMELINE_HEIGHT_KEY));
  return Number.isFinite(stored) && stored >= MIN_TIMELINE_HEIGHT ? stored : 280;
}

export default function App() {
  useUrlMediaImport();
  const [textModalOpen, setTextModalOpen] = useState(false);
  const [timelineHeight, setTimelineHeight] = useState(initialTimelineHeight);
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const addTextClip = useEditorStore((s) => s.addTextClip);

  useEffect(() => {
    localStorage.setItem(TIMELINE_HEIGHT_KEY, String(Math.round(timelineHeight)));
  }, [timelineHeight]);

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

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      const next = drag.startHeight - (e.clientY - drag.startY);
      setTimelineHeight(Math.min(window.innerHeight - 220, Math.max(MIN_TIMELINE_HEIGHT, next)));
    };
    const onUp = () => {
      resizeRef.current = null;
      document.body.classList.remove('is-resizing');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
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
        store.removeSelected(e.shiftKey);
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
      <Toolbar onAddText={() => setTextModalOpen(true)} />
      <div className="main-row">
        <MediaLibrary />
        <PreviewPanel />
        <Inspector />
      </div>

      <div
        className="panel-splitter"
        title="Drag to resize the timeline"
        onPointerDown={(e) => {
          e.preventDefault();
          document.body.classList.add('is-resizing');
          resizeRef.current = { startY: e.clientY, startHeight: timelineHeight };
        }}
      />

      <div className="timeline-slot" style={{ height: timelineHeight }}>
        <Timeline />
      </div>

      {textModalOpen && (
        <TextAddModal
          onClose={() => setTextModalOpen(false)}
          onSubmit={(text, template) => addTextClip(text, template)}
        />
      )}
    </div>
  );
}
