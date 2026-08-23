/**
 * Asking the user for files, keeping the handle where the browser gives one.
 *
 * `showOpenFilePicker` returns handles, which can be stored and *may* reopen silently next
 * time; a plain `<input type="file">` returns bytes and nothing else. Both are supported
 * because the picker is Chromium-only and relinking is the path every reopened project takes.
 */
import type { RelinkInput } from '../store/editorStore';

interface PickerWindow {
  showOpenFilePicker?(options: {
    multiple?: boolean;
    types?: { description: string; accept: Record<string, string[]> }[];
  }): Promise<FileSystemFileHandle[]>;
}

const MEDIA_ACCEPT: Record<string, string[]> = {
  'video/*': ['.mp4', '.mov', '.webm', '.mkv', '.m4v'],
  'audio/*': ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac'],
  'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'],
};

function viaInput(multiple: boolean): Promise<RelinkInput[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = 'video/*,audio/*,image/*';
    // A cancelled picker fires nothing in most browsers, so the promise is settled by the
    // first of `change` or the window regaining focus — otherwise it would hang forever.
    let settled = false;
    const done = (files: RelinkInput[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      resolve(files);
    };
    const onFocus = () => setTimeout(() => done([]), 500);
    input.onchange = () => done(Array.from(input.files ?? []).map((file) => ({ file })));
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

export async function pickMediaFiles(multiple = true): Promise<RelinkInput[]> {
  const picker = window as unknown as PickerWindow;
  if (!picker.showOpenFilePicker) return viaInput(multiple);
  try {
    const handles = await picker.showOpenFilePicker({
      multiple,
      types: [{ description: 'Media', accept: MEDIA_ACCEPT }],
    });
    return Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
  } catch {
    // The user dismissed the picker. Not an error, and nothing to relink.
    return [];
  }
}
