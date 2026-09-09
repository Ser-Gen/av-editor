import { useEditorStore } from '../store/editorStore';
import type { AudioClip, AudioEffectType, VideoClip } from '../types/editor';
import {
  AUDIO_EFFECTS,
  AUDIO_EFFECT_ORDER,
  audioParam,
} from '../utils/audioChain';
import { DEFAULT_LOUDNESS_TARGET } from '../utils/loudness';

/**
 * The audio half of the Inspector: loudness, and the effect chain.
 *
 * The volume envelope is not here — it is drawn on the clip's own waveform, where the
 * material it is shaped against is visible. All this section does about it is say whether one
 * exists and offer to clear it.
 */
export function AudioSection({ clip }: { clip: AudioClip | VideoClip }) {
  const selectedCount = useEditorStore((s) => s.selectedClipIds.length);
  const loudnessJob = useEditorStore((s) => s.loudnessJob);
  const normalizeSelected = useEditorStore((s) => s.normalizeSelected);
  const clearGainEnvelope = useEditorStore((s) => s.clearGainEnvelope);
  const addAudioEffect = useEditorStore((s) => s.addAudioEffect);
  const removeAudioEffect = useEditorStore((s) => s.removeAudioEffect);
  const toggleAudioEffect = useEditorStore((s) => s.toggleAudioEffect);
  const setAudioEffectParam = useEditorStore((s) => s.setAudioEffectParam);

  const effects = clip.audioEffects ?? [];
  const envelopePoints = clip.gainKeyframes?.length ?? 0;
  // The cached figure describes an excerpt, so it stops being true when the excerpt changes.
  const measured =
    clip.loudness &&
    clip.loudness.trimIn === clip.sourceTrimIn &&
    clip.loudness.trimOut === clip.sourceTrimOut
      ? clip.loudness
      : null;
  const busy = loudnessJob !== null;

  return (
    <>
      <section className="inspector-section">
        <label>Loudness</label>
        <p className="hint">
          {measured
            ? `${measured.lufs.toFixed(1)} LUFS · peak ${
                Number.isFinite(measured.peakDb) ? `${measured.peakDb.toFixed(1)} dBFS` : 'silent'
              }`
            : 'Not measured yet.'}
        </p>
        <div className="inspector-row">
          <button
            type="button"
            disabled={busy}
            title={`Measure and set the gain so this lands on ${DEFAULT_LOUDNESS_TARGET} LUFS. Only the gain changes — nothing is re-encoded`}
            onClick={() => void normalizeSelected(DEFAULT_LOUDNESS_TARGET)}
          >
            {busy ? 'Measuring…' : selectedCount > 1 ? `Match ${selectedCount} clips` : 'Normalize'}
          </button>
        </div>
        {selectedCount > 1 && (
          <p className="hint">
            Every selected clip is measured and moved onto the same target, so a quiet take and
            a loud one sit at the same level across the cut.
          </p>
        )}
      </section>

      <section className="inspector-section">
        <label>Volume envelope</label>
        <p className="hint">
          {envelopePoints > 0
            ? `${envelopePoints} point${envelopePoints === 1 ? '' : 's'}, drawn on the clip's waveform.`
            : 'Click the waveform on the clip to add a point. Drag to move one, right-click to remove it.'}
        </p>
        {envelopePoints > 0 && (
          <div className="inspector-row">
            <button type="button" onClick={() => clearGainEnvelope(clip.id)}>
              Clear envelope
            </button>
          </div>
        )}
      </section>

      <section className="inspector-section">
        <label>Audio effects</label>
        {effects.length === 0 && <p className="hint">None. The clip plays as it was recorded.</p>}

        <ul className="audio-effect-list">
          {effects.map((effect) => {
            const descriptor = AUDIO_EFFECTS[effect.type];
            return (
              <li key={effect.id} className={`audio-effect${effect.enabled ? '' : ' is-off'}`}>
                <div className="audio-effect-head">
                  <input
                    type="checkbox"
                    checked={effect.enabled}
                    title="Bypass without removing"
                    onChange={() => toggleAudioEffect(clip.id, effect.id)}
                  />
                  <strong>{descriptor.label}</strong>
                  <div className="spacer" />
                  <button
                    type="button"
                    title="Remove this effect"
                    onClick={() => removeAudioEffect(clip.id, effect.id)}
                  >
                    ×
                  </button>
                </div>
                <p className="hint">{descriptor.hint}</p>
                {descriptor.params.map((spec) => (
                  <div key={spec.key} className="slider-row">
                    <span className="audio-param-label">{spec.label}</span>
                    <input
                      type="range"
                      min={spec.min}
                      max={spec.max}
                      step={spec.step}
                      disabled={!effect.enabled}
                      value={audioParam(effect, spec.key)}
                      onChange={(e) =>
                        setAudioEffectParam(clip.id, effect.id, spec.key, Number(e.target.value))
                      }
                    />
                    <span className="audio-param-value">
                      {audioParam(effect, spec.key)}
                      {spec.unit ?? ''}
                    </span>
                  </div>
                ))}
              </li>
            );
          })}
        </ul>

        <div className="inspector-row">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) addAudioEffect(clip.id, e.target.value as AudioEffectType);
              e.target.value = '';
            }}
          >
            <option value="">+ Add an effect…</option>
            {AUDIO_EFFECT_ORDER.map((type) => (
              <option key={type} value={type}>
                {AUDIO_EFFECTS[type].label}
              </option>
            ))}
          </select>
        </div>

        <p className="hint">
          Heard exactly as exported: the preview and the WebCodecs export build the same Web
          Audio chain. The FFmpeg fallback uses equivalent filters, and refuses rather than
          silently dropping the one it has no equivalent for.
        </p>
      </section>
    </>
  );
}
