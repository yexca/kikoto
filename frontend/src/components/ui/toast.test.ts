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

    const unknown = toastFromError(new Error("private local path"), "安全回退");
    expect(unknown.message).toBe("安全回退");
    expect(unknown.message).not.toContain("private local path");

    await i18n.changeLanguage("en");
  });
});
