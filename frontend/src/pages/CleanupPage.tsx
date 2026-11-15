import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Database, FolderX, HardDrive, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { SubNavTabs, type SubNavItem } from "@/components/ui/sub-nav";
import { toastFromError, useToast } from "@/components/ui/toast";
import { DatabaseBackupSection } from "@/features/cleanup/DatabaseBackupSection";
import { DatabaseCleanupSection, DatabaseOptimizeSection } from "@/features/cleanup/DatabaseCleanupSection";
import { LocalWorkCleanupSection } from "@/features/cleanup/LocalWorkCleanupSection";
import { ManagedMediaCacheSection, TranscodeCacheSection } from "@/features/cleanup/StorageCachePanels";
import { useStableCallback } from "@/hooks/useStableCallback";
import { api, type CacheOverview, type DatabaseMaintenanceOverview } from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { CLEANUP_PATH, cleanupTabs, type CleanupTab } from "@/pages/settingsPaths";
import { settingsPageClassName, settingsPanelClassName, useSettingsLocation } from "@/pages/settingsLocation";

const tabPresentation: Record<CleanupTab, { labelKey: string; icon: LucideIcon }> = {
  works: { labelKey: "cleanup.tabs.works", icon: FolderX },
  cache: { labelKey: "cleanup.tabs.cache", icon: HardDrive },
  database: { labelKey: "cleanup.tabs.database", icon: Database },
};

/**
 * Cleanup for administrators: local work folders, the caches, and the
 * database, each on its own tab. A tab shows only when the viewer may act on
 * it; Demo opens every tab read-only.
 */
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
  const available = useMemo(
    () => cleanupTabs.filter((tab) => (tab === "database" ? canManageDatabase : canManageCache)),
    [canManageCache, canManageDatabase],
  );
  const defaultTab: CleanupTab = available[0] ?? "works";
  const resolveTab = useCallback(
    (tab: string) => ({ tab: (available as readonly string[]).includes(tab) ? (tab as CleanupTab) : defaultTab }),
    [available, defaultTab],
  );
  const { tab: activeTab, select: selectTab } = useSettingsLocation<CleanupTab>(CLEANUP_PATH, defaultTab, resolveTab);

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

  // A tab scans the first time it opens; each section offers its own refresh.
  const scannedTabs = useRef(new Set<CleanupTab>());
  const scanTab = useStableCallback((tab: CleanupTab) => {
    if (scannedTabs.current.has(tab)) return;
    scannedTabs.current.add(tab);
    if (tab === "cache") void scanCache();
    if (tab === "database") void scanDatabase();
  });
  useEffect(() => {
    scanTab(activeTab);
  }, [activeTab, scanTab]);

  const openUnlinkedWorks = () => {
    window.history.pushState({}, "", "/metadata?reason=no_source");
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };

  const navItems: SubNavItem<CleanupTab>[] = available.map((tab) => ({
    value: tab,
    label: t(tabPresentation[tab].labelKey),
    icon: tabPresentation[tab].icon,
    id: `cleanup-tab-${tab}`,
    controls: `cleanup-panel-${tab}`,
  }));

  return (
    <div className={settingsPageClassName}>
      {readOnly && <DemoReadOnlyNotice />}
      <SubNavTabs label={t("nav.cleanup")} items={navItems} selected={activeTab} onSelect={selectTab} />
      <div
        className={settingsPanelClassName}
        role="tabpanel"
        id={`cleanup-panel-${activeTab}`}
        aria-labelledby={`cleanup-tab-${activeTab}`}
      >
        {activeTab === "works" && <LocalWorkCleanupSection readOnly={readOnly} canForget={canManageDatabase} />}
        {activeTab === "cache" && (
          <>
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
          </>
        )}
        {activeTab === "database" && (
          <>
            <DatabaseCleanupSection
              overview={databaseOverview}
              scanning={databaseScanning}
              readOnly={readOnly}
              unlinkedWorks={unlinkedWorks}
              onRescan={scanDatabase}
              onOpenUnlinkedWorks={openUnlinkedWorks}
            />
            <DatabaseOptimizeSection overview={databaseOverview} readOnly={readOnly} onOptimized={scanDatabase} />
            <DatabaseBackupSection readOnly={readOnly} />
          </>
        )}
      </div>
    </div>
  );
}
