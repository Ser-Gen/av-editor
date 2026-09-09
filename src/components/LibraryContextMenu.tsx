import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditorStore } from '../store/editorStore';
import { isAssetInUse } from '../store/clipFactory';
import { clampMenuPosition } from '../utils/clipMenu';
import { libraryMenuItems } from '../utils/libraryMenu';
import { downloadFile, safeFileName } from '../utils/downloadFile';
import type { LibraryMenuId } from '../utils/libraryMenu';

export interface LibraryMenuRequest {
  assetId: string;
  x: number;
  y: number;
}

interface Props {
  request: LibraryMenuRequest;
  onClose: () => void;
  onInfo: (assetId: string) => void;
  onPreset: (assetId: string) => void;
  onRelink: (assetId: string) => void;
}

/**
 * The right-click menu for a library file.
 *
 * Shares `.clip-menu`'s look and `clampMenuPosition`'s edge handling with the timeline's menu,
 * and is portalled to `document.body` for the same reason: the library column clips its own
 * overflow, and a menu opened on the last row would otherwise be cut off by it.
 */
export function LibraryContextMenu({ request, onClose, onInfo, onPreset, onRelink }: Props) {
  const asset = useEditorStore((s) => s.mediaLibrary[request.assetId]);
  const clips = useEditorStore((s) => s.clips);
  const producerBusy = useEditorStore((s) => s.processJob !== null);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: request.x, y: request.y });

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
  }, [request.x, request.y, request.assetId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture, so the dismissing click does not also land on the row underneath.
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

  if (!asset) return null;

  const items = libraryMenuItems({
    type: asset.type,
    online: !!asset.file,
    inUse: isAssetInUse(asset.id, clips),
    producerBusy,
  });

  const run = (id: LibraryMenuId) => {
    const store = useEditorStore.getState();
    switch (id) {
      case 'info':
        onInfo(asset.id);
        break;
      case 'add':
        store.addAssetToTimeline(asset.id);
        break;
      case 'download':
        if (asset.file) downloadFile(asset.file, safeFileName(asset.name));
        break;
      case 'preset':
        onPreset(asset.id);
        break;
      case 'relink':
        onRelink(asset.id);
        break;
      case 'remove':
        store.removeLibraryItem(asset.id);
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
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
