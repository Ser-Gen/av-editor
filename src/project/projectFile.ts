/**
 * The project file: turning the store into JSON and back.
 *
 * `doc` is exactly what `docSnapshot()` returns, so what is undoable and what is saved
 * cannot drift apart — one definition, used twice. The library travels beside it rather than
 * inside it, mirroring the fact that `mediaLibrary` is deliberately outside the undo
 * document: importing a file is not undone by pressing undo, and it is not un-saved either.
 *
 * Reading is defensive. A project file is written by an app that may have crashed halfway
 * through, and read by a version of the app that may be newer than the one that wrote it.
 * Anything unreadable returns `null` and the caller falls back to the previous copy; anything
 * *partly* readable is repaired rather than discarded, because the alternative is throwing
 * away someone's edit for a missing field.
 *
 * Pure — no OPFS, no DOM — so `check:math` can round-trip a fixture.
 */
import type {
  AssetType,
  EditorDoc,
  EditorState,
  MediaAsset,
  ProjectFile,
  StoredAsset,
} from '../types/editor';
import { PROJECT_FILE_VERSION } from '../types/editor';
import { docSnapshot } from '../store/history';
import { repairExportSettings } from '../utils/exportSettings';

const ASSET_TYPES: AssetType[] = ['video', 'audio', 'image'];

/** The live handles are session state; everything else describes the file for next time. */
export function storedAsset(asset: MediaAsset): StoredAsset {
  const { file: _file, blobUrl: _blobUrl, ...stored } = asset;
  return stored;
}

export function toProjectFile(state: EditorState): ProjectFile {
  return {
    version: PROJECT_FILE_VERSION,
    savedAt: Date.now(),
    doc: docSnapshot(state),
    // `libraryOrder` decides what the user sees; saving in that order keeps a hand-edited
    // JSON readable and makes two saves of an unchanged project byte-identical.
    assets: state.libraryOrder
      .map((id) => state.mediaLibrary[id])
      .filter((a): a is MediaAsset => !!a)
      .map(storedAsset),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readAsset(raw: unknown): StoredAsset | null {
  if (!isObject(raw)) return null;
  const id = raw.id;
  const type = raw.type;
  if (typeof id !== 'string' || typeof type !== 'string') return null;
  if (!ASSET_TYPES.includes(type as AssetType)) return null;

  const origin = raw.origin;
  return {
    id,
    type: type as AssetType,
    name: typeof raw.name === 'string' ? raw.name : id,
    duration: Math.max(0, num(raw.duration, 0)),
    width: typeof raw.width === 'number' ? raw.width : undefined,
    height: typeof raw.height === 'number' ? raw.height : undefined,
    hasAudio: typeof raw.hasAudio === 'boolean' ? raw.hasAudio : undefined,
    derivedFrom: isObject(raw.derivedFrom) ? (raw.derivedFrom as unknown as StoredAsset['derivedFrom']) : undefined,
    // An asset written before this field existed can only have been one the user picked.
    origin:
      origin === 'derived' || origin === 'recorded' || origin === 'pasted'
        ? origin
        : 'imported',
    addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : undefined,
    fingerprint: isObject(raw.fingerprint)
      ? {
          name: String(raw.fingerprint.name ?? ''),
          size: num(raw.fingerprint.size, 0),
          lastModified: num(raw.fingerprint.lastModified, 0),
        }
      : undefined,
    opfsName: typeof raw.opfsName === 'string' ? raw.opfsName : undefined,
    recordingId: typeof raw.recordingId === 'string' ? raw.recordingId : undefined,
  };
}

export interface LoadedProject {
  doc: EditorDoc;
  assets: StoredAsset[];
  savedAt: number;
  /** What had to be repaired on the way in, for the notice. Empty when the file was clean. */
  repairs: string[];
  /** True when the current file was unreadable and the rotated copy was used instead. */
  recovered?: boolean;
}

/**
 * Validate and repair. Returns `null` only when the file is too damaged to mean anything —
 * the caller then tries the previous copy.
 */
export function fromProjectFile(raw: unknown): LoadedProject | null {
  if (!isObject(raw)) return null;
  if (raw.version !== PROJECT_FILE_VERSION) return null;
  const doc = raw.doc;
  if (!isObject(doc)) return null;
  if (!isObject(doc.settings) || !Array.isArray(doc.tracks) || !Array.isArray(doc.clips)) return null;

  const repairs: string[] = [];
  const assets: StoredAsset[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.assets) ? raw.assets : []) {
    const asset = readAsset(entry);
    if (!asset || seen.has(asset.id)) continue;
    seen.add(asset.id);
    assets.push(asset);
  }

  const clips = doc.clips as EditorDoc['clips'];

  /**
   * A clip pointing at an asset the file does not describe would be invisible and
   * unrelinkable — it could never be told what it was waiting for. Giving it a placeholder
   * makes it merely offline, which is a state the whole app already handles, and leaves it
   * matchable by name if the user offers the file back.
   */
  for (const clip of clips) {
    if (!('assetId' in clip) || seen.has(clip.assetId)) continue;
    seen.add(clip.assetId);
    assets.push({
      id: clip.assetId,
      type: clip.kind === 'audio' ? 'audio' : clip.kind === 'image' ? 'image' : 'video',
      name: 'Missing file',
      duration: Math.max(0, clip.sourceTrimOut),
      origin: 'imported',
    });
    repairs.push(`a clip referenced a file the project did not describe`);
  }

  const known = new Set(assets.map((a) => a.id));
  const order = (Array.isArray(doc.libraryOrder) ? doc.libraryOrder : [])
    .filter((id: unknown): id is string => typeof id === 'string' && known.has(id));
  for (const asset of assets) {
    if (!order.includes(asset.id)) order.push(asset.id);
  }

  return {
    doc: {
      settings: doc.settings as unknown as EditorDoc['settings'],
      exportSettings: repairExportSettings(doc.exportSettings),
      tracks: doc.tracks as EditorDoc['tracks'],
      clips,
      libraryOrder: order,
      // Absent in every project saved before text objects existed, which is the normal
      // case and not a repair worth reporting.
      textLibrary: Array.isArray(doc.textLibrary)
        ? (doc.textLibrary as EditorDoc['textLibrary'])
        : [],
    },
    assets,
    savedAt: num(raw.savedAt, 0),
    repairs: [...new Set(repairs)],
  };
}

/** Round-trip helper for the check suite and for the folder bundle. */
export function parseProjectFile(text: string): LoadedProject | null {
  try {
    return fromProjectFile(JSON.parse(text));
  } catch {
    return null;
  }
}
