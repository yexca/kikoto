import { Database } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsSection } from "@/components/settings/SettingsSection";
import { api, type LibraryLayout } from "@/lib/api";

import { LibraryLayoutEditor } from "./LibraryLayoutEditor";

/** Settings -> Library: the library mode, storage pools, and Fetch pool. */
export function LibraryLayoutSection({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation();
  const [layout, setLayout] = useState<LibraryLayout | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api
      .getLibraryLayout(controller.signal)
      .then((next) => {
        setLayout(next);
        setFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);

  return (
    <SettingsSection title={t("librarySetup.title")} description={t("librarySetup.description")} icon={<Database />}>
      <div className="px-4 py-3">
        {layout ? (
          <LibraryLayoutEditor key={layoutKey(layout)} layout={layout} readOnly={readOnly} onSaved={setLayout} />
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
