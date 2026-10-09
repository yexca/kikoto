import { useCallback, useEffect, useRef, useState } from "react";

import { addNativeAudioOutputListener, nativeAudioOutput, supportsNativePrivacy } from "@/lib/nativePrivacy";

/**
 * Whether starting playback through the device's own speaker asks first. The
 * choice belongs to the device rather than an account, like the other privacy
 * choices, and is on by default. Only shells that report their audio output
 * apply it.
 */
export const SPEAKER_GUARD_STORAGE_KEY = "kikoto:speaker-guard:v1";
export const SPEAKER_GUARD_CHANGE_EVENT = "kikoto:speaker-guard-change";

export function getSpeakerGuardEnabled() {
  try {
    return localStorage.getItem(SPEAKER_GUARD_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function storeSpeakerGuardEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(SPEAKER_GUARD_STORAGE_KEY);
    else localStorage.setItem(SPEAKER_GUARD_STORAGE_KEY, "false");
  } catch {
    // The choice still applies to this page when browser storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<boolean>(SPEAKER_GUARD_CHANGE_EVENT, { detail: enabled }));
}

export function useSpeakerGuardEnabled() {
  const [enabled, setEnabled] = useState(getSpeakerGuardEnabled);
  useEffect(() => {
    const syncCustomEvent = (event: Event) => setEnabled((event as CustomEvent<boolean>).detail !== false);
    const syncStorageEvent = (event: StorageEvent) => {
      if (event.key === SPEAKER_GUARD_STORAGE_KEY) setEnabled(getSpeakerGuardEnabled());
    };
    window.addEventListener(SPEAKER_GUARD_CHANGE_EVENT, syncCustomEvent);
    window.addEventListener("storage", syncStorageEvent);
    return () => {
      window.removeEventListener(SPEAKER_GUARD_CHANGE_EVENT, syncCustomEvent);
      window.removeEventListener("storage", syncStorageEvent);
    };
  }, []);
  return enabled;
}

/**
 * Decides whether a start may play through the speaker. A confirmed start
 * allows the speaker until the output moves to headphones or another device;
 * coming back to the speaker asks again.
 */
export class SpeakerGuardState {
  private speaker = false;
  private allowed = false;

  setOutput(speaker: boolean) {
    this.speaker = speaker;
    if (!speaker) this.allowed = false;
  }

  allowsStart(enabled: boolean) {
    return !enabled || !this.speaker || this.allowed;
  }

  allowSpeaker() {
    this.allowed = true;
  }
}

/**
 * The player's speaker guard. `allowsStart` is synchronous so the play intent
 * can be held in the same call; a held start opens the confirmation instead.
 */
export function useSpeakerGuard() {
  const enabled = useSpeakerGuardEnabled();
  const [state] = useState(() => new SpeakerGuardState());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [prompting, setPrompting] = useState(false);

  useEffect(() => {
    if (!supportsNativePrivacy()) return;
    let disposed = false;
    let removeListener: (() => void) | null = null;
    const apply = (speaker: boolean) => {
      state.setOutput(speaker);
      // Headphones connected while asking: the start no longer needs the speaker.
      if (!speaker) setPrompting(false);
    };
    nativeAudioOutput()
      .then((output) => {
        if (!disposed && output) apply(output.speaker);
      })
      .catch(() => {});
    void addNativeAudioOutputListener((output) => apply(output.speaker)).then((remove) => {
      if (disposed) remove();
      else removeListener = remove;
    });
    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [state]);

  useEffect(() => {
    if (!enabled) setPrompting(false);
  }, [enabled]);

  const allowsStart = useCallback(() => {
    if (state.allowsStart(enabledRef.current)) return true;
    setPrompting(true);
    return false;
  }, [state]);

  const allowSpeaker = useCallback(() => {
    state.allowSpeaker();
    setPrompting(false);
  }, [state]);

  const dismiss = useCallback(() => setPrompting(false), []);

  return { allowsStart, prompting, allowSpeaker, dismiss };
}
