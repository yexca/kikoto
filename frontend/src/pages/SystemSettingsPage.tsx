import { Bot, Download, Eraser, Folder, Network, Shield, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { SubNavTabs, type SubNavItem } from "@/components/ui/sub-nav";
import type { CurrentUser } from "@/lib/api";
import { CleanupPage } from "@/pages/CleanupPage";
import { MaintenancePage } from "@/pages/MaintenancePage";
import { settingsPanelClassName, useSettingsLocation, type SettingsLocation } from "@/pages/settingsLocation";
import {
  SYSTEM_SETTINGS_PATH,
  systemSettingsTabAliases,
  systemSettingsTabs,
  type SystemSettingsTab,
} from "@/pages/settingsPaths";

const tabPresentation: Record<SystemSettingsTab, { labelKey: string; icon: LucideIcon }> = {
  library: { labelKey: "maintenance.tabs.library", icon: Folder },
  cache: { labelKey: "maintenance.tabs.cache", icon: Download },
  proxy: { labelKey: "maintenance.tabs.proxy", icon: Network },
  llm: { labelKey: "maintenance.tabs.llm", icon: Bot },
  cleanup: { labelKey: "cleanup.tab", icon: Eraser },
  users: { labelKey: "maintenance.tabs.users", icon: Shield },
};

function resolveSystemTab(tab: string): SettingsLocation<SystemSettingsTab> {
  if (systemSettingsTabs.includes(tab as SystemSettingsTab)) return { tab: tab as SystemSettingsTab };
  return { tab: systemSettingsTabAliases[tab] ?? "library" };
}

/**
 * Instance settings for administrators: the library and its sources, cache and
 * fetch, proxies, ASR and LLM services, cleanup, and users. Demo opens every
 * tab read-only.
 */
export function SystemSettingsPage({
  user,
  readOnly = false,
  onAccessPolicyUpdated,
}: {
  user: CurrentUser;
  readOnly?: boolean;
  onAccessPolicyUpdated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { tab: activeTab, select: selectTab } = useSettingsLocation<SystemSettingsTab>(
    SYSTEM_SETTINGS_PATH,
    "library",
    resolveSystemTab,
  );
  // Demo shows every administration surface read-only even though its identity
  // is not an administrator; the server rejects every write.
  const isSystemAdmin = user.permissions.includes("system:admin");
  const hasAdminPermission = (permission: string) => readOnly || isSystemAdmin || user.permissions.includes(permission);
  const canManageSources = hasAdminPermission("sources:write");
  const canManageUsers = hasAdminPermission("users:manage");
  const canManageCache = hasAdminPermission("downloads:manage");
  const canManageAccessPolicy = user.role === "super_admin" && !readOnly;
  const canManageCleanup = canManageCache || canManageSources;

  const navItems: SubNavItem<SystemSettingsTab>[] = systemSettingsTabs.map((tab) => ({
    value: tab,
    label: t(tabPresentation[tab].labelKey),
    icon: tabPresentation[tab].icon,
    id: `settings-tab-${tab}`,
    controls: `settings-panel-${tab}`,
  }));

  return (
    <div className="space-y-6">
      {readOnly && <DemoReadOnlyNotice />}
      <SubNavTabs label={t("nav.system")} items={navItems} selected={activeTab} onSelect={selectTab} />
      <div
        className={settingsPanelClassName}
        role="tabpanel"
        id={`settings-panel-${activeTab}`}
        aria-labelledby={`settings-tab-${activeTab}`}
      >
        {activeTab === "cleanup" ? (
          <CleanupPage canManageCache={canManageCache} canManageDatabase={canManageSources} readOnly={readOnly} />
        ) : (
          <MaintenancePage
            canManageSources={canManageSources}
            canManageUsers={canManageUsers}
            canManageCleanup={canManageCleanup}
            currentUserId={user.id}
            isSuperAdmin={user.role === "super_admin"}
            canManageAccessPolicy={canManageAccessPolicy}
            readOnly={readOnly}
            activeTab={activeTab}
            onAccessPolicyUpdated={onAccessPolicyUpdated}
          />
        )}
      </div>
    </div>
  );
}
