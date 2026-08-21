import { useMemo, useState } from 'react';
import { parseShader, shaderControls } from '../render/effects/customShader';
import { SHADER_PRESETS } from '../render/effects/shaderPresets';
import { checkShader } from '../render/effects/validateShader';
import { paramDefaults } from '../render/effects/registry';

interface Props {
  /** Existing source when editing; empty when adding. */
  initial?: string;
  onSave: (source: string) => void;
  onClose: () => void;
}

/**
 * The shader editor.
 *
 * Two things make this more than a text box. It compiles what is typed, in a throwaway
 * context, and puts the log next to the text — a shader that fails at render time is
 * otherwise indistinguishable from one that does nothing. And it reads back what the
 * annotations produced: how many stages, which channels, which controls, and which of
 * those recompile rather than animate. Both answer the question the box itself cannot:
 * "is this going to do what I meant?"
 */
export function ShaderDialog({ initial, onSave, onClose }: Props) {
  const [source, setSource] = useState(initial ?? SHADER_PRESETS[0].source);
  const [preset, setPreset] = useState('');

  const parsed = useMemo(() => parseShader(source), [source]);
  // Compiled against the annotated defaults: the editor is checking the shader, not
  // whatever the sliders happen to be at.
  const check = useMemo(
    () => checkShader(parsed, paramDefaults(shaderControls(parsed))),
    [parsed],
  );

  const animatable = parsed.params.length + (parsed.usesMouse ? 2 : 0);
  const recompiling = parsed.defines.length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-shader" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Edit shader' : 'Add a shader'}</h2>

        <div className="shader-presets">
          <label>Start from</label>
          <select
            value={preset}
            onChange={(e) => {
              const found = SHADER_PRESETS.find((p) => p.id === e.target.value);
              setPreset(e.target.value);
              if (found) setSource(found.source);
            }}
          >
            <option value="">…</option>
            {SHADER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <span className="hint">
            {SHADER_PRESETS.find((p) => p.id === preset)?.note ??
              'A Shadertoy fragment shader pastes in unchanged. Annotations add the controls.'}
          </span>
        </div>

        <textarea
          className="shader-source"
          spellCheck={false}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />

        {check.ok ? (
          <p className="shader-status shader-status--ok">
            Compiles. {parsed.stages.length === 1 ? 'One pass' : `${parsed.stages.length} stages`}
            {animatable > 0 && `, ${animatable} animatable control${animatable === 1 ? '' : 's'}`}
            {recompiling > 0 && `, ${recompiling} that recompile${recompiling === 1 ? 's' : ''}`}.
          </p>
        ) : (
          <pre className="shader-status shader-status--error">{check.errors.join('\n')}</pre>
        )}

        {parsed.problems.length > 0 && (
          <ul className="shader-problems">
            {parsed.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}

        <details className="disclosure">
          <summary>What the annotations did</summary>
          <table className="shader-summary">
            <tbody>
              {parsed.stages.map((stage) => (
                <tr key={stage.name}>
                  <th>{stage.name}</th>
                  <td>
                    {stage.channels
                      .map((c) => `iChannel${c.index} = ${channelLabel(c.source)} (${c.wrap}, ${c.filter})`)
                      .join(' · ')}
                  </td>
                </tr>
              ))}
              {parsed.params.map((param, index) => (
                <tr key={param.name}>
                  <th>{param.label}</th>
                  <td>
                    <code>{param.name}</code> = uP[{index}] · {param.min} … {param.max}, default{' '}
                    {param.defaultValue}
                  </td>
                </tr>
              ))}
              {parsed.defines.map((define) => (
                <tr key={define.name}>
                  <th>{define.name}</th>
                  <td>
                    {define.values ? define.values.join(' / ') : 'on / off'} — recompiles, so it
                    cannot be keyframed
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>

        <p className="hint">
          A stage may sample <code>input</code>, a generated pattern, or a stage declared before
          it — never its own previous frame, so scrubbing to a moment gives the same picture as
          playing to it.
        </p>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!check.ok || source.trim().length === 0}
            onClick={() => onSave(source)}
          >
            {initial ? 'Save' : 'Add effect'}
          </button>
        </div>
      </div>
    </div>
  );
}

function channelLabel(source: { kind: string; stage?: string; pattern?: string }): string {
  if (source.kind === 'input') return 'input';
  if (source.kind === 'stage') return source.stage ?? '?';
  return source.pattern ?? '?';
}
