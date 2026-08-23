import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { InputAudioTrack, InputVideoTrack } from 'mediabunny';
import type { MediaAsset } from '../../types/editor';

/**
 * One demuxer per asset, shared by every clip that references it. Opening an `Input`
 * is cheap but not free, and several clips commonly cut from the same source file.
 */
export class MediaInputCache {
  private inputs = new Map<string, Input>();

  private input(asset: MediaAsset): Input {
    let input = this.inputs.get(asset.id);
    if (!input) {
      // Guarded by `exportBlockedBy` long before this. Failing loudly rather than encoding
      // a silent black rectangle is the whole reason that guard exists.
      if (!asset.file) throw new Error(`"${asset.name}" is offline — relink it before exporting.`);
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(asset.file) });
      this.inputs.set(asset.id, input);
    }
    return input;
  }

  async videoTrack(asset: MediaAsset): Promise<InputVideoTrack | null> {
    try {
      const tracks = await this.input(asset).getVideoTracks();
      return tracks[0] ?? null;
    } catch (e) {
      console.warn('[Export/WC] no readable video track in', asset.name, e);
      return null;
    }
  }

  async audioTrack(asset: MediaAsset): Promise<InputAudioTrack | null> {
    try {
      const tracks = await this.input(asset).getAudioTracks();
      return tracks[0] ?? null;
    } catch (e) {
      console.warn('[Export/WC] no readable audio track in', asset.name, e);
      return null;
    }
  }

  dispose(): void {
    for (const input of this.inputs.values()) {
      try {
        input.dispose();
      } catch {
        // Disposal is best-effort; a half-opened input is not worth failing the export.
      }
    }
    this.inputs.clear();
  }
}
