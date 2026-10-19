import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./clipboard";

describe("copyText", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the Clipboard API in a secure context", async () => {
    const page = stubPage({ secure: true, writeText: () => Promise.resolve() });

    await copyText("RJ00000001");

    expect(page.writeText).toHaveBeenCalledWith("RJ00000001");
    expect(page.execCommand).not.toHaveBeenCalled();
  });

  it("copies through a selection over plain HTTP, where the Clipboard API is absent", async () => {
    const page = stubPage({ secure: false });

    await copyText("RJ00000001");

    expect(page.execCommand).toHaveBeenCalledWith("copy");
    expect(page.selectedText).toEqual(["RJ00000001"]);
    expect(page.area.remove).toHaveBeenCalled();
    expect(page.focused.focus).toHaveBeenCalled();
  });

  it("falls back to a selection copy when clipboard permission is denied", async () => {
    const page = stubPage({ secure: true, writeText: () => Promise.reject(new Error("NotAllowedError")) });

    await copyText("RJ00000001");

    expect(page.writeText).toHaveBeenCalled();
    expect(page.execCommand).toHaveBeenCalledWith("copy");
  });

  it("rejects when neither path copies", async () => {
    const page = stubPage({ secure: false, execCommandResult: false });

    await expect(copyText("RJ00000001")).rejects.toThrow();
    expect(page.area.remove).toHaveBeenCalled();
  });
});

function stubPage({
  secure,
  writeText,
  execCommandResult = true,
}: {
  secure: boolean;
  writeText?: (text: string) => Promise<void>;
  execCommandResult?: boolean;
}) {
  const selectedText: string[] = [];
  const area = {
    value: "",
    style: { cssText: "" },
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    // iOS selects a read-only field's text only through an explicit range.
    setSelectionRange: vi.fn((start: number, end: number) => selectedText.push(area.value.slice(start, end))),
    remove: vi.fn(),
  };
  const focused = { focus: vi.fn() };
  const execCommand = vi.fn(() => execCommandResult);
  const writeTextMock = writeText ? vi.fn(writeText) : undefined;
  vi.stubGlobal("window", { isSecureContext: secure });
  // A non-secure context exposes no navigator.clipboard at all.
  vi.stubGlobal("navigator", writeTextMock ? { clipboard: { writeText: writeTextMock } } : {});
  vi.stubGlobal("document", {
    activeElement: focused,
    body: { append: vi.fn() },
    createElement: vi.fn(() => area),
    execCommand,
  });
  return { area, focused, execCommand, selectedText, writeText: writeTextMock };
}
