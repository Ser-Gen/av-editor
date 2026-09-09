import { useEffect, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import { AudioSection } from './AudioSection';
import { TextStyleSection } from './TextStyleSection';
import { SPEED_MAX, SPEED_MIN, clipDuration, formatTimecode } from '../utils/time';
import { SPEED_PRESETS, canRetime, formatSpeed } from '../utils/retime';
import type { OverlayTransform, TransitionType } from '../types/editor';
import {
  DEFAULT_OVERLAY_TRANSFORM,
  normalizeOverlayTransform,
  textFrameForClip,
} from '../utils/overlayTransform';
import {
  TRANSFORM_CHANNELS,
  acceptsTransform,
  clipSpeedOf,
  maxFade,
  sourceTimeAt,
  transformAt,
} from '../utils/clipRender';
import { placementForShapes } from '../utils/annotationEdit';
import { MAX_CLIP_GAIN } from '../utils/trackVolume';
import { DEFAULT_LOUDNESS_TARGET } from '../utils/loudness';
import { sortedKeys } from '../utils/annotationAnim';
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
  const normalizeSelected = useEditorStore((s) => s.normalizeSelected);
  const loudnessJob = useEditorStore((s) => s.loudnessJob);
  const setClipFade = useEditorStore((s) => s.setClipFade);
  const detachAudio = useEditorStore((s) => s.detachAudio);
  const toggleChannelArmed = useEditorStore((s) => s.toggleChannelArmed);
  const playhead = useEditorStore((s) => s.playhead);
  const setTransitionType = useEditorStore((s) => s.setTransitionType);
  const processJob = useEditorStore((s) => s.processJob);
  const removeAnnotationShape = useEditorStore((s) => s.removeAnnotationShape);
  const clearAnnotationShapeKeys = useEditorStore((s) => s.clearAnnotationShapeKeys);
  const removeAnnotationShapeKey = useEditorStore((s) => s.removeAnnotationShapeKey);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setClipSpeed = useEditorStore((s) => s.setClipSpeed);
  const setClipPitchFollows = useEditorStore((s) => s.setClipPitchFollows);
  const updateAnnotationShape = useEditorStore((s) => s.updateAnnotationShape);
  const selectedShapeId = useEditorStore((s) => s.selectedShapeId);
  const selectShape = useEditorStore((s) => s.selectShape);
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
    /*
     * Multi-selection used to be a dead end: a count and a sentence about dragging. But
     * *matching* loudness is a multi-clip operation by definition — one clip has nothing to
     * match — and the only button for it lived in the single-clip Audio section, where a
     * selection of three could never reach it. Anything that means something for a set of
     * clips belongs here; anything that needs one clip stays where it was.
     */
    const audible = clips.filter(
      (c) =>
        selectedClipIds.includes(c.id) &&
        (c.kind === 'audio' || (c.kind === 'video' && c.hasAudio && c.audioEnabled)),
    );
    return (
      <aside className="inspector" style={{ width }}>
        <h3>Inspector</h3>
        <p className="hint">{selectedClipIds.length} clips selected.</p>
        <p className="hint">
          Drag to move them together, ⌫ to delete, ⇧⌫ to ripple delete, arrows to nudge.
        </p>
        {audible.length > 1 && (
          <section className="inspector-section">
            <label>Loudness</label>
            <p className="hint">
              {audible.length} of them carry sound. Matching measures each one and sets its gain
              so they all land on {DEFAULT_LOUDNESS_TARGET} LUFS — a quiet take and a loud one
              sit at the same level across the cut. Only the gain changes; nothing is
              re-encoded.
            </p>
            <div className="inspector-row">
              <button
                type="button"
                disabled={loudnessJob !== null}
                onClick={() => void normalizeSelected(DEFAULT_LOUDNESS_TARGET)}
              >
                {loudnessJob !== null ? 'Measuring…' : `Match ${audible.length} clips`}
              </button>
            </div>
          </section>
        )}
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
  const selectedShape =
    clip.kind === 'annotation' ? clip.shapes.find((sh) => sh.id === selectedShapeId) : undefined;
  const transition = incomingTransition(clip, clips);
  const asset = 'assetId' in clip ? mediaLibrary[clip.assetId] : undefined;
  const duration = clipDuration(clip);
  const speed = clipSpeedOf(clip);
  // The same question the store's writer asks, asked once here: a tab that offers a
  // placement the store will not store is worse than no tab.
  const placeable = acceptsTransform(clip);
  const hasTransform = placeable && !!clip.transform;
  const placementAnimated = TRANSFORM_CHANNELS.some(
    (ch) => (clip.transformKeyframes?.[ch]?.length ?? 0) > 0,
  );
  // With placement animated the editor shows the rectangle at the playhead, so dragging
  // it edits the pose you are actually looking at.
  const editedTransform = placeable ? transformAt(clip, playhead) : undefined;

  // A tab is offered only when this clip has something to put in it. An audio clip has no
  // placement and no effect chain, so it gets no tab strip at all rather than two dead ends.
  const canPlace = placeable || clip.kind === 'text';
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
        /* Media only: the editor below shows the source under the rectangle, and an
           annotation has no source to show — its section is the next one. */
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

      {tab === 'placement' && clip.kind === 'annotation' && (
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
                    ? normalizeOverlayTransform(
                        // The marks' own box, as both crop and frame: an identity mapping, so
                        // ticking this moves nothing and what changes is what the frame means.
                        placementForShapes(clip.shapes) ?? DEFAULT_OVERLAY_TRANSFORM,
                      )
                    : undefined,
                )
              }
            />
            Place the marks in a frame
          </label>
          <p className="hint">
            {hasTransform
              ? 'Drag the marks on the preview with the Select tool to move them together. They scale with the frame, so the strokes stay in proportion.'
              : 'Filling the frame. Turn this on to move or scale the whole set of marks — and to animate them.'}
          </p>
          {hasTransform && clip.transform && (
            <>
              <label className="checkbox">
                <button
                  type="button"
                  className={`stopwatch${placementAnimated ? ' is-armed' : ''}`}
                  title="Animate placement: moving the frame writes a keyframe at the playhead"
                  onClick={() => {
                    for (const channel of TRANSFORM_CHANNELS) {
                      toggleChannelArmed(clip.id, { effectId: null, param: channel });
                    }
                  }}
                >
                  ⏱
                </button>
                Animate placement
              </label>
              <FrameFields
                frame={normalizeOverlayTransform(editedTransform ?? clip.transform).frame}
                onChange={(frame) =>
                  updateClipTransform(clip.id, {
                    ...normalizeOverlayTransform(editedTransform ?? clip.transform),
                    frame,
                  })
                }
              />
              {placementAnimated && (
                <p className="hint">
                  Armed: every change here writes the whole rectangle as keys at the playhead.
                  The FFmpeg fallback freezes the animation at the clip's midpoint and says so.
                </p>
              )}
            </>
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
                  max={MAX_CLIP_GAIN * 100}
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
              max={MAX_CLIP_GAIN * 100}
              value={Math.round(clip.gain * 100)}
              onChange={(e) => setClipGain(clip.id, Number(e.target.value) / 100)}
            />
            <span>{Math.round(clip.gain * 100)}%</span>
          </div>
          <p className="hint">Multiplied by the {track?.label} track volume.</p>
        </section>
      )}

      {tab === 'clip' && canRetime(clip) && (
        <section className="inspector-section">
          <label>Speed</label>
          <div className="speed-presets">
            {SPEED_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={Math.abs(speed - preset) < 1e-6 ? 'is-active' : ''}
                disabled={!!track?.locked}
                onClick={() => setClipSpeed(clip.id, preset)}
              >
                {formatSpeed(preset)}
              </button>
            ))}
          </div>
          <div className="slider-row">
            <span className="effect-param-label">Rate</span>
            <input
              type="range"
              min={SPEED_MIN}
              max={SPEED_MAX}
              step={0.05}
              value={speed}
              disabled={!!track?.locked}
              onChange={(e) => setClipSpeed(clip.id, Number(e.target.value))}
            />
            <span>{formatSpeed(speed)}</span>
          </div>
          <p className="hint">
            {speed === 1
              ? 'Playing at its recorded rate.'
              : `${formatTimecode(duration, fps)} on the timeline, from ${formatTimecode(
                  clip.sourceTrimOut - clip.sourceTrimIn,
                  fps,
                )} of source.`}
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={!!clip.pitchFollowsSpeed}
              disabled={!!track?.locked}
              onChange={(e) => setClipPitchFollows(clip.id, e.target.checked)}
            />
            Pitch follows the speed
          </label>
          <p className="hint">
            {clip.pitchFollowsSpeed
              ? 'Like a tape: faster is higher. Both exports reproduce it exactly.'
              : 'Held, so speech still sounds like speech. Each engine holds it its own way — the browser stretches the preview, the WebCodecs export overlap-adds, FFmpeg uses atempo — so sustained music can differ slightly between them.'}
          </p>
          {track?.locked && <p className="hint">The {track.label} track is locked.</p>}
          <p className="hint">
            ⌥-drag a trim handle to retime by dragging: the frames are kept and the clip takes
            longer or less time to play them.
          </p>
        </section>
      )}

      {tab === 'clip' && clip.kind === 'audio' && <AudioSection clip={clip} />}
      {tab === 'clip' && clip.kind === 'video' && clip.hasAudio && clip.audioEnabled && (
        <AudioSection clip={clip} />
      )}

      {tab === 'clip' && clip.kind === 'text' && (
        <section className="inspector-section">
          <label>Text</label>
          <textarea
            rows={3}
            value={clip.text}
            onChange={(e) => updateTextClip(clip.id, e.target.value, clip.template)}
          />
          {clip.textObjectId && (
            <p className="hint">
              From the library. Editing it changes every clip that uses it — duplicate it in the
              library first if you want this one to go its own way.
            </p>
          )}
        </section>
      )}

      {tab === 'clip' && clip.kind === 'text' && <TextStyleSection clip={clip} />}

      {tab === 'clip' && clip.kind === 'annotation' && (
        <section className="inspector-section">
          <label>Annotation</label>
          <p className="hint">
            {clip.shapes.length === 0
              ? 'Pick a tool above the preview and drag on the picture.'
              : `${clip.shapes.length} mark${clip.shapes.length === 1 ? '' : 's'}. Click one here or with the Select tool to edit it.`}
          </p>
          <ul className="annotation-list">
            {clip.shapes.map((shape) => (
              <li
                key={shape.id}
                className={shape.id === selectedShapeId ? 'is-selected' : ''}
                onClick={() =>
                  selectShape(shape.id === selectedShapeId ? null : shape.id)
                }
              >
                <span className="annotation-swatch" style={{ background: shape.color }} />
                <span>{shape.type === 'callout' ? shape.text || 'callout' : shape.type}</span>
                <div className="spacer" />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeAnnotationShape(clip.id, shape.id);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          {/*
            The selected mark's own properties. They live here as well as on the tool strip
            because the strip is a drawing control that happens to restyle, and this is where
            every other clip property is.
          */}
          {selectedShape && (
            <div className="annotation-shape-editor">
              <label>Selected mark</label>
              {selectedShape.type === 'callout' && (
                <>
                  <label className="field-label">Label</label>
                  <input
                    type="text"
                    value={selectedShape.text ?? ''}
                    placeholder="Note"
                    onChange={(e) =>
                      updateAnnotationShape(clip.id, selectedShape.id, { text: e.target.value })
                    }
                  />
                </>
              )}
              <div className="inspector-row">
                <input
                  type="color"
                  value={selectedShape.color}
                  onChange={(e) =>
                    updateAnnotationShape(clip.id, selectedShape.id, { color: e.target.value })
                  }
                />
                <span className="hint">Colour</span>
              </div>
              <div className="slider-row">
                <span className="effect-param-label">Width</span>
                <input
                  type="range"
                  min={2}
                  max={20}
                  value={Math.round(selectedShape.width * 1000)}
                  onChange={(e) =>
                    updateAnnotationShape(clip.id, selectedShape.id, {
                      width: Number(e.target.value) / 1000,
                    })
                  }
                />
                <span>{Math.round(selectedShape.width * 1000)}</span>
              </div>
              {(selectedShape.type === 'box' || selectedShape.type === 'ellipse') && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={!!selectedShape.fill}
                    onChange={(e) =>
                      updateAnnotationShape(clip.id, selectedShape.id, {
                        fill: e.target.checked ? 'rgba(0,0,0,0.35)' : null,
                      })
                    }
                  />
                  Shade the inside
                </label>
              )}
              {sortedKeys(selectedShape.pointKeys).length > 0 ? (
                <>
                  <label className="field-label">Poses</label>
                  {/*
                    Listed rather than counted. Where a mark's poses are is the one thing you
                    need to know to add another in the right place, and it was invisible.
                  */}
                  <div className="shape-poses">
                    {sortedKeys(selectedShape.pointKeys).map((key) => {
                      const at = clip.timelineStart + key.t;
                      const here = Math.abs(playhead - at) < 1 / fps / 2;
                      return (
                        <span key={key.t} className="shape-pose">
                          <button
                            type="button"
                            className={here ? 'is-active' : ''}
                            title="Go to this pose"
                            onClick={() => setPlayhead(at)}
                          >
                            {formatTimecode(key.t, fps)}
                          </button>
                          <button
                            type="button"
                            className="shape-pose-remove"
                            title="Delete this pose. The mark travels between the ones that are left; delete all but one and it stops moving"
                            onClick={() =>
                              removeAnnotationShapeKey(clip.id, selectedShape.id, key.t)
                            }
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                  </div>
                  <p className="hint">
                    Move the playhead and drag the mark to add another; drag a pose along the
                    clip on the timeline to change when it happens. The FFmpeg engine freezes
                    the movement at the clip's midpoint and says so.
                  </p>
                  <button
                    type="button"
                    onClick={() => clearAnnotationShapeKeys(clip.id, selectedShape.id)}
                  >
                    Stop it moving
                  </button>
                </>
              ) : (
                <p className="hint">
                  Press ⏱ above the preview to make this mark move. That records where it is
                  now; move the playhead, drag it, and it travels between the two.
                </p>
              )}
              <p className="hint">Delete removes it. Drag its ends on the preview to reshape it.</p>
            </div>
          )}
        </section>
      )}

      {/* A text box is placed on the canvas like any overlay, so it belongs to the same tab. */}
      {tab === 'placement' && clip.kind === 'text' && (
        <section className="inspector-section">
          <label>Text box on screen</label>
          <TextPlacementEditor
            text={clip.text}
            template={clip.template}
            style={clip.style}
            textFrame={textFrameForClip(clip.textFrame)}
            onChange={(textFrame) => updateTextClip(clip.id, clip.text, clip.template, textFrame)}
          />
        </section>
      )}
    </aside>
  );
}

/**
 * A frame as four numbers, for the clips that have no picture to drag.
 *
 * The media placement editor shows the source under the rectangle; an annotation has nothing
 * to show, so its frame is typed rather than dragged here — the dragging happens on the
 * preview, over the marks themselves.
 */
function FrameFields({
  frame,
  onChange,
}: {
  frame: { x: number; y: number; w: number; h: number };
  onChange: (frame: { x: number; y: number; w: number; h: number }) => void;
}) {
  const rows: { key: 'x' | 'y' | 'w' | 'h'; label: string; min: number }[] = [
    { key: 'x', label: 'Left', min: -0.5 },
    { key: 'y', label: 'Top', min: -0.5 },
    { key: 'w', label: 'Width', min: 0.05 },
    { key: 'h', label: 'Height', min: 0.05 },
  ];
  return (
    <>
      {rows.map((row) => (
        <div className="slider-row" key={row.key}>
          <span className="effect-param-label">{row.label}</span>
          <input
            type="range"
            min={row.min}
            max={1.5}
            step={0.005}
            value={frame[row.key]}
            onChange={(e) => onChange({ ...frame, [row.key]: Number(e.target.value) })}
          />
          <span>{Math.round(frame[row.key] * 100)}%</span>
        </div>
      ))}
    </>
  );
}
