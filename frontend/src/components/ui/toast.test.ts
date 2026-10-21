import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

describe("toast error localization", () => {
  it("maps stable API codes to the active locale and hides raw errors", async () => {
    const [{ ensureUiLocale }, i18nModule, { ApiError }, { toastFromError }] = await Promise.all([
      import("@/i18n"),
      import("@/i18n"),
      import("@/lib/api"),
      import("@/components/ui/toast"),
    ]);
    const i18n = i18nModule.default;
    await ensureUiLocale("zh-Hans");
    await i18n.changeLanguage("zh-Hans");

    const databaseBusy = toastFromError(
      new ApiError("private upstream detail", 503, "database_busy", true),
      "fallback",
    );
    expect(databaseBusy.kind).toBe("warning");
    expect(databaseBusy.message).toBe("数据库繁忙，请稍后重试。");

    const demoReadOnly = toastFromError(
      new ApiError("demo mode is read-only", 403, "demo_read_only", false),
      "fallback",
    );
    expect(demoReadOnly.kind).toBe("warning");
    expect(demoReadOnly.message).toBe("演示模式为只读。");

    const unknown = toastFromError(new Error("private local path"), "安全回退");
    expect(unknown.message).toBe("安全回退");
    expect(unknown.message).not.toContain("private local path");

    await i18n.changeLanguage("en");
  });
});

describe("toast placement", () => {
  const desktop = { width: 1440, height: 900 };
  const phone = { width: 412, height: 915 };
  const header = { top: 0, bottom: 65, left: 208, right: 1440 };

  it("steps below a toolbar that starts right under the header", async () => {
    const { toastTopOffset } = await import("@/components/ui/toast");
    expect(toastTopOffset([header, { top: 85, bottom: 125, left: 232, right: 1416 }], desktop)).toBe(137);
  });

  it("keeps the top band when the only toolbar sits lower on the page", async () => {
    const { toastTopOffset } = await import("@/components/ui/toast");
    expect(toastTopOffset([header, { top: 325, bottom: 365, left: 232, right: 1416 }], desktop)).toBe(77);
    expect(
      toastTopOffset(
        [
          { top: 0, bottom: 57, left: 0, right: 412 },
          { top: 77, bottom: 121, left: 16, right: 396 },
          { top: 257, bottom: 385, left: 16, right: 396 },
        ],
        phone,
      ),
    ).toBe(133);
  });

  it("ignores toolbars outside the toast column or the viewport", async () => {
    const { toastTopOffset } = await import("@/components/ui/toast");
    expect(toastTopOffset([{ top: 85, bottom: 125, left: 232, right: 900 }], desktop)).toBe(76);
    expect(toastTopOffset([{ top: -200, bottom: -10, left: 232, right: 1416 }], desktop)).toBe(76);
  });
});
