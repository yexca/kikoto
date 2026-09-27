import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Page-level notice for Demo surfaces. Demo keeps every feature visible for
 * inspection while the server rejects writes, so each page shows the same
 * informational copy instead of a surface-specific variant.
 */
export function DemoReadOnlyNotice() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground"
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span>{t("permissions.demoReadOnlyNotice")}</span>
    </div>
  );
}
