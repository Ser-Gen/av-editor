import { useState } from 'react';
import type { TextTemplate } from '../types/editor';
import { TEXT_TEMPLATES } from '../utils/textStyle';

interface Props {
  onClose: () => void;
  onSubmit: (text: string, template: TextTemplate, keepInLibrary: boolean) => void;
}

export function TextAddModal({ onClose, onSubmit }: Props) {
  const [text, setText] = useState('Your text here');
  const [template, setTemplate] = useState<TextTemplate>('lowerThird');
  // Text that will be used again belongs in the library, like any other object; a one-off
  // title does not, and making everything reusable turns the library into a list of titles.
  const [keep, setKeep] = useState(false);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add text</h2>
        <label>Text</label>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        <label>Template</label>
        <select value={template} onChange={(e) => setTemplate(e.target.value as TextTemplate)}>
          {TEXT_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <p className="hint">
          {TEXT_TEMPLATES.find((t) => t.id === template)?.hint}
        </p>
        <label className="checkbox-row">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          Keep in the library, so it can be used again
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              onSubmit(text, template, keep);
              onClose();
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
