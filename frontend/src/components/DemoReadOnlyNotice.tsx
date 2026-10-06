import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Page-level notice for Demo surfaces. Demo keeps every feature visible for
 * inspection while the server rejects writes, so each page shows the same
 * informational copy instead of a surface-specific variant.
 */
export function DemoReadOnlyNotice() {
  const { t } = useTranslation();
  return <DemoNotice message={t("permissions.demoReadOnlyNotice")} />;
}

/** Demo browse pages state that Kikoto ships no works and the sample works belong to their creators. */
export function DemoContentNotice({ surface }: { surface: "library" | "works" }) {
  const { t } = useTranslation();
  return (
    <DemoNotice
      message={surface === "library" ? t("permissions.demoLibraryNotice") : t("permissions.demoWorksNotice")}
    />
  );
}

function DemoNotice({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
