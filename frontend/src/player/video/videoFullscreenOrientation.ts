import {
  lockNativeVideoFullscreenLandscape,
  supportsNativeVideoFullscreen,
  unlockNativeVideoFullscreenOrientation,
} from "@/lib/nativeVideoFullscreen";

/** Turns the screen to landscape and releases it again. */
export type LandscapeLock = {
  lock: () => Promise<void>;
  unlock: () => void;
};

type LockableOrientation = {
  lock?: (orientation: "landscape") => Promise<void>;
  unlock?: () => void;
};

/**
 * The landscape lock of this shell: the native one where the shell shows
 * WebView fullscreen itself, otherwise the Screen Orientation API, or null
 * where neither exists. Browsers without a lockable screen, such as desktop
 * browsers and iOS, reject the lock, which leaves the screen as it is.
 */
export function videoLandscapeLock(): LandscapeLock | null {
  if (supportsNativeVideoFullscreen()) {
    return {
      lock: lockNativeVideoFullscreenLandscape,
      unlock: () => void unlockNativeVideoFullscreenOrientation().catch(() => undefined),
    };
  }
  const orientation = (typeof screen === "undefined" ? undefined : screen.orientation) as
    LockableOrientation | undefined;
  const lock = orientation?.lock;
  if (!orientation || typeof lock !== "function") return null;
  return {
    lock: () => lock.call(orientation, "landscape"),
    unlock: () => {
      try {
        orientation.unlock?.();
      } catch {
        // A screen that was never locked has nothing to release.
      }
    },
  };
}

type FullscreenDocument = Pick<Document, "addEventListener" | "removeEventListener"> & {
  readonly fullscreenElement: Element | null;
};

/**
 * Locks the screen to landscape while `video` is fullscreen and wider than it
 * is tall, whether the video controls, a shortcut, or the page entered
 * fullscreen, and releases it when fullscreen ends. A video whose size is not
 * known yet is checked again once its metadata arrives. Returns the cleanup.
 */
export function watchVideoFullscreenOrientation(
  video: HTMLVideoElement,
  doc: FullscreenDocument,
  landscape: LandscapeLock,
) {
  let locked = false;
  const update = () => {
    const fullscreen = doc.fullscreenElement;
    const wanted = fullscreen !== null && fullscreen.contains(video) && video.videoWidth > video.videoHeight;
    if (wanted && !locked) {
      locked = true;
      landscape.lock().catch(() => {
        locked = false;
      });
    } else if (!wanted && locked) {
      locked = false;
      landscape.unlock();
    }
  };
  doc.addEventListener("fullscreenchange", update);
  video.addEventListener("resize", update);
  return () => {
    doc.removeEventListener("fullscreenchange", update);
    video.removeEventListener("resize", update);
    if (locked) {
      locked = false;
      landscape.unlock();
    }
  };
}
