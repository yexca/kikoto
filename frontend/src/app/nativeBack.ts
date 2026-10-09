import { NATIVE_BACK_EVENT } from "@/lib/appEvents";

/** The layer a native back request closed, or why it did nothing. */
export type NativeBackStep =
  "commandPaletteBusy" | "commandPalette" | "login" | "dialog" | "player" | "history" | "root";

export type NativeBackTargets = {
  commandPalette: { open: boolean; busy: boolean; close(): void };
  login: { open: boolean; close(): void };
  /** Closes the topmost dialog, sheet, or popover; false when none is open. */
  closeTopLayer(): boolean;
  /** Lets the player close its own panels or collapse; false when it did not. */
  closePlayerLayer(): boolean;
  canNavigateBack(): boolean;
  navigateBack(): void;
};

/**
 * Applies one back request from a native shell, closing the innermost layer
 * first. The Android back button and the iOS edge swipe share this order. A
 * "root" result changed nothing; each platform decides what that means.
 */
export function handleNativeBack(targets: NativeBackTargets): NativeBackStep {
  if (targets.commandPalette.open) {
    if (targets.commandPalette.busy) return "commandPaletteBusy";
    targets.commandPalette.close();
    return "commandPalette";
  }
  if (targets.login.open) {
    targets.login.close();
    return "login";
  }
  if (targets.closeTopLayer()) return "dialog";
  if (targets.closePlayerLayer()) return "player";
  if (targets.canNavigateBack()) {
    targets.navigateBack();
    return "history";
  }
  return "root";
}

const backCloseableLayerSelector = "[data-android-back-close], [role='dialog']";

export function closeTopDocumentLayer() {
  if (!document.querySelector(backCloseableLayerSelector)) return false;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return true;
}

export function closePlayerLayer() {
  const event = new CustomEvent(NATIVE_BACK_EVENT, { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/** The Library root has no in-app entry to return to. */
export function canNavigateHistoryBack() {
  return window.history.length > 1 && window.location.pathname !== "/";
}

type GestureElement = {
  parentElement: GestureElement | null;
  matches(selector: string): boolean;
  scrollWidth: number;
  clientWidth: number;
};

/** Surfaces that own a horizontal drag of their own. */
const horizontalGestureSurfaceSelector =
  '[data-player-surface="compact"], [data-player-surface="mini"], input[type="range"], [role="slider"]';

/**
 * Whether an edge swipe that started on this element belongs to the content
 * under it: a player scrub or drag, a slider, or a horizontally scrollable
 * region. Such a swipe must not also go back.
 */
export function edgeSwipeStartsOnHorizontalGesture(
  element: GestureElement | null,
  overflowX: (element: GestureElement) => string,
) {
  for (let current = element; current; current = current.parentElement) {
    if (current.matches(horizontalGestureSurfaceSelector)) return true;
    if (current.scrollWidth > current.clientWidth) {
      const overflow = overflowX(current);
      if (overflow === "auto" || overflow === "scroll") return true;
    }
  }
  return false;
}
