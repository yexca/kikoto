import { useTranslation } from "react-i18next";
import { Clipboard, LogIn, LogOut, RotateCcw, Server, Settings, Users } from "lucide-react";

import { ActionItem, MenuSection } from "@/app/header/HeaderPopover";
import { LanguageControls, type LanguageControl } from "@/app/header/LanguageControls";
import { UserAvatar, userDisplayName } from "@/app/header/UserAvatar";
import type { ServerConnection } from "@/app/header/useServerConnection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CurrentUser } from "@/lib/api";
import { versionLabel } from "@/lib/appInfo";
import { getStoredServerURL } from "@/lib/serverConfig";
import { cn } from "@/lib/tailwindClassNames";
import { PERSONAL_TAB_PERMISSION, personalTabPath, personalTabs } from "@/pages/personalTabs";

/**
 * The account surface behind the header avatar, or behind Sign in for anonymous
 * visitors: profile, personal shortcuts, UI and metadata languages, Settings,
 * and authentication. Phones in the native shell also reach server actions here.
 */
export function AccountPanel({
  user,
  canView,
  language,
  server,
  onNavigate,
  onLogout,
  onOpenLogin,
}: {
  user: CurrentUser | null;
  canView: (permission: string) => boolean;
  language: LanguageControl;
  /** Present in the native shell on phones. */
  server?: ServerConnection;
  onNavigate: (path: string) => void;
  onLogout: () => void;
  onOpenLogin: () => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      {user ? (
        <ProfileHeader user={user} />
      ) : (
        <div className="border-b p-3">
          <div className="text-sm font-semibold">{t("account.account")}</div>
          <div className="text-xs text-muted-foreground">{t("account.accountSubtitle")}</div>
          <Button className="mt-3 w-full rounded-full" onClick={onOpenLogin}>
            <LogIn className="h-4 w-4" />
            {t("account.signIn")}
          </Button>
        </div>
      )}

      {user && canView(PERSONAL_TAB_PERMISSION) && (
        <div className="grid grid-cols-3 gap-1.5 border-b p-2">
          {personalTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="flex min-h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg bg-muted/60 px-1 py-2.5 text-xs font-medium text-foreground transition-[background-color,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100"
              onClick={() => onNavigate(personalTabPath(tab.id))}
            >
              <tab.icon className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <span className="w-full truncate text-center">{t(tab.labelKey)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="border-b">
        <LanguageControls {...language} />
      </div>

      {user && (
        <MenuSection>
          <ActionItem
            icon={<Settings className="h-4 w-4" />}
            label={t("account.settings")}
            onClick={() => onNavigate("/settings")}
          />
          {canView("users:manage") && (
            <ActionItem
              icon={<Users className="h-4 w-4" />}
              label={t("account.users")}
              onClick={() => onNavigate("/settings?tab=users")}
            />
          )}
        </MenuSection>
      )}

      {server && <ServerSection server={server} className={user ? "border-t" : undefined} />}

      {user &&
        (user.devMode || user.demoMode ? (
          <div className="border-t px-3 py-2.5 text-xs text-muted-foreground">
            {user.demoMode ? t("account.demoSessionReadOnly") : t("account.devSessionNoSignOut")}
          </div>
        ) : (
          <MenuSection className="border-t">
            <ActionItem icon={<LogOut className="h-4 w-4" />} label={t("account.signOut")} onClick={onLogout} />
          </MenuSection>
        ))}
    </>
  );
}

function ProfileHeader({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 border-b p-3">
      <UserAvatar user={user} className="h-11 w-11 text-base" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{userDisplayName(user)}</div>
        <div className="truncate text-xs text-muted-foreground">@{user.username}</div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <Badge variant="outline" className="px-1.5 py-0 text-3xs">
            {t(`account.roles.${user.role}`, { defaultValue: user.role })}
          </Badge>
          {user.devMode && (
            <Badge variant="warning" className="px-1.5 py-0 text-3xs">
              {t("account.devMode")}
            </Badge>
          )}
          {user.demoMode && (
            <Badge variant="secondary" className="px-1.5 py-0 text-3xs">
              {t("account.demoMode")}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

const connectionTone: Record<string, string> = {
  online: "bg-success",
  "server-update-available": "bg-success",
  "client-update-available": "bg-warning",
  checking: "bg-info",
  reconnecting: "bg-warning",
  "client-update-required": "bg-error",
  offline: "bg-error",
};

/** Native-shell server details and recovery actions. */
export function ServerSection({ server, className }: { server: ServerConnection; className?: string }) {
  const { t } = useTranslation();
  const host = getStoredServerURL() || t("common.notConfigured");
  const message = server.status || server.connection.message;
  return (
    <MenuSection label={t("account.server")} className={className}>
      <div className="mx-1 mb-1 rounded-md border bg-muted/60 px-2.5 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              connectionTone[server.connection.kind] ?? "bg-muted-foreground",
            )}
          />
          <span className="min-w-0 flex-1 break-all font-medium">{host}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-4 text-muted-foreground">
          <span>
            {t("account.client")} {versionLabel()}
          </span>
          <span>
            {t("account.server")} {server.connection.serverVersion || t("common.unknown")}
          </span>
        </div>
        {message && <div className="mt-1 pl-4 text-muted-foreground">{message}</div>}
      </div>
      <ActionItem
        icon={<Server className="h-4 w-4" />}
        label={t("account.reconnect")}
        onClick={() => void server.check()}
      />
      <ActionItem
        icon={<Clipboard className="h-4 w-4" />}
        label={t("account.copyDiagnostics")}
        onClick={() => void server.copyDiagnostics()}
      />
      <ActionItem
        icon={<RotateCcw className="h-4 w-4" />}
        label={t("account.clearServer")}
        onClick={() => void server.clearServer()}
      />
      {server.diagnosticsText && (
        <textarea
          className="mt-1 h-32 w-full resize-none rounded-md border bg-background p-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          readOnly
          aria-label={t("account.copyDiagnostics")}
          value={server.diagnosticsText}
        />
      )}
    </MenuSection>
  );
}
