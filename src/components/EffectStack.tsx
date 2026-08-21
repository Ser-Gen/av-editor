import { useEffect, useState } from 'react';
import type { BuiltinEffectType, EffectInstance } from '../types/editor';
import type { EffectTargetRef } from '../store/editorStore';
import { useEditorStore } from '../store/editorStore';
import {
  EFFECTS,
  EFFECT_ORDER,
  REGION_CHANNELS,
  REGION_FEATHER,
  REGION_INVERT,
  REGION_MODE,
  descriptorFor,
  supportsRegion,
} from '../render/effects/registry';
import type { EffectParam } from '../render/effects/registry';
import { shaderFailure, shaderTime } from '../render/effects/shaderStats';
import { evaluateChannel } from '../utils/keyframes';
import { ShaderDialog } from './ShaderDialog';

/**
 * The effect chain editor.
 *
 * Entirely descriptor-driven: the controls come from the descriptor's param list, so a new
 * effect needs no code here — and a user's pasted shader, which produces a descriptor of
 * exactly the same shape, gets its sliders from the same twenty lines. Order in the list is
 * render order.
 */
export function EffectStack({
  target,
  effects,
  clipStart,
  label = 'Effects',
}: {
  target: EffectTargetRef;
  effects: EffectInstance[];
  /** Clip start for evaluating animated values; absent for a track grade. */
  clipStart?: number;
  label?: string;
}) {
  const addEffect = useEditorStore((s) => s.addEffect);
  const addCustomEffect = useEditorStore((s) => s.addCustomEffect);
  const addRegionEffect = useEditorStore((s) => s.addRegionEffect);
  const [pending, setPending] = useState<BuiltinEffectType>('eq');
  const [adding, setAdding] = useState(false);

  return (
    <section className="inspector-section">
      <label>{label}</label>

      <div className="effect-add">
        <select value={pending} onChange={(e) => setPending(e.target.value as BuiltinEffectType)}>
          {EFFECT_ORDER.map((type) => (
            <option key={type} value={type}>
              {EFFECTS[type].label}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => addEffect(target, pending)}>
          Add
        </button>
      </div>

      <div className="effect-presets">
        <span className="hint">Mask a region:</span>
        <button type="button" onClick={() => addRegionEffect(target, 'blur')}>
          Blur
        </button>
        <button type="button" onClick={() => addRegionEffect(target, 'pixelate')}>
          Pixelate
        </button>
        <button type="button" onClick={() => addRegionEffect(target, 'fill')}>
          Black box
        </button>
      </div>

      <div className="effect-presets">
        <span className="hint">Or write one:</span>
        <button type="button" onClick={() => setAdding(true)}>
          Custom shader…
        </button>
      </div>

      {adding && (
        <ShaderDialog
          onClose={() => setAdding(false)}
          onSave={(source) => {
            addCustomEffect(target, source);
            setAdding(false);
          }}
        />
      )}

      {effects.length === 0 ? (
        <p className="hint">No effects. They render bottom-of-list last.</p>
      ) : (
        <ol className="effect-list">
          {effects.map((effect, index) => (
            <EffectRow
              key={effect.id}
              target={target}
              clipStart={clipStart}
              effect={effect}
              first={index === 0}
              last={index === effects.length - 1}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function EffectRow({
  target,
  clipStart,
  effect,
  first,
  last,
}: {
  target: EffectTargetRef;
  clipStart?: number;
  effect: EffectInstance;
  first: boolean;
  last: boolean;
}) {
  const removeEffect = useEditorStore((s) => s.removeEffect);
  const moveEffect = useEditorStore((s) => s.moveEffect);
  const toggleEffect = useEditorStore((s) => s.toggleEffect);
  const setEffectParam = useEditorStore((s) => s.setEffectParam);
  const resetEffect = useEditorStore((s) => s.resetEffect);
  const setEffectShader = useEditorStore((s) => s.setEffectShader);
  const toggleChannelArmed = useEditorStore((s) => s.toggleChannelArmed);
  const setRegionMode = useEditorStore((s) => s.setRegionMode);
  // An animated slider reads out the value at the playhead, so scrubbing the timeline
  // moves the control and dragging it writes a key where you are looking.
  const playhead = useEditorStore((s) => s.playhead);
  const [editing, setEditing] = useState(false);

  const custom = effect.type === 'custom';
  const cost = useShaderCost(custom && effect.enabled ? effect.id : null);
  const desc = descriptorFor(effect);
  if (!desc) return null;

  // A track grade has no time base, so it cannot be keyframed.
  const animatable = clipStart !== undefined;
  const clipId = typeof target === 'string' ? target : target.id;

  const regionMode = effect.params[REGION_MODE] ?? 0;
  const regionArmed = REGION_CHANNELS.some((ch) => (effect.keyframes?.[ch]?.length ?? 0) > 0);

  return (
    <li className={`effect-row${effect.enabled ? '' : ' is-disabled'}`}>
      <div className="effect-head">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={effect.enabled}
            onChange={() => toggleEffect(target, effect.id)}
          />
          {desc.label}
        </label>
        <div className="effect-actions">
          {custom && (
            <button type="button" title="Edit the shader" onClick={() => setEditing(true)}>
              ✎
            </button>
          )}
          <button type="button" title="Move up" disabled={first} onClick={() => moveEffect(target, effect.id, -1)}>
            ↑
          </button>
          <button type="button" title="Move down" disabled={last} onClick={() => moveEffect(target, effect.id, 1)}>
            ↓
          </button>
          <button type="button" title="Reset parameters" onClick={() => resetEffect(target, effect.id)}>
            ⟲
          </button>
          <button type="button" title="Remove" onClick={() => removeEffect(target, effect.id)}>
            ✕
          </button>
        </div>
      </div>

      {desc.note && <p className="hint">{desc.note}</p>}

      {editing && (
        <ShaderDialog
          initial={effect.shader}
          onClose={() => setEditing(false)}
          onSave={(source) => {
            setEffectShader(target, effect.id, source);
            setEditing(false);
          }}
        />
      )}

      {custom && cost.failure && (
        <p className="shader-status shader-status--error">
          {cost.failure} Switch it back on with the checkbox once you have.
        </p>
      )}

      {custom && cost.ms !== null && (
        <p className="hint">
          {cost.ms.toFixed(1)} ms per frame on the GPU
          {cost.ms > 16 && ' — over a frame at 60 fps; try a lower render scale'}
        </p>
      )}

      {supportsRegion(effect.type) && (
        <div className="effect-region">
          <div className="slider-row">
            <button
              type="button"
              className={`stopwatch${regionArmed ? ' is-armed' : ''}`}
              hidden={!animatable}
              disabled={regionMode < 0.5}
              title="Animate the region: drag it at a new playhead position to add a key"
              onClick={() => {
                // All four channels move together — a region is only ever wanted whole.
                for (const channel of REGION_CHANNELS) {
                  toggleChannelArmed(clipId, { effectId: effect.id, param: channel });
                }
              }}
            >
              ⏱
            </button>
            <span className="effect-param-label">Region</span>
            <select
              value={String(Math.round(regionMode))}
              onChange={(e) => setRegionMode(target, effect.id, Number(e.target.value))}
            >
              <option value="0">Whole frame</option>
              <option value="1">Rectangle</option>
              <option value="2">Ellipse</option>
            </select>
          </div>
          {regionMode >= 0.5 && (
            <>
              <div className="slider-row effect-param">
                <span className="effect-param-label">Feather</span>
                <input
                  type="range"
                  min={0}
                  max={0.2}
                  step={0.002}
                  value={effect.params[REGION_FEATHER] ?? 0}
                  onChange={(e) =>
                    setEffectParam(target, effect.id, REGION_FEATHER, Number(e.target.value))
                  }
                />
                <span>{Math.round((effect.params[REGION_FEATHER] ?? 0) * 100)}%</span>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={(effect.params[REGION_INVERT] ?? 0) > 0.5}
                  onChange={(e) =>
                    setEffectParam(target, effect.id, REGION_INVERT, e.target.checked ? 1 : 0)
                  }
                />
                Apply outside the region instead
              </label>
              <p className="hint">Drag the box on the preview to place it.</p>
            </>
          )}
        </div>
      )}

      {desc.params.map((param) => {
        const stored = effect.params[param.name] ?? param.defaultValue;
        const keys = effect.keyframes?.[param.name];
        // A fixed control changes the program between frames, so it has no value at a
        // playhead position — it is whatever it is set to.
        const value =
          animatable && !param.fixed ? evaluateChannel(keys, playhead - clipStart, stored) : stored;
        const set = (v: number) => setEffectParam(target, effect.id, param.name, v);

        if (param.control === 'select') {
          return (
            <div className="slider-row effect-param" key={param.name}>
              <span className="effect-param-label">{param.label}</span>
              <select value={String(value)} onChange={(e) => set(Number(e.target.value))}>
                {(param.options ?? []).map((option) => (
                  <option key={option.value} value={String(option.value)}>
                    {option.label}
                  </option>
                ))}
              </select>
              {param.fixed && <span className="hint">recompiles</span>}
            </div>
          );
        }

        if (param.control === 'toggle') {
          return (
            <label className="checkbox" key={param.name}>
              <input type="checkbox" checked={value > 0.5} onChange={(e) => set(e.target.checked ? 1 : 0)} />
              {param.label}
              {param.fixed && <span className="hint"> recompiles</span>}
            </label>
          );
        }

        const armed = (keys?.length ?? 0) > 0;
        return (
          <div className="slider-row effect-param" key={param.name}>
            <button
              type="button"
              hidden={!animatable || param.fixed}
              className={`stopwatch${armed ? ' is-armed' : ''}`}
              title={
                armed
                  ? 'Stop animating this parameter (keeps the value at the playhead)'
                  : 'Animate this parameter: changing it writes a keyframe at the playhead'
              }
              onClick={() => toggleChannelArmed(clipId, { effectId: effect.id, param: param.name })}
            >
              ⏱
            </button>
            <span className="effect-param-label">{param.label}</span>
            <input
              type="range"
              min={param.min}
              max={param.max}
              step={param.step}
              value={value}
              onChange={(e) => set(Number(e.target.value))}
            />
            <span>{format(param, value)}</span>
          </div>
        );
      })}
    </li>
  );
}

/**
 * What the renderer measured for this shader, and whether it survived.
 *
 * Polled rather than subscribed: both numbers come from the render loop, which must not
 * be re-rendering React on every frame to report on itself.
 */
function useShaderCost(effectId: string | null): { ms: number | null; failure: string | null } {
  const [cost, setCost] = useState<{ ms: number | null; failure: string | null }>({
    ms: null,
    failure: null,
  });

  useEffect(() => {
    if (!effectId) {
      setCost({ ms: null, failure: null });
      return;
    }
    const read = () => setCost({ ms: shaderTime(effectId), failure: shaderFailure(effectId) });
    read();
    const timer = window.setInterval(read, 500);
    return () => window.clearInterval(timer);
  }, [effectId]);

  return cost;
}

function format(param: EffectParam, value: number): string {
  return param.format ? param.format(value) : Number(value.toFixed(2)).toString();
}
