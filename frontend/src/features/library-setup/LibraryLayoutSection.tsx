import { useTranslation } from "react-i18next";

import { SettingsSection } from "@/components/settings/SettingsSection";
import type { LibraryLayout } from "@/lib/api";

import { LibraryLayoutEditor } from "./LibraryLayoutEditor";
import { LegacyWorkflowMigrationReview } from "./LegacyWorkflowMigrationReview";

/** Settings -> Library: the library mode, storage pools, and Fetch pool. */
export function LibraryLayoutSection({
  id,
  layout,
  failed,
  readOnly,
  onSaved,
}: {
  id?: string;
  layout: LibraryLayout | null;
  failed: boolean;
  readOnly: boolean;
  onSaved: (layout: LibraryLayout) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSection id={id} title={t("librarySetup.title")} description={t("librarySetup.description")}>
      <div className="px-4 py-3">
        {layout ? (
          <div className="space-y-7">
            <LibraryLayoutEditor key={layoutKey(layout)} layout={layout} readOnly={readOnly} onSaved={onSaved} />
            {!readOnly && layout.hasLegacyWorkflows && (
              <section className="space-y-3 border-t pt-5">
                <h3 className="text-sm font-semibold">{t("librarySetup.workflowMigration.title")}</h3>
                <LegacyWorkflowMigrationReview />
              </section>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {failed ? t("librarySetup.loadFailed") : t("maintenance.cache.scanning")}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

// Remount the editor when the saved layout changes so its draft follows it.
function layoutKey(layout: LibraryLayout) {
  return [layout.mode, layout.fetchPool, ...layout.pools.map((pool) => `${pool.path}:${pool.online}`)].join("|");
}
