import { useEffect, useRef, useState } from "react";

import { useNativePrivacySettings } from "@/hooks/useNativePrivacySettings";
import { addNativeOutputListener, nativeOutputIsPhoneSpeaker, supportsNativePrivacy } from "@/lib/nativePrivacy";

import { createSpeakerPlaybackGuard } from "./speakerPlaybackGuard";
import type { PlaybackRefs } from "./usePlaybackEngine";

const allowPlaybackStart = () => true;

/**
 * Installs the speaker confirmation as the engine's start guard.
 * Every start passes through that guard, so player buttons, queue actions,
 * notification and lock screen controls, and media keys all wait for the same
 * confirmation in the app.
 */
export function useSpeakerPlaybackGuard({ refs, play }: { refs: PlaybackRefs; play: () => void }) {
  const { settings } = useNativePrivacySettings();
  const [confirming, setConfirming] = useState(false);
  // Until the shell answers, the default (on) applies.
  const enabledRef = useRef(supportsNativePrivacy() && settings.speakerConfirm);
  const playRef = useRef(play);
  const [guard] = useState(() =>
    createSpeakerPlaybackGuard({
      isEnabled: () => enabledRef.current,
      queryPhoneSpeaker: nativeOutputIsPhoneSpeaker,
      requestConfirmation: () => setConfirming(true),
      dismissConfirmation: () => setConfirming(false),
      replay: () => playRef.current(),
    }),
  );

  useEffect(() => {
    enabledRef.current = supportsNativePrivacy() && settings.speakerConfirm;
    playRef.current = play;
  });

  useEffect(() => {
    if (!supportsNativePrivacy()) return;
    let disposed = false;
    let removeListener: (() => void) | null = null;
    void nativeOutputIsPhoneSpeaker().then((phoneSpeaker) => {
      if (!disposed) guard.initializeOutput(phoneSpeaker);
    });
    void addNativeOutputListener(guard.outputChanged).then((remove) => {
      if (disposed) remove();
      else removeListener = remove;
    });
    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [guard]);

  useEffect(() => {
    const startGuardRef = refs.playbackStartGuardRef;
    startGuardRef.current = guard.allowStart;
    return () => {
      startGuardRef.current = allowPlaybackStart;
    };
  }, [guard, refs]);

  return { confirming, confirm: guard.confirm, cancel: () => setConfirming(false) };
}
