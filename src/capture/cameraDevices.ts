/**
 * Which cameras exist, and what they are called.
 *
 * Two browser behaviours shape this. `enumerateDevices()` returns entries with **blank
 * labels** until a camera permission has been granted at least once — the device list is
 * fingerprinting surface, so it is withheld until the user has already agreed to be seen.
 * So the picker is deliberately usable before that: a device with no label is still
 * selectable, it is just called "Camera 2" until it can say its own name.
 *
 * And the list is not static. Cameras are unplugged, virtual ones appear when Zoom or OBS
 * starts, and a laptop lid closing can remove one mid-session. `devicechange` is the only
 * notice of that, and a picker that ignores it goes on offering a camera that is gone.
 */

export interface CameraDevice {
  deviceId: string;
  label: string;
  /** False when the browser is withholding the real label until a permission is granted. */
  named: boolean;
}

export function mediaDevicesAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.enumerateDevices;
}

/** Names the unnamed, so the dropdown is never a list of blanks. */
export function describeCameras(devices: MediaDeviceInfo[]): CameraDevice[] {
  return devices
    .filter((device) => device.kind === 'videoinput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Camera ${index + 1}`,
      named: device.label.length > 0,
    }));
}

export async function listCameras(): Promise<CameraDevice[]> {
  if (!mediaDevicesAvailable()) return [];
  try {
    return describeCameras(await navigator.mediaDevices.enumerateDevices());
  } catch {
    return [];
  }
}

/** Subscribes to plug and unplug. Returns the unsubscribe. */
export function onDeviceChange(handler: () => void): () => void {
  if (!mediaDevicesAvailable() || !navigator.mediaDevices.addEventListener) return () => undefined;
  navigator.mediaDevices.addEventListener('devicechange', handler);
  return () => navigator.mediaDevices.removeEventListener('devicechange', handler);
}

/**
 * The camera to open, given what the user chose last time.
 *
 * A remembered id that is no longer present must not be requested: with `deviceId` as an
 * `exact` constraint that is an `OverconstrainedError`, and as an `ideal` one it silently
 * opens a different camera than the panel is showing. Falling back to the first present
 * camera keeps the two honest.
 */
export function resolveCameraChoice(
  cameras: CameraDevice[],
  remembered: string | undefined,
): string | undefined {
  if (cameras.length === 0) return undefined;
  if (remembered && cameras.some((c) => c.deviceId === remembered)) return remembered;
  return cameras[0].deviceId;
}
