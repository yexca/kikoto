/**
 * Holds playback starts on the phone speaker until the listener confirms.
 * One confirmation covers a speaker period: connecting or disconnecting an
 * audio output starts a new one. An unknown output is checked before anything
 * plays, and a start that turns out not to use the speaker is replayed.
 */
export function createSpeakerPlaybackGuard({
  isEnabled,
  queryPhoneSpeaker,
  requestConfirmation,
  dismissConfirmation,
  replay,
}: {
  isEnabled: () => boolean;
  /** Resolves null when the shell cannot tell. */
  queryPhoneSpeaker: () => Promise<boolean | null>;
  requestConfirmation: () => void;
  dismissConfirmation: () => void;
  replay: () => void;
}) {
  let phoneSpeaker: boolean | null = null;
  let confirmed = false;

  return {
    /** Returns false when the start must wait. */
    allowStart() {
      if (!isEnabled() || confirmed || phoneSpeaker === false) return true;
      if (phoneSpeaker === true) {
        requestConfirmation();
        return false;
      }
      void queryPhoneSpeaker().then((current) => {
        if (phoneSpeaker === null) phoneSpeaker = current;
        if (current === false) replay();
        else requestConfirmation();
      });
      return false;
    },
    /** Records the first known output without starting a new speaker period. */
    initializeOutput(current: boolean | null) {
      if (phoneSpeaker === null) phoneSpeaker = current;
    },
    outputChanged(current: boolean) {
      if (phoneSpeaker === current) return;
      phoneSpeaker = current;
      confirmed = false;
      if (!current) dismissConfirmation();
    },
    confirm() {
      confirmed = true;
      dismissConfirmation();
      replay();
    },
  };
}

export type SpeakerPlaybackGuard = ReturnType<typeof createSpeakerPlaybackGuard>;
