export const MINI_POSITION_STORAGE_KEY = "kikoto:player-mini-position:v1";
/** Rendered Mini player diameter in pixels. */
export const MINI_PLAYER_SIZE = 92;
const MINI_EDGE_GAP = 8;

export type MiniPosition = { x: number; y: number };

export function safeAreaBottom() {
  const footer = document.querySelector("footer");
  return footer ? Number.parseFloat(window.getComputedStyle(footer).paddingBottom) || 0 : 0;
}

function miniVerticalBounds() {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const bottomLimit = 84 + safeAreaBottom();
  return { min: MINI_EDGE_GAP, max: Math.max(MINI_EDGE_GAP, viewportHeight - MINI_PLAYER_SIZE - bottomLimit) };
}

export function miniRightEdgeX() {
  return window.innerWidth - MINI_PLAYER_SIZE - MINI_EDGE_GAP;
}

export function clampMiniPosition(position: MiniPosition) {
  const bounds = miniVerticalBounds();
  return {
    x: Math.max(MINI_EDGE_GAP, Math.min(miniRightEdgeX(), position.x)),
    y: Math.max(bounds.min, Math.min(bounds.max, position.y)),
  };
}

export function restoreMiniPosition(): MiniPosition | null {
  try {
    const stored = JSON.parse(localStorage.getItem(MINI_POSITION_STORAGE_KEY) ?? "null") as {
      side?: "left" | "right";
      verticalRatio?: number;
    } | null;
    if (!stored || (stored.side !== "left" && stored.side !== "right") || !Number.isFinite(stored.verticalRatio))
      return null;
    const bounds = miniVerticalBounds();
    const ratio = Math.max(0, Math.min(1, Number(stored.verticalRatio)));
    return {
      x: stored.side === "left" ? MINI_EDGE_GAP : miniRightEdgeX(),
      y: bounds.min + (bounds.max - bounds.min) * ratio,
    };
  } catch {
    return null;
  }
}

export function persistMiniPosition(position: MiniPosition) {
  const bounds = miniVerticalBounds();
  const verticalRatio = bounds.max > bounds.min ? (position.y - bounds.min) / (bounds.max - bounds.min) : 0;
  try {
    localStorage.setItem(
      MINI_POSITION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        side: position.x + MINI_PLAYER_SIZE / 2 < window.innerWidth / 2 ? "left" : "right",
        verticalRatio: Math.max(0, Math.min(1, verticalRatio)),
      }),
    );
  } catch {
    // The Mini player keeps its in-memory position when storage is unavailable.
  }
}

export function snapMiniPosition(rect: { left: number; top: number }) {
  const snappedX = rect.left + MINI_PLAYER_SIZE / 2 < window.innerWidth / 2 ? MINI_EDGE_GAP : miniRightEdgeX();
  return clampMiniPosition({ x: snappedX, y: rect.top });
}

export function miniActionLayout(position: MiniPosition | null) {
  const fallbackX = typeof window === "undefined" ? 9999 : window.innerWidth - 104;
  const fallbackY = typeof window === "undefined" ? 9999 : window.innerHeight - 168;
  const centerX = (position?.x ?? fallbackX) + MINI_PLAYER_SIZE / 2;
  const centerY = (position?.y ?? fallbackY) + MINI_PLAYER_SIZE / 2;
  const horizontalToLeft = typeof window === "undefined" ? true : centerX > window.innerWidth / 2;
  const verticalToTop = typeof window === "undefined" ? true : centerY > window.innerHeight / 2;
  return {
    compactClass: horizontalToLeft
      ? "left-0 top-1/2 -translate-x-[calc(100%+10px)] -translate-y-1/2"
      : "right-0 top-1/2 translate-x-[calc(100%+10px)] -translate-y-1/2",
    fullClass: verticalToTop
      ? "left-1/2 top-0 -translate-x-1/2 -translate-y-[calc(100%+10px)]"
      : "bottom-0 left-1/2 -translate-x-1/2 translate-y-[calc(100%+10px)]",
  };
}
