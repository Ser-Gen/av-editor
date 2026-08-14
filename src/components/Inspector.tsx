import { useEditorStore } from '../store/editorStore';
import { clipDuration } from '../utils/time';
import type { OverlayTransform, TextTemplate } from '../types/editor';
import { imageTransformForClip, textFrameForClip } from '../utils/overlayTransform';
import { MediaOverlayEditor } from './MediaOverlayEditor';
import { TextPlacementEditor } from './TextPlacementEditor';

export function Inspector() {
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const clips = useEditorStore((s) => s.clips);
  const mediaLibrary = useEditorStore((s) => s.mediaLibrary);
  const updateVideoFlags = useEditorStore((s) => s.updateVideoFlags);
  const updateImageTransform = useEditorStore((s) => s.updateImageTransform);
  const updateTextClip = useEditorStore((s) => s.updateTextClip);

  const clip = clips.find((c) => c.id === selectedClipId);

  if (!clip) {
    return (
      <aside className="inspector">
        <h3>Inspector</h3>
        <p className="hint">Select a clip to edit properties.</p>
      </aside>
    );
  }

  const dur = clipDuration(clip);
  const videoAsset = clip.kind === 'video' ? mediaLibrary[clip.assetId] : undefined;
  const imageAsset = clip.kind === 'image' ? mediaLibrary[clip.assetId] : undefined;

  return (
    <aside className="inspector">
      <h3>Inspector</h3>
      <p className="hint">
        {clip.kind} · {dur.toFixed(2)}s
      </p>

      {clip.kind === 'video' && (
        <>
          <label>
            <input
              type="checkbox"
              checked={!!clip.overlayMode}
              onChange={(e) => updateVideoFlags(clip.id, { overlayMode: e.target.checked })}
            />{' '}
            Use as overlay (PiP)
          </label>
          {clip.overlayMode && videoAsset && clip.overlayTransform && (
            <MediaOverlayEditor
              mediaKind="video"
              blobUrl={videoAsset.blobUrl}
              sourceWidth={videoAsset.width ?? 1920}
              sourceHeight={videoAsset.height ?? 1080}
              transform={clip.overlayTransform}
              onChange={(overlayTransform: OverlayTransform) =>
                updateVideoFlags(clip.id, { overlayTransform })
              }
            />
          )}
          <label>
            <input
              type="checkbox"
              checked={clip.muteAudio}
              onChange={(e) => updateVideoFlags(clip.id, { muteAudio: e.target.checked })}
            />{' '}
            Mute audio
          </label>
          <label>
            <input
              type="checkbox"
              checked={clip.hideVideo}
              onChange={(e) => updateVideoFlags(clip.id, { hideVideo: e.target.checked })}
            />{' '}
            Hide video
          </label>
        </>
      )}

      {clip.kind === 'image' && imageAsset && (
        <MediaOverlayEditor
          mediaKind="image"
          blobUrl={imageAsset.blobUrl}
          sourceWidth={imageAsset.width ?? 1920}
          sourceHeight={imageAsset.height ?? 1080}
          transform={imageTransformForClip(
            clip.overlayTransform,
            imageAsset.width ?? 1920,
            imageAsset.height ?? 1080,
          )}
          onChange={(overlayTransform) => updateImageTransform(clip.id, overlayTransform)}
        />
      )}

      {clip.kind === 'text' && (
        <>
          <label>Text</label>
          <textarea
            rows={3}
            value={clip.text}
            onChange={(e) => updateTextClip(clip.id, e.target.value, clip.template)}
          />
          <label>Template</label>
          <select
            value={clip.template}
            onChange={(e) =>
              updateTextClip(clip.id, clip.text, e.target.value as TextTemplate)
            }
          >
            <option value="lowerThird">Lower third</option>
            <option value="centerTitle">Center title</option>
            <option value="subtitle">Subtitle</option>
          </select>
          <TextPlacementEditor
            text={clip.text}
            template={clip.template}
            textFrame={textFrameForClip(clip.textFrame)}
            onChange={(textFrame) => updateTextClip(clip.id, clip.text, clip.template, textFrame)}
          />
        </>
      )}
    </aside>
  );
}
