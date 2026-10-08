import { describe, expect, it } from "vitest";

import { edgeSwipeStartsOnHorizontalGesture, handleNativeBack, type NativeBackTargets } from "@/app/nativeBack";

type Layers = {
  commandPalette?: boolean;
  commandPaletteBusy?: boolean;
  login?: boolean;
  dialog?: boolean;
  player?: boolean;
  history?: boolean;
};

function backTargets(layers: Layers) {
  const closed: string[] = [];
  const targets: NativeBackTargets = {
    commandPalette: {
      open: Boolean(layers.commandPalette),
      busy: Boolean(layers.commandPaletteBusy),
      close: () => closed.push("commandPalette"),
    },
    login: { open: Boolean(layers.login), close: () => closed.push("login") },
    closeTopLayer: () => {
      if (layers.dialog) closed.push("dialog");
      return Boolean(layers.dialog);
    },
    closePlayerLayer: () => {
      if (layers.player) closed.push("player");
      return Boolean(layers.player);
    },
    canNavigateBack: () => Boolean(layers.history),
    navigateBack: () => closed.push("history"),
  };
  return { targets, closed };
}

describe("handleNativeBack", () => {
  it("closes only the innermost layer, in the shared Android and iOS order", () => {
    const order: [Layers, string][] = [
      [{ commandPalette: true, login: true, dialog: true, player: true, history: true }, "commandPalette"],
      [{ login: true, dialog: true, player: true, history: true }, "login"],
      [{ dialog: true, player: true, history: true }, "dialog"],
      [{ player: true, history: true }, "player"],
      [{ history: true }, "history"],
    ];
    for (const [layers, expected] of order) {
      const { targets, closed } = backTargets(layers);
      expect(handleNativeBack(targets)).toBe(expected);
      expect(closed).toEqual([expected]);
    }
  });

  it("keeps a busy command palette open and closes nothing behind it", () => {
    const { targets, closed } = backTargets({
      commandPalette: true,
      commandPaletteBusy: true,
      dialog: true,
      history: true,
    });

    expect(handleNativeBack(targets)).toBe("commandPaletteBusy");
    expect(closed).toEqual([]);
  });

  it("reports the root without navigating when nothing can close", () => {
    const { targets, closed } = backTargets({});

    expect(handleNativeBack(targets)).toBe("root");
    expect(closed).toEqual([]);
  });
});

type FakeElement = {
  parentElement: FakeElement | null;
  matches(selector: string): boolean;
  scrollWidth: number;
  clientWidth: number;
  overflowX: string;
};

function element(options: Partial<FakeElement> & { attributes?: string[] } = {}): FakeElement {
  const attributes = options.attributes ?? [];
  return {
    parentElement: options.parentElement ?? null,
    matches: (selector) => selector.split(", ").some((part) => attributes.includes(part)),
    scrollWidth: options.scrollWidth ?? 100,
    clientWidth: options.clientWidth ?? 100,
    overflowX: options.overflowX ?? "visible",
  };
}

const overflowX = (target: object) => (target as FakeElement).overflowX;

describe("edgeSwipeStartsOnHorizontalGesture", () => {
  it("leaves a swipe over ordinary page content to the back gesture", () => {
    const page = element();
    const card = element({ parentElement: page });

    expect(edgeSwipeStartsOnHorizontalGesture(card, overflowX)).toBe(false);
    expect(edgeSwipeStartsOnHorizontalGesture(null, overflowX)).toBe(false);
  });

  it("yields to the compact player scrub, the mini player drag, and sliders", () => {
    for (const surface of [
      '[data-player-surface="compact"]',
      '[data-player-surface="mini"]',
      'input[type="range"]',
      '[role="slider"]',
    ]) {
      const owner = element({ attributes: [surface] });
      expect(edgeSwipeStartsOnHorizontalGesture(element({ parentElement: owner }), overflowX)).toBe(true);
    }
  });

  it("goes back from the full player so the swipe can collapse it", () => {
    const fullPlayer = element({ attributes: ['[data-player-surface="full"]'] });

    expect(edgeSwipeStartsOnHorizontalGesture(element({ parentElement: fullPlayer }), overflowX)).toBe(false);
  });

  it("yields to a horizontally scrollable region but not to clipped overflow", () => {
    const scroller = element({ scrollWidth: 400, clientWidth: 200, overflowX: "auto" });
    const clipped = element({ scrollWidth: 400, clientWidth: 200, overflowX: "hidden" });

    expect(edgeSwipeStartsOnHorizontalGesture(element({ parentElement: scroller }), overflowX)).toBe(true);
    expect(edgeSwipeStartsOnHorizontalGesture(element({ parentElement: clipped }), overflowX)).toBe(false);
  });
});
