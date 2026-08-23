import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditorStore } from '../../store/editorStore';
import { clampMenuPosition, clipMenuItems } from '../../utils/clipMenu';
import type { ClipMenuId } from '../../utils/clipMenu';
import { clipEnd } from '../../utils/time';

export interface ClipMenuRequest {
  clipId: string;
  x: number;
  y: number;
}

interface Props {
  request: ClipMenuRequest;
  onClose: () => void;
  onBake: (clipId: string) => void;
  onPreset: (clipId: string) => void;
}

/**
 * The right-click menu for a clip.
 *
 * Rendered into `document.body` rather than the lane it belongs to. `.lanes-content` carries
 * a `transform`, which makes it the containing block for anything fixed inside it — a menu
 * positioned there would be measured from the scrolled content and then clipped by the
 * viewport's `overflow: hidden`, which is a very confusing way to lose a menu.
 */
export function ClipContextMenu({ request, onClose, onBake, onPreset }: Props) {
  const clip = useEditorStore((s) => s.clips.find((c) => c.id === request.clipId));
  const track = useEditorStore((s) => s.tracks.find((t) => t.id === clip?.trackId));
  const asset = useEditorStore((s) =>
    clip && 'assetId' in clip ? s.mediaLibrary[clip.assetId] : undefined,
  );
  const playhead = useEditorStore((s) => s.playhead);
  const selectionCount = useEditorStore((s) => s.selectedClipIds.length);
  const producerBusy = useEditorStore((s) => s.processJob !== null);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: request.x, y: request.y });

  // Measured after the first paint, because the height depends on how many items this
  // particular clip earned — an audio clip's menu is several rows shorter than a video's.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(
      clampMenuPosition(
        request.x,
        request.y,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [request.x, request.y, request.clipId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture, so the click that dismisses the menu does not also land on whatever is under
    // it — closing a menu should not select the clip behind it or move the playhead.
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  if (!clip) return null;

  const items = clipMenuItems({
    kind: clip.kind,
    playheadInside: playhead > clip.timelineStart && playhead < clipEnd(clip),
    hasAsset: 'assetId' in clip && !!asset,
    offline: 'assetId' in clip && !asset?.file,
    hasAudio: clip.kind === 'video' ? clip.hasAudio : clip.kind === 'audio',
    audioEnabled: clip.kind === 'video' ? clip.audioEnabled : true,
    hideVideo: clip.kind === 'video' ? clip.hideVideo : false,
    trackLocked: !!track?.locked,
    producerBusy,
    selectionCount,
  });

  const run = (id: ClipMenuId) => {
    const store = useEditorStore.getState();
    switch (id) {
      case 'split':
        store.splitSelectedAtPlayhead();
        break;
      case 'trimStart':
        store.trimClipTo(clip.id, 'left', store.playhead);
        break;
      case 'trimEnd':
        store.trimClipTo(clip.id, 'right', store.playhead);
        break;
      case 'duplicate':
        store.duplicateSelected();
        break;
      case 'bake':
        onBake(clip.id);
        break;
      case 'preset':
        onPreset(clip.id);
        break;
      case 'detach':
        store.detachAudio(clip.id);
        break;
      case 'toggleAudio':
        if (clip.kind === 'video') {
          store.updateVideoFlags(clip.id, { audioEnabled: !clip.audioEnabled });
        }
        break;
      case 'toggleVideo':
        if (clip.kind === 'video') store.updateVideoFlags(clip.id, { hideVideo: !clip.hideVideo });
        break;
      case 'zoom':
        store.zoomToSelection();
        break;
      case 'delete':
        store.removeSelected(false);
        break;
      case 'rippleDelete':
        store.removeSelected(true);
        break;
    }
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className="clip-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore && <div className="clip-menu-rule" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`clip-menu-item${item.danger ? ' is-danger' : ''}`}
            disabled={item.disabled}
            title={item.reason}
            onClick={() => run(item.id)}
          >
            <span>{item.label}</span>
            {item.accel && <kbd>{item.accel}</kbd>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
