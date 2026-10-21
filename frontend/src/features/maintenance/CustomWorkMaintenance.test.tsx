import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

import "@/i18n";
import { ToastProvider } from "@/components/ui/toast";
import { CustomWorkAddDialog, CustomWorkNotice } from "./CustomWorkMaintenance";

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

describe("CustomWorkAddDialog", () => {
  it("offers the folder scan instead of walking the library when it opens", () => {
    const rendered = renderToStaticMarkup(
      <CustomWorkAddDialog onClose={() => undefined} onCreated={() => undefined} />,
    );

    expect(rendered).toContain("Found folders");
    expect(rendered).toContain("Scan library folders");
    expect(rendered).not.toContain("Before you create custom works");
    expect(rendered).toMatch(/<button[^>]*disabled=""[^>]*>Next/);
  });
});
