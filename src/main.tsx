import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { useEditorStore } from './store/editorStore';
import { setForceCanvas2D } from './render/GLCompositor';
import { EFFECTS } from './render/effects/registry';
import { evaluateChannel } from './utils/keyframes';
import { allTransitions } from './utils/transitions';
import { CaptureSession } from './capture/CaptureSession';
import { chooseEngine, webCodecsCaptureSupport } from './capture/engine';
import { finalizeRecording, findOrphans, recoverRecording } from './capture/recovery';
import { readAllMeta } from './capture/recordingStore';
import { startPersistence, flushProject } from './project/autosave';
import { clearEverything, loadProject, storageBreakdown } from './project/projectStore';
import { listMedia } from './project/mediaStore';

if (import.meta.env.DEV) {
  // Dev-only handles for debugging and browser-driven checks.
  const w = window as unknown as Record<string, unknown>;
  w.__store = useEditorStore;
  w.__setForceCanvas2D = setForceCanvas2D;
  w.__effects = EFFECTS;
  w.__evaluateChannel = evaluateChannel;
  w.__transitions = allTransitions;
  // Capture: tests drive a session with synthetic streams, so the picker never opens and
  // the alignment and container work is what actually gets exercised.
  w.__capture = {
    CaptureSession,
    finalizeRecording,
    findOrphans,
    recoverRecording,
    readAllMeta,
    chooseEngine,
    webCodecsCaptureSupport,
  };
  w.__project = {
    flushProject,
    loadProject,
    storageBreakdown,
    clearEverything,
    /**
     * What the project believes it has against what is actually on disk. The two symptoms
     * that matter both show up here: `orphaned` is bytes nothing references (work that was
     * never saved), and `missing` is references with no bytes (a clip that will say
     * "offline" about a file that was never anywhere else).
     */
    async diagnose() {
      const state = useEditorStore.getState();
      const assets = Object.values(state.mediaLibrary);
      const onDisk = new Set(await listMedia());
      const referenced = new Set(
        assets.filter((a) => a.origin === 'derived' && a.opfsName).map((a) => a.opfsName as string),
      );
      return {
        assets: assets.map((a) => ({
          name: a.name,
          origin: a.origin,
          opfsName: a.opfsName ?? null,
          online: !!a.file,
        })),
        onDisk: [...onDisk],
        missing: [...referenced].filter((n) => !onDisk.has(n)),
        orphaned: [...onDisk].filter((n) => !referenced.has(n)),
        readOnly: state.readOnly,
        saved: await loadProject(),
      };
    },
  };
}

// Restore the saved project, then keep it saved. Started before the first render so the
// timeline appears already populated rather than visibly filling in.
void startPersistence();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
