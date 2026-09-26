import { Download, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type LegacyWorkflowMigrationItem } from "@/lib/api";

/** Preserved definitions are an admin-only review surface. Exact matches can
 * create disabled preset triggers; every other graph stays exportable. */
export function LegacyWorkflowMigrationReview({ readOnly = false }: { readOnly?: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [items, setItems] = useState<LegacyWorkflowMigrationItem[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = async () => {
    try {
      setItems(await api.listLegacyWorkflowMigrations());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const action = async (id: number, kind: "convert" | "skip" | "export") => {
    setBusy(id);
    try {
      if (kind === "convert") await api.convertLegacyWorkflow(id);
      if (kind === "skip") await api.skipLegacyWorkflow(id);
      if (kind === "export") {
        const content = await api.exportLegacyWorkflow(id);
        const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `legacy-workflow-${id}.json`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (kind !== "export") await refresh();
    } catch (error) {
      toast.notify(toastFromError(error, t("librarySetup.workflowMigration.actionFailed")));
    } finally {
      setBusy(null);
    }
  };

  if (failed)
    return <p className="text-sm text-warning-foreground">{t("librarySetup.workflowMigration.loadFailed")}</p>;
  if (!items) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t("app.loading")} />;
  if (items.length === 0)
    return <p className="text-sm text-muted-foreground">{t("librarySetup.workflowMigration.empty")}</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("librarySetup.workflowMigration.notice")}</p>
      <ul className="divide-y rounded-md border">
        {items.map((item) => (
          <li key={item.id} className="space-y-2 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-sm">{item.name}</strong>
              <span className="text-xs text-muted-foreground">{item.reviewStatus}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {item.preset ? t("librarySetup.workflowMigration.match", { preset: item.preset }) : item.reason}
              {item.preset && item.reason ? ` ${item.reason}` : null}
            </p>
            {item.triggerCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("librarySetup.workflowMigration.triggers", { count: item.triggerCount })}
              </p>
            )}
            {!readOnly && (
              <div className="flex flex-wrap gap-2">
                {item.canConvert && item.reviewStatus !== "converted" && (
                  <Button size="sm" disabled={busy !== null} onClick={() => void action(item.id, "convert")}>
                    {t("librarySetup.workflowMigration.convert")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void action(item.id, "export")}
                >
                  <Download className="h-4 w-4" />
                  {t("librarySetup.workflowMigration.export")}
                </Button>
                {item.reviewStatus === "pending" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void action(item.id, "skip")}
                  >
                    {t("librarySetup.workflowMigration.later")}
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
