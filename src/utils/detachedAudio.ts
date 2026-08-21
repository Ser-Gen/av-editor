import { clipDuration } from './time';
import type { AudioClip, Clip } from '../types/editor';

/**
 * Finding a video clip's detached audio, when nothing recorded that it was detached.
 *
 * `detachAudio` records no link. It puts an audio clip on an audio track with the video
 * clip's asset, trims and start, and switches the video clip's own audio off — so the
 * relationship is a *shape*, not a field, and it survives exactly as long as the shape does.
 *
 * That is not a shortcoming to be papered over. An audio clip that has been trimmed away
 * from the range its video plays is no longer that video's soundtrack; it is a separate
 * element that happens to share a file. The two cases need different handling and this is
 * what tells them apart:
 *
 *   - **following** — still the exact range of the exact file the video plays. Replacing the
 *     video's source can re-cut it safely, because there is nothing in it to lose.
 *   - **strayed** — the same file, overlapping in time, but a different range. Re-cutting it
 *     would throw away the trim the user made. It is left alone and said out loud.
 *
 * The guard is `hasAudio && !audioEnabled`: a video whose own sound is playing has not been
 * detached, whatever else is on the audio tracks.
 */

const EPSILON = 1e-6;

export interface DetachedAudio {
  following: AudioClip[];
  strayed: AudioClip[];
}

const NONE: DetachedAudio = { following: [], strayed: [] };

export function detachedAudio(clip: Clip, clips: readonly Clip[]): DetachedAudio {
  if (clip.kind !== 'video' || !clip.hasAudio || clip.audioEnabled) return NONE;

  const start = clip.timelineStart;
  const end = start + clipDuration(clip);
  const following: AudioClip[] = [];
  const strayed: AudioClip[] = [];

  for (const other of clips) {
    if (other.kind !== 'audio' || other.assetId !== clip.assetId) continue;
    if (
      Math.abs(other.sourceTrimIn - clip.sourceTrimIn) < EPSILON &&
      Math.abs(other.sourceTrimOut - clip.sourceTrimOut) < EPSILON
    ) {
      following.push(other);
      continue;
    }
    // Same file, cut differently. Only claim it as this clip's if it is actually under it —
    // a second, unrelated use of the same asset elsewhere on the timeline is not a stray.
    const otherEnd = other.timelineStart + clipDuration(other);
    if (other.timelineStart < end - EPSILON && start < otherEnd - EPSILON) strayed.push(other);
  }

  return following.length === 0 && strayed.length === 0 ? NONE : { following, strayed };
}

/** Appended to the sentence `replaceClipSource` returns. Empty when there is nothing to add. */
export function detachedAudioOutcome(found: DetachedAudio, followed: boolean): string {
  const parts: string[] = [];
  if (followed && found.following.length > 0) {
    parts.push('Its detached audio was pointed at the new file with it.');
  } else if (found.following.length > 0) {
    parts.push('Its detached audio still plays the original file, which carries the same sound.');
  }
  if (found.strayed.length > 0) {
    parts.push(
      'Its detached audio has been trimmed since it was detached, so it was left on the ' +
        'original file rather than re-cut.',
    );
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * What to say at the replace checkbox, before anything has run. Null when the clip has no
 * detached audio and the question does not arise.
 */
export function detachedAudioAdvice(found: DetachedAudio, changesSound: boolean): string | null {
  if (found.following.length === 0 && found.strayed.length === 0) return null;

  if (!changesSound) {
    return (
      "This clip's audio is detached onto an audio track. This preset does not touch the " +
      'sound, so that clip is left playing the original file — the same audio either way.'
    );
  }
  if (found.following.length > 0 && found.strayed.length === 0) {
    return (
      "This clip's audio is detached onto an audio track, and this preset changes the sound. " +
      'That clip is pointed at the new file too, re-cut to its full length.'
    );
  }
  return (
    "This clip's audio is detached onto an audio track and has been trimmed since. This " +
    'preset changes the sound, but re-cutting that clip would throw the trim away — so it ' +
    'keeps playing the original file, and you will have processed picture over unprocessed ' +
    'sound until you replace it yourself.'
  );
}
