/** Transport controls exposed to the operating system and the native app shell. */
export type PlayerRemoteControls = {
  play: () => void;
  pause: () => void;
  previous: () => void;
  next: () => void;
  seekBackward: () => void;
  seekForward: () => void;
  seekTo: (seconds: number) => void;
};

type MediaSessionActionTarget = Pick<MediaSession, "setActionHandler">;

const MEDIA_SESSION_ACTIONS = [
  "play",
  "pause",
  "previoustrack",
  "nexttrack",
  "seekbackward",
  "seekforward",
  "seekto",
] as const satisfies readonly MediaSessionAction[];

/**
 * Registers Media Session action handlers that resolve the controls when the
 * action arrives. The handlers stay registered across renders, so they must
 * not capture one render's queue, index, or play mode. Returns the cleanup.
 */
export function bindMediaSessionActions(session: MediaSessionActionTarget, controls: () => PlayerRemoteControls) {
  const handlers: Record<(typeof MEDIA_SESSION_ACTIONS)[number], MediaSessionActionHandler> = {
    play: () => controls().play(),
    pause: () => controls().pause(),
    previoustrack: () => controls().previous(),
    nexttrack: () => controls().next(),
    seekbackward: () => controls().seekBackward(),
    seekforward: () => controls().seekForward(),
    seekto: (details) => controls().seekTo(details.seekTime ?? 0),
  };
  for (const action of MEDIA_SESSION_ACTIONS) {
    try {
      session.setActionHandler(action, handlers[action]);
    } catch {
      // Some browsers expose Media Session but not every action.
    }
  }
  return () => {
    for (const action of MEDIA_SESSION_ACTIONS) {
      try {
        session.setActionHandler(action, null);
      } catch {
        // Ignore unsupported cleanup actions.
      }
    }
  };
}
