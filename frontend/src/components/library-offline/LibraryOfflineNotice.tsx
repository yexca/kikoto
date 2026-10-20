import { HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/tailwindClassNames";

/**
 * Says that local files are on a storage pool that is offline now, such as an
 * unmounted disk. Kikoto keeps them as they were and shows them again once the
 * disk is mounted, so nothing here asks the viewer to delete or re-scan them.
 */
export function LibraryOfflineNotice({ detail, className }: { detail?: string; className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-md border border-warning-border bg-warning-surface p-3 text-sm text-warning-foreground",
        className,
      )}
    >
      <HardDrive className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <div className="font-medium">{t("libraryOffline.title")}</div>
        <p className="mt-0.5 text-warning-foreground/80">{detail ?? t("libraryOffline.description")}</p>
      </div>
    </div>
  );
}
