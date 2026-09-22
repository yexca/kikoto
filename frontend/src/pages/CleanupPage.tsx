import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { toastFromError, useToast } from "@/components/ui/toast";
import { formatByteSize } from "@/features/cleanup/cacheCleanupModel";
import { DatabaseCleanupSection, DatabaseOptimizeSection } from "@/features/cleanup/DatabaseCleanupSection";
import { ManagedMediaCacheSection, TranscodeCacheSection } from "@/features/cleanup/StorageCachePanels";
import { api, type CacheOverview, type DatabaseMaintenanceOverview } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";

export function CleanupPage({
  canManageCache,
  canManageDatabase,
  readOnly = false,
}: {
  canManageCache: boolean;
  canManageDatabase: boolean;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [cacheOverview, setCacheOverview] = useState<CacheOverview | null>(null);
  const [cacheScanning, setCacheScanning] = useState(false);
  const [databaseOverview, setDatabaseOverview] = useState<DatabaseMaintenanceOverview | null>(null);
  const [databaseScanning, setDatabaseScanning] = useState(false);
  const [unlinkedWorks, setUnlinkedWorks] = useState<number | null>(null);

  const scanCache = useCallback(async () => {
    if (!canManageCache) return;
    setCacheScanning(true);
    try {
      setCacheOverview(await api.getCacheOverview());
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.cache.scanFailed")));
    } finally {
      setCacheScanning(false);
    }
  }, [canManageCache, t, toast]);

  const scanDatabase = useCallback(async () => {
    if (!canManageDatabase) return;
    setDatabaseScanning(true);
    try {
      const [overview, unlinked] = await Promise.all([
        api.getDatabaseMaintenance(),
        api.listMaintenanceWorks(1, 25, "", "no_source", null).catch(() => null),
      ]);
      setDatabaseOverview(overview);
      setUnlinkedWorks(unlinked?.total ?? null);
    } catch (error) {
      toast.notify(toastFromError(error, t("cleanup.database.scanFailed")));
    } finally {
      setDatabaseScanning(false);
    }
  }, [canManageDatabase, t, toast]);

  useEffect(() => {
    void scanCache();
    void scanDatabase();
    // Scans run once per mount; each section offers its own refresh.
  }, []);

  const openUnlinkedWorks = () => {
    window.history.pushState({}, "", "/metadata?reason=no_source");
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  const reclaimable =
    (cacheOverview?.orphanBytes ?? 0) + (cacheOverview?.transcode.bytes ?? 0) + (databaseOverview?.freeBytes ?? 0);

  return (
    <div className="w-full max-w-4xl space-y-6" data-testid="cleanup-content">
      {cacheOverview && databaseOverview && reclaimable > 0 && (
        <p className="px-1 text-sm text-muted-foreground" role="status">
          {t("cleanup.summary.total", { size: formatByteSize(reclaimable) })}
        </p>
      )}

      {canManageCache && (
        <div className="space-y-6">
          <TranscodeCacheSection
            overview={cacheOverview}
            scanning={cacheScanning}
            readOnly={readOnly}
            onChanged={scanCache}
          />
          <ManagedMediaCacheSection
            overview={cacheOverview}
            scanning={cacheScanning}
            readOnly={readOnly}
            onRefresh={scanCache}
          />
        </div>
      )}

      {canManageDatabase && (
        <div className="space-y-6">
          <DatabaseCleanupSection
            overview={databaseOverview}
            scanning={databaseScanning}
            readOnly={readOnly}
            unlinkedWorks={unlinkedWorks}
            onRescan={scanDatabase}
            onOpenUnlinkedWorks={openUnlinkedWorks}
          />
          <DatabaseOptimizeSection overview={databaseOverview} readOnly={readOnly} onOptimized={scanDatabase} />
        </div>
      )}
    </div>
  );
}
