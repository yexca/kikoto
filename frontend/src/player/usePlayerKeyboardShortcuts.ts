import { useEffect } from "react";

function isPlayerShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      "input, textarea, select, button, a, [contenteditable='true'], [role='button'], [role='slider'], [role='dialog']",
    ),
  );
}

/** Space toggles playback and the arrow keys seek, unless focus is on a control that owns those keys. */
export function usePlayerKeyboardShortcuts({
  hasTrack,
  togglePlay,
  seekBackward,
  seekForward,
}: {
  hasTrack: boolean;
  togglePlay: () => void;
  seekBackward: () => void;
  seekForward: () => void;
}) {
  useEffect(() => {
    if (!hasTrack) return;
    const handlePlayerShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isPlayerShortcutTarget(event.target)) return;
      if (event.code === "Space") {
        if (event.repeat) return;
        event.preventDefault();
        togglePlay();
        return;
      }
      const seek = event.key === "ArrowLeft" ? seekBackward : event.key === "ArrowRight" ? seekForward : null;
      if (!seek) return;
      event.preventDefault();
      seek();
    };
    window.addEventListener("keydown", handlePlayerShortcut);
    return () => window.removeEventListener("keydown", handlePlayerShortcut);
  }, [hasTrack, seekBackward, seekForward, togglePlay]);
}
