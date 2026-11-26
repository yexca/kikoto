/** Phones keep a card popover above the bottom navigation and player. */
export function isMobileViewport() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
}
