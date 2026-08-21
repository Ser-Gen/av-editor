/**
 * Hardware media keys.
 *
 * With no action handlers registered, Chrome's default for the play key is to resume the
 * page's *most recently played media element* directly. In an editor that is never right:
 * the elements are the engine's private decoders, one per asset, held in a pool and driven
 * against the project clock. Resuming one of them plays a file at whatever `currentTime` it
 * was abandoned at, with the engine's own `playing` flag still false — so nothing advances
 * the playhead, nothing draws, and nothing ever stops it. The clip it belonged to need not
 * even still exist.
 *
 * Claiming the session is what makes the keys mean "play the project". The handlers are the
 * same store actions the transport buttons call, so there is one way to start playback and
 * one way to stop it, whichever surface asked.
 */

/** Actions we claim. `stop` is here to take it off Chrome's hands, not because it does more. */
const CLAIMED = ['play', 'pause', 'stop'] as const;

export interface MediaKeyActions {
  play: () => void;
  pause: () => void;
}

/** Returns a cleanup that hands the session back. */
export function bindMediaKeys(actions: MediaKeyActions): () => void {
  const session = navigator.mediaSession;
  if (!session) return () => {};

  // An unimplemented action throws rather than returning anything, and which ones exist
  // varies by browser and by version — so each is claimed on its own.
  const claim = (action: MediaSessionAction, handler: (() => void) | null) => {
    try {
      session.setActionHandler(action, handler);
    } catch {
      /* not supported here */
    }
  };

  claim('play', actions.play);
  claim('pause', actions.pause);
  // A media "stop" conventionally rewinds as well. It does not here: the playhead is an edit
  // position, and a key on a keyboard should not move it somewhere the user has to find
  // their way back from.
  claim('stop', actions.pause);

  return () => {
    for (const action of CLAIMED) claim(action, null);
    session.playbackState = 'none';
  };
}

/** Keeps the OS control showing the transport's real state rather than an element's. */
export function setMediaPlaybackState(playing: boolean): void {
  const session = navigator.mediaSession;
  if (!session) return;
  session.playbackState = playing ? 'playing' : 'paused';
}
