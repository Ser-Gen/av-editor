/**
 * What a 60 fps recording should do to a 30 fps project.
 *
 * Capturing at 60 and rendering at 30 throws half the captured frames away at export:
 * `quantizeToFrame` snaps every clip edge and every export frame to the project's rate, so
 * the recording would be smoother than anything the editor could produce from it. The
 * frame rate has to reach the project, not just the file.
 *
 * But it cannot simply be forced. Changing the project's frame rate re-quantizes the edges
 * of every clip already on the timeline — a destructive edit nobody asked for, arriving as
 * a side effect of pressing Stop. So the rate is adopted only where there is nothing to
 * damage: an empty timeline still on the default. Everywhere else the mismatch is reported
 * instead, and the clip keeps all 60 fps of its source either way — it renders at the
 * project's rate until the user decides otherwise in project settings.
 */

export interface ProjectRate {
  fps: number;
}

export interface FrameRateDecision {
  /** The rate to move the project to, or null to leave it alone. */
  fps: number | null;
  /** What to tell the user. Null when the recording matches and there is nothing to say. */
  notice: string | null;
}

/** Below this the two rates are the same rate; cameras report fractional values. */
const SAME_RATE = 0.5;

export function frameRateDecision(
  recordedFps: number,
  project: ProjectRate,
  clipCount: number,
  defaultFps: number,
): FrameRateDecision {
  const recorded = Math.round(recordedFps);
  if (!Number.isFinite(recorded) || recorded <= 0) return { fps: null, notice: null };
  if (recorded <= project.fps + SAME_RATE) return { fps: null, notice: null };

  if (clipCount > 0) {
    return {
      fps: null,
      notice:
        `This recording is ${recorded} fps and the project is ${project.fps}. The project was left as it is — ` +
        `changing the frame rate would re-time the clips already on the timeline. The clip holds every ` +
        `recorded frame; change the frame rate in project settings when you want it.`,
    };
  }

  if (project.fps !== defaultFps) {
    return {
      fps: null,
      notice:
        `This recording is ${recorded} fps and the project is set to ${project.fps}. That setting was ` +
        `chosen deliberately, so it was left alone — the clip still holds every recorded frame.`,
    };
  }

  return {
    fps: recorded,
    notice: `The project was empty and on the default ${project.fps} fps, so it is now ${recorded} to match the recording.`,
  };
}

/** The fastest video source in a capture session — what the project would have to match. */
export function fastestRate(formats: ({ frameRate: number } | undefined)[]): number {
  return formats.reduce((max, f) => Math.max(max, f?.frameRate ?? 0), 0);
}
