import { useEditorStore } from '../store/editorStore';
import type { TextClip, TextTemplate } from '../types/editor';
import {
  FONT_STACKS,
  SOFT_SHADOW,
  TEXT_TEMPLATES,
  resolveTextStyle,
} from '../utils/textStyle';
import type { TextStyle } from '../utils/textStyle';

/**
 * Styling a text clip.
 *
 * Every control here writes an *override* on top of the template, which is what keeps a
 * project saved before styling existed looking exactly as it did: no overrides, so the
 * template speaks for itself.
 *
 * A clip made from a library text object edits the object, so all its uses follow. The store
 * handles that, but this component has to *say* it: an edit that silently changes four other
 * clips somewhere else on the timeline is indistinguishable from a bug, which is how it was
 * reported. Hence the linked notice and the way out of it.
 */
export function TextStyleSection({ clip }: { clip: TextClip }) {
  const setTextStyle = useEditorStore((s) => s.setTextStyle);
  const setTextTemplate = useEditorStore((s) => s.setTextTemplate);
  const unlinkTextClip = useEditorStore((s) => s.unlinkTextClip);
  const linkedObject = useEditorStore((s) =>
    clip.textObjectId ? (s.textLibrary.find((o) => o.id === clip.textObjectId) ?? null) : null,
  );
  const linkedUses = useEditorStore((s) =>
    clip.textObjectId
      ? s.clips.filter((c) => c.kind === 'text' && c.textObjectId === clip.textObjectId).length
      : 1,
  );
  const style = resolveTextStyle(clip.template, clip.style);

  const patch = (fields: Partial<TextStyle>) => setTextStyle(clip.id, fields);
  const descriptor = TEXT_TEMPLATES.find((t) => t.id === clip.template);

  return (
    <section className="inspector-section">
      <label>Template</label>
      <select
        value={clip.template}
        onChange={(e) => setTextTemplate(clip.id, e.target.value as TextTemplate)}
      >
        {TEXT_TEMPLATES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      {descriptor && <p className="hint">{descriptor.hint}</p>}
      {linkedObject && linkedUses > 1 && (
        <>
          <p className="hint">
            Linked to “{linkedObject.name}” in the library, which {linkedUses} clips show. Every
            change below lands on all {linkedUses} of them.
          </p>
          <div className="inspector-row">
            <button
              type="button"
              title="Keep the words and the look, drop the link — this clip then styles on its own"
              onClick={() => unlinkTextClip(clip.id)}
            >
              Style this one alone
            </button>
          </div>
        </>
      )}
      {clip.style && Object.keys(clip.style).length > 0 && (
        <p className="hint">
          Restyled. Changing the template starts again from it — the overrides were expressed
          against this one.
        </p>
      )}

      <label>Font</label>
      <div className="inspector-row">
        <select value={style.fontFamily} onChange={(e) => patch({ fontFamily: e.target.value })}>
          {FONT_STACKS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <select value={style.weight} onChange={(e) => patch({ weight: Number(e.target.value) })}>
          {[300, 400, 500, 600, 700, 800].map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={style.italic ? 'is-active' : ''}
          title="Italic"
          onClick={() => patch({ italic: !style.italic })}
        >
          <em>I</em>
        </button>
      </div>

      <Slider
        label="Size"
        value={style.fontSize}
        min={0.04}
        max={0.8}
        step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(fontSize) => patch({ fontSize })}
      />
      <Slider
        label="Line height"
        value={style.lineHeight}
        min={0.8}
        max={2.2}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(lineHeight) => patch({ lineHeight })}
      />
      <Slider
        label="Tracking"
        value={style.letterSpacing}
        min={-0.05}
        max={0.4}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(letterSpacing) => patch({ letterSpacing })}
      />
      <Slider
        label="Margin"
        value={style.margin}
        min={0}
        max={0.2}
        step={0.005}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(margin) => patch({ margin })}
      />

      <label>Alignment</label>
      <div className="inspector-row">
        <select
          value={style.align}
          onChange={(e) => patch({ align: e.target.value as TextStyle['align'] })}
        >
          <option value="left">Left</option>
          <option value="center">Centre</option>
          <option value="right">Right</option>
        </select>
        <select
          value={style.vAlign}
          onChange={(e) => patch({ vAlign: e.target.value as TextStyle['vAlign'] })}
        >
          <option value="top">Top</option>
          <option value="middle">Middle</option>
          <option value="bottom">Bottom</option>
        </select>
      </div>

      <label>Colour</label>
      <div className="inspector-row">
        <input type="color" value={style.color} onChange={(e) => patch({ color: e.target.value })} />
        <span className="hint">Fill</span>
      </div>

      <Slider
        label="Stroke"
        value={style.strokeWidth}
        min={0}
        max={0.35}
        step={0.005}
        // A fraction of the font size, and it is the outline you can see: the renderer draws
        // twice this so that half of it is not lost under the fill.
        format={(v) => (v === 0 ? 'none' : `${Math.round(v * 100)}%`)}
        onChange={(strokeWidth) => patch({ strokeWidth })}
      />
      {style.strokeWidth > 0 && (
        <div className="inspector-row">
          <input
            type="color"
            value={style.strokeColor}
            onChange={(e) => patch({ strokeColor: e.target.value })}
          />
          <span className="hint">Stroke colour</span>
        </div>
      )}

      <label>Behind the text</label>
      <div className="inspector-row">
        <button
          type="button"
          className={style.shadow ? 'is-active' : ''}
          title="A drop shadow behind the type, sized in proportion to it"
          onClick={() => patch({ shadow: style.shadow ? null : SOFT_SHADOW })}
        >
          Shadow
        </button>
        <button
          type="button"
          className={style.box ? 'is-active' : ''}
          onClick={() =>
            patch({
              box: style.box
                ? null
                : { color: 'rgba(0,0,0,0.65)', paddingX: 0.5, paddingY: 0.3, radius: 0.12 },
            })
          }
        >
          Box
        </button>
      </div>

      <p className="hint">
        Drawn on a canvas and composited the same way by the preview, the WebCodecs export and
        the FFmpeg fallback — so what is on screen is what lands in the file.
      </p>
    </section>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="slider-row">
      <span className="audio-param-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="audio-param-value">{format(value)}</span>
    </div>
  );
}
