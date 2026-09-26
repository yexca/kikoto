import { describe, expect, it } from "vitest";

import { lockPageScroll } from "./pageScrollLock";

function fakeRoot(clientWidth: number, overflow = "") {
  const properties = new Map<string, string>();
  return {
    clientWidth,
    style: {
      overflow,
      getPropertyValue: (property: string) => properties.get(property) ?? "",
      setProperty: (property: string, value: string) => void properties.set(property, value),
      removeProperty: (property: string) => {
        const previous = properties.get(property) ?? "";
        properties.delete(property);
        return previous;
      },
    },
  };
}

describe("page scroll lock", () => {
  it("holds the page until the last nested dialog closes", () => {
    const root = fakeRoot(1265, "auto");
    const releaseOuter = lockPageScroll(root, 1280);
    const releaseInner = lockPageScroll(root, 1280);
    expect(root.style.overflow).toBe("hidden");
    expect(root.style.getPropertyValue("scrollbar-gutter")).toBe("stable");

    releaseInner();
    releaseInner();
    expect(root.style.overflow).toBe("hidden");

    releaseOuter();
    expect(root.style.overflow).toBe("auto");
    expect(root.style.getPropertyValue("scrollbar-gutter")).toBe("");
  });

  it("does not reserve a gutter when the page shows no scrollbar", () => {
    const root = fakeRoot(1280);
    const release = lockPageScroll(root, 1280);
    expect(root.style.getPropertyValue("scrollbar-gutter")).toBe("");
    release();
  });
});
