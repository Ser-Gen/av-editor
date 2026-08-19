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
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
