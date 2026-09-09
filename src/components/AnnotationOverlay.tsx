import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../store/editorStore';
import type {
  AnnotationClip,
  AnnotationShape,
  AnnotationShapeType,
  OverlayTransform,
} from '../types/editor';
import { uid } from '../utils/id';
import {
  HIT_TOLERANCE,
  moveShape,
  SHAPE_LABELS,
  labelRect,
  pickShape,
  setShapePoint,
  shapeHandles,
} from '../utils/annotationEdit';
import { annotationShapesAt, sortedKeys } from '../utils/annotationAnim';
import {
  clampFrame,
  projectNormalizedPoint,
  rotationOf,
  unprojectNormalizedPoint,
} from '../utils/overlayTransform';

/**
 * Drawing on the preview, and editing what is already drawn.
 *
 * What this layer draws is a **picking outline**, not the annotation: the real rendering is
 * the compositor's, from `render/annotationRaster.ts`, and it is what an export contains.
 * The outline exists to be clicked on and is deliberately drawn as a dashed hairline so the
 * two are never mistaken for each other.
 *
 * Follows the conventions `MaskOverlay` and `TextPlacementEditor` already set: an absolutely
 * positioned layer over the video, coordinates normalized to the composition rather than to
 * pixels, and no state of its own beyond the gesture in progress.
 *
 * Normalized coordinates are not a detail. They are what lets a shape survive a change of
 * frame size, and what makes a change of *aspect* refit it the way a mask refits — phase 19 of
 * the capture plan recorded what happens when a region is refitted against the wrong thing:
 * the blur slides off the licence plate. It is also why every distance here is taken with x
 * scaled by the stage's aspect: a grab radius in raw normalized units is an ellipse on screen.
 */

/** The pointer, plus the five shapes. Selecting is a mode, not a shape. */
export type AnnotationTool = 'select' | AnnotationShapeType;

export const ANNOTATION_TOOLS: { id: AnnotationTool; label: string; hint: string }[] = [
  { id: 'select', label: 'Select', hint: 'Click a mark to move, restyle or delete it. Right-click one to remove it outright, from any tool.' },
  { id: 'arrow', label: SHAPE_LABELS.arrow, hint: 'Drag from the tail to the point.' },
  { id: 'box', label: SHAPE_LABELS.box, hint: 'Drag a rectangle around something.' },
  { id: 'ellipse', label: SHAPE_LABELS.ellipse, hint: 'Drag an oval around something.' },
  { id: 'freehand', label: SHAPE_LABELS.freehand, hint: 'Draw a line by hand.' },
  { id: 'callout', label: SHAPE_LABELS.callout, hint: 'A caption box. Click where you want it.' },
];

interface Props {
  clip: AnnotationClip;
  tool: AnnotationTool;
  color: string;
  width: number;
  /** Placement at the playhead, animated channels included. Undefined = full frame. */
  transform: OverlayTransform | undefined;
  /** Timeline seconds, for resolving an animated mark's pose. */
  playhead: number;
  /** The video's rectangle inside the preview, in CSS pixels. */
  stage: { left: number; top: number; width: number; height: number };
}

/** What a pointer-down started. */
type Gesture =
  | { kind: 'draw'; shape: AnnotationShape }
  | { kind: 'move'; shapeId: string; origin: AnnotationShape; from: { x: number; y: number } }
  | { kind: 'handle'; shapeId: string; index: number }
  | { kind: 'place'; origin: OverlayTransform; from: { x: number; y: number } };

export function AnnotationOverlay({
  clip,
  tool,
  color,
  width,
  transform,
  playhead,
  stage,
}: Props) {
  const addAnnotationShape = useEditorStore((s) => s.addAnnotationShape);
  const updateAnnotationShape = useEditorStore((s) => s.updateAnnotationShape);
  const removeAnnotationShape = useEditorStore((s) => s.removeAnnotationShape);
  const setAnnotationShapeKey = useEditorStore((s) => s.setAnnotationShapeKey);
  const updateClipTransform = useEditorStore((s) => s.updateClipTransform);
  const selectedShapeId = useEditorStore((s) => s.selectedShapeId);
  const selectShape = useEditorStore((s) => s.selectShape);
  const beginInteraction = useEditorStore((s) => s.beginInteraction);
  const endInteraction = useEditorStore((s) => s.endInteraction);

  const [draft, setDraft] = useState<AnnotationShape | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);

  const aspect = Math.max(0.01, stage.width / Math.max(1, stage.height));
  // Rotation is about the frame's centre in pixel space; this layer works in the composition's
  // own normalized units and would have to guess. It says so instead — see the hint below.
  const rotated = rotationOf(transform) !== 0;
  const editable = !rotated;

  // Delete removes the selected mark. Not while the callout's input has focus, where the key
  // means what it always means in a text field.
  useEffect(() => {
    if (!selectedShapeId || editingId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace' && e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      // Capture phase, ahead of the app's own shortcut handler: with a mark selected,
      // Delete means the mark. Deselect first to delete the clip.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') selectShape(null);
      else removeAnnotationShape(clip.id, selectedShapeId);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectedShapeId, editingId, clip.id, removeAnnotationShape, selectShape]);

  /**
   * Where a drag lands: on the mark itself, or on a pose of it at the playhead.
   *
   * There is no arming *mode*. A mark either moves — it has poses — or it does not, and the
   * ⏱ is what turns one into the other. A hidden mode meant a drag could mean either thing
   * with nothing on screen saying which, and made the first recorded pose look like a bug:
   * one pose holds for the whole clip, so "I moved it at 2s and it moved everywhere" was the
   * feature working as designed and reading as broken.
   */
  const writePoints = (shapeId: string, points: { x: number; y: number }[]) => {
    const shape = clip.shapes.find((s) => s.id === shapeId);
    if (shape && sortedKeys(shape.pointKeys).length > 0) {
      setAnnotationShapeKey(clip.id, shapeId, points);
    } else {
      updateAnnotationShape(clip.id, shapeId, { points });
    }
  };

  /** Pointer → a point of the *source*, which is what shapes are stored in. */
  const pointFrom = (e: React.PointerEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    const onScreen = {
      x: (e.clientX - box.left) / Math.max(1, box.width),
      y: (e.clientY - box.top) / Math.max(1, box.height),
    };
    const source = unprojectNormalizedPoint(onScreen, transform);
    return {
      screen: onScreen,
      x: Math.min(1, Math.max(0, source.x)),
      y: Math.min(1, Math.max(0, source.y)),
    };
  };

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || editingId) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const point = pointFrom(e);

    if (tool === 'select') {
      if (!editable) return;
      // A handle beats the shape it belongs to: they overlap, and the smaller target is
      // always the one that was aimed at. Taken from `posed` for the same reason as the pick
      // below — the handles are drawn where the mark is now, not where it is stored.
      const selected = posed.find((s) => s.id === selectedShapeId);
      if (selected) {
        for (const handle of shapeHandles(selected)) {
          const dx = (handle.point.x - point.x) * aspect;
          const dy = handle.point.y - point.y;
          if (Math.hypot(dx, dy) <= HIT_TOLERANCE) {
            // One drag, one undo entry — the rule `endInteraction` exists to keep.
            beginInteraction('Reshape mark');
            gesture.current = { kind: 'handle', shapeId: selected.id, index: handle.index };
            return;
          }
        }
      }

      // `posed`, not `clip.shapes`: for a mark that follows something, the stored points are
      // its base pose and the drawn ones come from `annotationShapesAt`. Picking against the
      // stored set meant a mark that had moved could only be selected by clicking where it
      // used to be — invisible, and reported as "it is not possible to select the object".
      const hit = pickShape(posed, point, HIT_TOLERANCE, aspect);
      if (hit) {
        selectShape(hit);
        const origin = posed.find((s) => s.id === hit);
        if (origin) {
          beginInteraction('Move mark');
          gesture.current = { kind: 'move', shapeId: hit, origin, from: point };
        }
        return;
      }

      selectShape(null);
      // Empty space with a placement set moves the whole overlay — the picture-in-picture
      // gesture, on the thing that is placed like one.
      if (transform) {
        beginInteraction('Move annotation');
        gesture.current = { kind: 'place', origin: transform, from: point.screen };
      }
      return;
    }

    selectShape(null);
    // `point` carries the screen coordinates it was measured from; a stored mark is geometry
    // and nothing else, and this ends up in the project file and in the compositor's cache key.
    const at = { x: point.x, y: point.y };
    setDraft({
      id: uid('shape'),
      type: tool,
      points: [at, at],
      color,
      width,
      fill: null,
      ...(tool === 'callout' ? { text: 'Note' } : {}),
    });
    gesture.current = {
      kind: 'draw',
      shape: { id: '', type: tool, points: [], color, width, fill: null },
    };
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const active = gesture.current;
    if (!active) return;
    const point = pointFrom(e);

    if (active.kind === 'draw') {
      const at = { x: point.x, y: point.y };
      setDraft((current) => {
        if (!current) return current;
        // A label is placed, not dragged out: its size comes from its text. Letting the drag
        // move its second point left a stray point behind it, which the picking outline then
        // drew a line to — an arrow, on the one mark that is meant not to have one.
        if (current.type === 'callout') return current;
        return current.type === 'freehand'
          ? { ...current, points: [...current.points, at] }
          : { ...current, points: [current.points[0], at] };
      });
      return;
    }

    if (active.kind === 'move') {
      const moved = moveShape(active.origin, point.x - active.from.x, point.y - active.from.y);
      writePoints(active.shapeId, moved.points);
      return;
    }

    if (active.kind === 'handle') {
      const shape = posed.find((s) => s.id === active.shapeId);
      if (!shape) return;
      writePoints(active.shapeId, setShapePoint(shape, active.index, point).points);
      return;
    }

    // Placement: the frame moves by the pointer's travel *on screen*, because that is the
    // space a frame lives in.
    const dx = point.screen.x - active.from.x;
    const dy = point.screen.y - active.from.y;
    updateClipTransform(clip.id, {
      ...active.origin,
      frame: clampFrame({
        ...active.origin.frame,
        x: active.origin.frame.x + dx,
        y: active.origin.frame.y + dy,
      }),
    });
  };

  const onUp = () => {
    const active = gesture.current;
    gesture.current = null;
    if (!active) return;

    if (active.kind !== 'draw') {
      endInteraction();
      return;
    }

    const shape = draft;
    setDraft(null);
    if (!shape) return;
    // A click that never moved is not a shape — except a label, which is placed at a point
    // and has nothing to drag out. Dropping the rest keeps a stray tap from leaving an
    // invisible zero-length arrow in the list.
    const [a, b] = [shape.points[0], shape.points[shape.points.length - 1]];
    if (shape.type !== 'callout' && Math.hypot((b.x - a.x) * aspect, b.y - a.y) <= 0.01) return;
    addAnnotationShape(clip.id, shape);
    // Selected on arrival, so the colour and width controls act on what was just drawn.
    selectShape(shape.id);
  };

  // What is on screen right now, which for an animated mark is not what is stored on it.
  const posed = annotationShapesAt(clip, playhead);
  const shapes = draft ? [...posed, draft] : posed;
  const selected = posed.find((s) => s.id === selectedShapeId) ?? null;
  const project = (p: { x: number; y: number }) => projectNormalizedPoint(p, transform);

  return (
    <>
      <svg
        className={`annotation-overlay${tool === 'select' ? ' is-picking' : ''}`}
        style={{ left: stage.left, top: stage.top, width: stage.width, height: stage.height }}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={(e) => {
          if (!editable) return;
          const box = e.currentTarget.getBoundingClientRect();
          const onScreen = {
            x: (e.clientX - box.left) / Math.max(1, box.width),
            y: (e.clientY - box.top) / Math.max(1, box.height),
          };
          const point = unprojectNormalizedPoint(onScreen, transform);
          const hit = pickShape(posed, point, HIT_TOLERANCE, aspect);
          const shape = clip.shapes.find((s) => s.id === hit);
          if (!shape || shape.type !== 'callout') return;
          e.stopPropagation();
          selectShape(shape.id);
          setEditingId(shape.id);
        }}
      >
        {/*
          A thin outline of what is already drawn, so shapes can be picked and removed. The real
          rendering is the compositor's — this is only the handle.
        */}
        {shapes.map((shape) => (
          <ShapeOutline
            key={shape.id}
            shape={shape}
            project={project}
            aspect={aspect}
            selected={shape.id === selectedShapeId}
            onRemove={() => removeAnnotationShape(clip.id, shape.id)}
          />
        ))}
        {editable &&
          selected &&
          shapeHandles(selected).map((handle) => {
            const at = project(handle.point);
            // An ellipse, not a circle: the viewBox is 0..1 in both axes over a stage that is
            // wider than it is tall, so a circle would come out oval. Radii are one screen
            // pixel size expressed in each axis' own units, which makes it round again.
            const radius = Math.max(4, HIT_TOLERANCE * stage.height * 0.5);
            return (
              <ellipse
                key={handle.index}
                className="annotation-handle"
                cx={at.x}
                cy={at.y}
                rx={radius / Math.max(1, stage.width)}
                ry={radius / Math.max(1, stage.height)}
              />
            );
          })}
      </svg>

      {editingId && (
        <CalloutInput
          shape={clip.shapes.find((s) => s.id === editingId) ?? null}
          stage={stage}
          project={project}
          onCommit={(text) => {
            updateAnnotationShape(clip.id, editingId, { text });
            setEditingId(null);
          }}
          onCancel={() => setEditingId(null)}
        />
      )}

      {rotated && (
        <p className="annotation-rotated-note">
          Rotated placement: the marks can be moved as a whole from the Inspector, but not
          edited here until the rotation is back to zero.
        </p>
      )}
    </>
  );
}

/** The label editor, floated over the callout's tail where its text is drawn. */
function CalloutInput({
  shape,
  stage,
  project,
  onCommit,
  onCancel,
}: {
  shape: AnnotationShape | null;
  stage: { left: number; top: number; width: number; height: number };
  project: (p: { x: number; y: number }) => { x: number; y: number };
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(shape?.text ?? '');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  if (!shape) return null;
  const at = project(shape.points[0] ?? { x: 0, y: 0 });

  return (
    <input
      ref={ref}
      className="annotation-callout-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      style={{
        left: stage.left + at.x * stage.width,
        top: stage.top + at.y * stage.height,
      }}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onCommit(value);
        if (e.key === 'Escape') onCancel();
      }}
    />
  );
}

function ShapeOutline({
  shape,
  project,
  aspect,
  selected,
  onRemove,
}: {
  shape: AnnotationShape;
  project: (p: { x: number; y: number }) => { x: number; y: number };
  aspect: number;
  selected: boolean;
  onRemove: () => void;
}) {
  const stroke = {
    stroke: shape.color,
    strokeWidth: selected ? 3 : 1.5,
    fill: 'none',
    vectorEffect: 'non-scaling-stroke' as const,
  };
  const className = `annotation-outline${selected ? ' is-selected' : ''}`;
  const remove = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onRemove();
  };
  const a = project(shape.points[0] ?? { x: 0, y: 0 });
  const b = project(shape.points[shape.points.length - 1] ?? { x: 0, y: 0 });

  if (shape.type === 'freehand') {
    return (
      <polyline
        {...stroke}
        className={className}
        points={shape.points.map((p) => project(p)).map((p) => `${p.x},${p.y}`).join(' ')}
        onContextMenu={remove}
      />
    );
  }
  if (shape.type === 'box') {
    return (
      <rect
        {...stroke}
        className={className}
        x={Math.min(a.x, b.x)}
        y={Math.min(a.y, b.y)}
        width={Math.abs(b.x - a.x)}
        height={Math.abs(b.y - a.y)}
        onContextMenu={remove}
      />
    );
  }
  if (shape.type === 'ellipse') {
    return (
      <ellipse
        {...stroke}
        className={className}
        cx={(a.x + b.x) / 2}
        cy={(a.y + b.y) / 2}
        rx={Math.abs(b.x - a.x) / 2}
        ry={Math.abs(b.y - a.y) / 2}
        onContextMenu={remove}
      />
    );
  }
  /*
    A label is a box at a point, and its outline traces that box — the same rectangle
    `hitShape` picks it by, so what you can click is what you can see.

    It has been wrong twice. First it was a line to the shape's second point, which made the
    label look like it still had an arrow. Then it was a ring at the anchor, which is the
    *centre* of the label: a circle sitting in the middle of the text, attached to nothing,
    reported as "it is drawn with a circle in the middle. I don't know why".
  */
  if (shape.type === 'callout') {
    const rect = labelRect(shape, aspect);
    const topLeft = project({ x: rect.x, y: rect.y });
    const bottomRight = project({ x: rect.x + rect.w, y: rect.y + rect.h });
    return (
      <rect
        {...stroke}
        className={className}
        x={Math.min(topLeft.x, bottomRight.x)}
        y={Math.min(topLeft.y, bottomRight.y)}
        width={Math.abs(bottomRight.x - topLeft.x)}
        height={Math.abs(bottomRight.y - topLeft.y)}
        rx={0.01}
        onContextMenu={remove}
      />
    );
  }

  return (
    <line
      {...stroke}
      className={className}
      x1={a.x}
      y1={a.y}
      x2={b.x}
      y2={b.y}
      onContextMenu={remove}
    />
  );
}
