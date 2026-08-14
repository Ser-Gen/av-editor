import { useState } from 'react';
import type { TextTemplate } from '../types/editor';

interface Props {
  onClose: () => void;
  onSubmit: (text: string, template: TextTemplate) => void;
}

export function TextAddModal({ onClose, onSubmit }: Props) {
  const [text, setText] = useState('Your text here');
  const [template, setTemplate] = useState<TextTemplate>('lowerThird');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add text</h2>
        <label>Text</label>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        <label>Template</label>
        <select value={template} onChange={(e) => setTemplate(e.target.value as TextTemplate)}>
          <option value="lowerThird">Lower third</option>
          <option value="centerTitle">Center title</option>
          <option value="subtitle">Subtitle</option>
        </select>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              onSubmit(text, template);
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
