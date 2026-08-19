import { openScratchFile } from '../export/webcodecs/opfs';
import type { ScratchFile } from '../export/webcodecs/opfs';

/** Repair output goes beside the raw capture, so recovery can find both. */
export function openRecordingScratch(name: string): Promise<ScratchFile> {
  return openScratchFile(name, 'recordings');
}
