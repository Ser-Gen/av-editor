/**
 * "Something irreplaceable just landed — write the project now."
 *
 * The autosave debounce exists so that dragging a clip does not write the project sixty
 * times. It is the wrong policy for a produced file: a bake or a preset output cost minutes
 * of encoding and cannot be recreated by re-picking anything, and a reload inside that
 * 800 ms window loses the library entry while the bytes sit in OPFS unreferenced.
 *
 * A one-line signal rather than a direct call, because the store cannot import the autosave
 * that imports the store.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onProducedFile(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyProducedFile(): void {
  for (const listener of listeners) listener();
}
