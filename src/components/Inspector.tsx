import { useEffect, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { clipDuration, formatTimecode } from '../utils/time';
import type { OverlayTransform, TextTemplate, TransitionType } from '../types/editor';
import {
  DEFAULT_OVERLAY_TRANSFORM,
  normalizeOverlayTransform,
  textFrameForClip,
} from '../utils/overlayTransform';
import { TRANSFORM_CHANNELS, maxFade, sourceTimeAt, transformAt } from '../utils/clipRender';
import { TRANSITION_LABELS, incomingTransition } from '../utils/transitions';
import { EffectStack } from './EffectStack';
import { ProcessDialog } from './ProcessDialog';
import { BakeDialog } from './BakeDialog';
import { MediaOverlayEditor } from './MediaOverlayEditor';
import { TextPlacementEditor } from './TextPlacementEditor';
import { PanelTabs } from './PanelTabs';
import type { PanelTab } from './PanelTabs';
import { resolveTab } from '../utils/panelLayout';
import { INSPECTOR_TAB_KEY } from '../project/projectStore';

type InspectorTab = 'clip' | 'placement' | 'effects';

const TAB_LABEL: Record<InspectorTab, string> = {
  clip: 'Clip',
  placement: 'Placement',
  effects: 'Effects',
};

export function Inspector({ width }: { width: number }) {
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds);
  const clips = useEditorStore((s) => s.clips);
  const tracks = useEditorStore((s) => s.tracks);
  const mediaLibrary = useEditorStore((s) => s.mediaLibrary);
  const fps = useEditorStore((s) => s.settings.fps);
  const updateVideoFlags = useEditorStore((s) => s.updateVideoFlags);
  const updateClipTransform = useEditorStore((s) => s.updateClipTransform);
  const updateTextClip = useEditorStore((s) => s.updateTextClip);
  const setClipGain = useEditorStore((s) => s.setClipGain);
  const setClipFade = useEditorStore((s) => s.setClipFade);
  const detachAudio = useEditorStore((s) => s.detachAudio);
  const toggleChannelArmed = useEditorStore((s) => s.toggleChannelArmed);
  const playhead = useEditorStore((s) => s.playhead);
  const setTransitionType = useEditorStore((s) => s.setTransitionType);
  const processJob = useEditorStore((s) => s.processJob);
  const [processOpen, setProcessOpen] = useState(false);
  const [bakeOpen, setBakeOpen] = useState(false);
  const [wantedTab, setWantedTab] = useState<InspectorTab>(
    () => (localStorage.getItem(INSPECTOR_TAB_KEY) as InspectorTab) ?? 'clip',
  );
  // The *wanted* tab is remembered, not the resolved one: selecting an audio clip falls back
  // to Clip for as long as it is selected, and selecting a video clip again returns to
  // Placement rather than making you find it a second time.
  useEffect(() => {
    localStorage.setItem(INSPECTOR_TAB_KEY, wantedTab);
  }, [wantedTab]);

  if (selectedClipIds.length > 1) {
    return (
      <aside className="inspector" style={{ width }}>
        <h3>Inspector</h3>
        <p className="hint">{selectedClipIds.length} clips selected.</p>
        <p className="hint">
          Drag to move them together, ⌫ to delete, ⇧⌫ to ripple delete, arrows to nudge.
        </p>
      </aside>
    );
  }

  const clip = clips.find((c) => c.id === selectedClipIds[0]);

  if (!clip) {
    return (
      <aside className="inspector" style={{ width }}>
        <h3>Inspector</h3>
        <p className="hint">Select a clip to edit its properties.</p>
      </aside>
    );
  }

  const track = tracks.find((t) => t.id === clip.trackId);
  const transition = incomingTransition(clip, clips);
  const asset = 'assetId' in clip ? mediaLibrary[clip.assetId] : undefined;
  const duration = clipDuration(clip);
  const hasTransform = (clip.kind === 'video' || clip.kind === 'image') && !!clip.transform;
  const placementAnimated = TRANSFORM_CHANNELS.some(
    (ch) => (clip.transformKeyframes?.[ch]?.length ?? 0) > 0,
  );
  // With placement animated the editor shows the rectangle at the playhead, so dragging
  // it edits the pose you are actually looking at.
  const editedTransform =
    clip.kind === 'video' || clip.kind === 'image' ? transformAt(clip, playhead) : undefined;

  // A tab is offered only when this clip has something to put in it. An audio clip has no
  // placement and no effect chain, so it gets no tab strip at all rather than two dead ends.
  const canPlace = clip.kind === 'video' || clip.kind === 'image' || clip.kind === 'text';
  const canEffect = clip.kind !== 'audio' || track?.kind === 'video';
  const available: InspectorTab[] = [
    'clip',
    ...(canPlace ? (['placement'] as const) : []),
    ...(canEffect ? (['effects'] as const) : []),
  ];
  const tab = resolveTab(available, wantedTab) ?? 'clip';
  const tabs: PanelTab<InspectorTab>[] = available.map((id) => ({ id, label: TAB_LABEL[id] }));

  return (
    <aside className="inspector" style={{ width }}>
      <h3>Inspector</h3>

      <div className="inspector-summary">
        <span className="inspector-kind">{clip.kind}</span>
        <span>{track?.label}</span>
      </div>

      <PanelTabs tabs={tabs} active={tab} onSelect={setWantedTab} />
      <dl className="inspector-facts">
        <div>
          <dt>Start</dt>
          <dd>{formatTimecode(clip.timelineStart, fps)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatTimecode(duration, fps)}</dd>
        </div>
        {asset?.width && (
          <div>
            <dt>Source</dt>
            <dd>
              {asset.width}×{asset.height}
            </dd>
          </div>
        )}
      </dl>

      {tab === 'placement' && (clip.kind === 'video' || clip.kind === 'image') && (
        <section className="inspector-section">
          <label>Placement</label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={hasTransform}
              onChange={(e) =>
                updateClipTransform(
                  clip.id,
                  e.target.checked
                    ? normalizeOverlayTransform(DEFAULT_OVERLAY_TRANSFORM)
                    : undefined,
                )
              }
            />
            Custom placement (crop / picture-in-picture)
          </label>
          <p className="hint">
            {hasTransform
              ? 'Layer order comes from the track stack — move the clip to a higher track to put it in front.'
              : 'Filling the frame. Higher tracks draw over lower ones.'}
          </p>
          {hasTransform && clip.transform && (
            <label className="checkbox">
              <button
                type="button"
                className={`stopwatch${placementAnimated ? ' is-armed' : ''}`}
                title="Animate placement: moving the box writes a keyframe at the playhead"
                onClick={() => {
                  // One toggle arms all eight channels, because a travelling
                  // picture-in-picture is only ever wanted as a whole rectangle.
                  for (const channel of TRANSFORM_CHANNELS) {
                    toggleChannelArmed(clip.id, { effectId: null, param: channel });
                  }
                }}
              >
                ⏱
              </button>
              Animate placement
            </label>
          )}
          {hasTransform && clip.transform && asset?.blobUrl && (
            <MediaOverlayEditor
              mediaKind={clip.kind === 'video' ? 'video' : 'image'}
              blobUrl={asset.blobUrl}
              sourceWidth={asset.width ?? 1920}
              sourceHeight={asset.height ?? 1080}
              transform={editedTransform ?? clip.transform}
              sourceTime={sourceTimeAt(clip, playhead, 1 / 60)}
              onChange={(transform: OverlayTransform) => updateClipTransform(clip.id, transform)}
            />
          )}
        </section>
      )}

      {tab === 'clip' && (
      <section className="inspector-section">
        <label>Fade</label>
        <div className="slider-row">
          <span className="effect-param-label">In</span>
          <input
            type="range"
            min={0}
            max={maxFade(clip, 'in')}
            step={1 / fps}
            value={clip.fadeIn ?? 0}
            onChange={(e) => setClipFade(clip.id, 'in', Number(e.target.value))}
          />
          <span>{formatTimecode(clip.fadeIn ?? 0, fps)}</span>
        </div>
        <div className="slider-row">
          <span className="effect-param-label">Out</span>
          <input
            type="range"
            min={0}
            max={maxFade(clip, 'out')}
            step={1 / fps}
            value={clip.fadeOut ?? 0}
            onChange={(e) => setClipFade(clip.id, 'out', Number(e.target.value))}
          />
          <span>{formatTimecode(clip.fadeOut ?? 0, fps)}</span>
        </div>
        <p className="hint">
          {clip.kind === 'audio'
            ? 'Fades to silence.'
            : 'Or drag the triangles in the clip’s top corners.'}
        </p>
      </section>
      )}

      {tab === 'clip' && transition && (
        <section className="inspector-section">
          <label>Transition in</label>
          <select
            value={clip.transitionIn ?? 'dissolve'}
            onChange={(e) => setTransitionType(clip.id, e.target.value as TransitionType)}
          >
            {Object.entries(TRANSITION_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
          <p className="hint">
            {formatTimecode(transition.end - transition.start, fps)} overlap with the previous
            clip. Drag either clip to change it; pull them apart to remove it.
          </p>
        </section>
      )}

      {tab === 'effects' && clip.kind !== 'audio' && (
        <EffectStack
          target={clip.id}
          effects={clip.effects ?? []}
          clipStart={clip.timelineStart}
          label={clip.kind === 'adjustment' ? 'Adjustment effects' : 'Effects'}
        />
      )}

      {tab === 'effects' && track?.kind === 'video' && (
        <EffectStack
          target={{ kind: 'track', id: track.id }}
          effects={track.effects ?? []}
          label={`Grade on ${track.label}`}
        />
      )}
      {tab === 'effects' && track?.kind === 'video' && (track.effects?.length ?? 0) > 0 && (
        <p className="hint">
          A track grade applies to everything composited up to and including {track.label} —
          tracks above it are unaffected. Hiding the track disables it.
        </p>
      )}

      {tab === 'clip' && clip.kind === 'video' && (
        <section className="inspector-section">
          <label>Audio</label>
          {clip.hasAudio ? (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={clip.audioEnabled}
                  onChange={(e) => updateVideoFlags(clip.id, { audioEnabled: e.target.checked })}
                />
                Audio on
              </label>
              <div className="slider-row">
                <input
                  type="range"
                  min={0}
                  max={150}
                  value={Math.round(clip.gain * 100)}
                  disabled={!clip.audioEnabled}
                  onChange={(e) => setClipGain(clip.id, Number(e.target.value) / 100)}
                />
                <span>{Math.round(clip.gain * 100)}%</span>
              </div>
              <button
                type="button"
                disabled={!clip.audioEnabled}
                title="Move this clip's audio onto its own audio track"
                onClick={() => detachAudio(clip.id)}
              >
                Detach audio
              </button>
            </>
          ) : (
            <p className="hint">This file has no audio track.</p>
          )}
        </section>
      )}

      {tab === 'clip' && clip.kind === 'video' && (
        <section className="inspector-section">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={clip.hideVideo}
              onChange={(e) => updateVideoFlags(clip.id, { hideVideo: e.target.checked })}
            />
            Hide video
          </label>
        </section>
      )}

      {tab === 'clip' && clip.kind === 'video' && asset && (
        <section className="inspector-section">
          <label>Process</label>
          <button
            type="button"
            disabled={processJob !== null}
            title="Run an FFmpeg preset over this clip's excerpt"
            onClick={() => setProcessOpen(true)}
          >
            Run a preset…
          </button>
          <p className="hint">
            Stabilize, deshake, interpolate, reverse — the things FFmpeg can do and the
            renderer cannot — over just this clip's {duration.toFixed(1)}s, not the whole file.
          </p>
          <button
            type="button"
            disabled={processJob !== null}
            title="Render this clip's effect chain into a new file on the GPU"
            onClick={() => setBakeOpen(true)}
          >
            Bake effects…
          </button>
          <p className="hint">
            Renders the effects above through the compositor and the hardware encoder — the fast
            path, and the same picture the preview shows.
          </p>
          {processOpen && (
            <ProcessDialog
              assetId={clip.assetId}
              clipId={clip.id}
              onClose={() => setProcessOpen(false)}
            />
          )}
          {bakeOpen && <BakeDialog clipId={clip.id} onClose={() => setBakeOpen(false)} />}
        </section>
      )}

      {tab === 'clip' && clip.kind === 'audio' && (
        <section className="inspector-section">
          <label>Volume</label>
          <div className="slider-row">
            <input
              type="range"
              min={0}
              max={150}
              value={Math.round(clip.gain * 100)}
              onChange={(e) => setClipGain(clip.id, Number(e.target.value) / 100)}
            />
            <span>{Math.round(clip.gain * 100)}%</span>
          </div>
          <p className="hint">Multiplied by the {track?.label} track volume.</p>
        </section>
      )}

      {tab === 'clip' && clip.kind === 'text' && (
        <section className="inspector-section">
          <label>Text</label>
          <textarea
            rows={3}
            value={clip.text}
            onChange={(e) => updateTextClip(clip.id, e.target.value, clip.template)}
          />
          <label>Template</label>
          <select
            value={clip.template}
            onChange={(e) => updateTextClip(clip.id, clip.text, e.target.value as TextTemplate)}
          >
            <option value="lowerThird">Lower third</option>
            <option value="centerTitle">Center title</option>
            <option value="subtitle">Subtitle</option>
          </select>
        </section>
      )}

      {/* A text box is placed on the canvas like any overlay, so it belongs to the same tab. */}
      {tab === 'placement' && clip.kind === 'text' && (
        <section className="inspector-section">
          <label>Text box on screen</label>
          <TextPlacementEditor
            text={clip.text}
            template={clip.template}
            textFrame={textFrameForClip(clip.textFrame)}
            onChange={(textFrame) => updateTextClip(clip.id, clip.text, clip.template, textFrame)}
          />
        </section>
      )}
    </aside>
  );
}
