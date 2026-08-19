import { describe, expect, it, vi } from "vitest";

import { dismissKeyboardOnEnter } from "./keyboard";

function keyboardEvent(overrides: Record<string, unknown> = {}) {
  const blur = vi.fn();
  const preventDefault = vi.fn();
  return {
    key: "Enter",
    keyCode: 13,
    nativeEvent: { isComposing: false },
    currentTarget: { blur },
    preventDefault,
    ...overrides,
  } as unknown as React.KeyboardEvent<HTMLInputElement>;
}

describe("dismissKeyboardOnEnter", () => {
  it("prevents the default and blurs an ordinary Enter key", () => {
    const event = keyboardEvent();
    dismissKeyboardOnEnter(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.currentTarget.blur).toHaveBeenCalledOnce();
  });

  it.each([{ key: "Escape" }, { keyCode: 229 }, { nativeEvent: { isComposing: true } }])(
    "leaves composition and non-Enter input alone (%j)",
    (override) => {
      const event = keyboardEvent(override);
      dismissKeyboardOnEnter(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.currentTarget.blur).not.toHaveBeenCalled();
    },
  );
});
