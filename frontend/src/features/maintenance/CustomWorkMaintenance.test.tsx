import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

import "@/i18n";
import { ToastProvider } from "@/components/ui/toast";
import { CustomWorkDialog, CustomWorkNotice } from "./CustomWorkMaintenance";

describe("CustomWorkNotice", () => {
  it("asks for agreement to the folder rename before custom works unlock", () => {
    const rendered = renderToStaticMarkup(
      <ToastProvider>
        <CustomWorkNotice onAccepted={() => undefined} />
      </ToastProvider>,
    );

    expect(rendered).toContain("Before you create custom works");
    expect(rendered).toContain("Creating a custom work renames its folder on disk.");
    expect(rendered).toContain("I have read and accept this notice");
    expect(rendered).toMatch(/<button[^>]*disabled=""[^>]*>.*Accept and continue/);
  });
});

describe("CustomWorkDialog", () => {
  it("shows the folder and its new name before renaming", () => {
    const rendered = renderToStaticMarkup(
      <CustomWorkDialog
        folder={{ path: "Shelf/Example Work 1", name: "Example Work 1" }}
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
    );

    expect(rendered).toContain("Shelf/Example Work 1");
    expect(rendered).toContain("Example Work 1 [KT code]");
    expect(rendered).toContain("Kikoto renames this folder on disk.");
    expect(rendered).toContain("Rename and create");
  });
});
