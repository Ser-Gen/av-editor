import { useCallback, useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { MediaLibrary } from './components/MediaLibrary';
import { PreviewPanel } from './components/PreviewPanel';
import { Inspector } from './components/Inspector';
import { Timeline } from './components/Timeline/Timeline';
import { TextAddModal } from './components/TextAddModal';
import { useUrlMediaImport } from './hooks/useUrlMediaImport';
import { useEditorStore } from './store/editorStore';

export default function App() {
  useUrlMediaImport();
  const [textModalOpen, setTextModalOpen] = useState(false);
  const addTextClip = useEditorStore((s) => s.addTextClip);
  const removeSelectedClip = useEditorStore((s) => s.removeSelectedClip);
  const duplicateSelectedClip = useEditorStore((s) => s.duplicateSelectedClip);
  const splitSelectedAtPlayhead = useEditorStore((s) => s.splitSelectedAtPlayhead);
  const setPlaying = useEditorStore((s) => s.setPlaying);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying(!useEditorStore.getState().isPlaying);
      }
      if (e.code === 'KeyS') {
        e.preventDefault();
        splitSelectedAtPlayhead();
      }
      if (e.code === 'Delete' || e.code === 'Backspace') {
        removeSelectedClip();
      }
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyD') {
        e.preventDefault();
        duplicateSelectedClip();
      }
    },
    [setPlaying, splitSelectedAtPlayhead, removeSelectedClip, duplicateSelectedClip],
  );

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
      <Timeline />
      {textModalOpen && (
        <TextAddModal
          onClose={() => setTextModalOpen(false)}
          onSubmit={(text, template) => addTextClip(text, template)}
        />
      )}
    </div>
  );
}
