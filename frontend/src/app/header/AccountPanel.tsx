import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Clipboard, Languages, LogIn, LogOut, RotateCcw, Server, Zap } from "lucide-react";

import { ActionItem, MenuSection, PopoverHeader } from "@/app/header/HeaderPopover";
import {
  accountShortcutIds,
  navigationGroupLabel,
  navigationGroups,
  navigationLabel,
  type CollapsibleNavigationGroup,
  type NavigationItem,
  type PageID,
} from "@/app/navigation";
import { LanguageControls, type LanguageControl } from "@/app/header/LanguageControls";
import { UserAvatar, userDisplayName } from "@/app/header/UserAvatar";
import type { ServerConnection } from "@/app/header/useServerConnection";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UI_LOCALE_OPTIONS } from "@/i18n";
import type { CurrentUser } from "@/lib/api";
import { versionLabel } from "@/lib/appInfo";
import { getStoredServerURL } from "@/lib/serverConfig";
import { cn } from "@/lib/tailwindClassNames";

/**
 * A destination the account panel lists. `compact` destinations appear only
 * below the sidebar breakpoint, for pages the sidebar offers and the bottom
 * navigation does not carry; `wide` ones only where the sidebar is shown, for
 * pages the bottom navigation already carries. A shortcut destination is a tile
 * where the sidebar is shown and, below it, a list entry unless the bottom
 * navigation carries it, so `always` and `wide` both hold its tile.
 */
export type AccountDestination = { item: NavigationItem; placement: "always" | "compact" | "wide" };

const placementClass: Record<AccountDestination["placement"], string | undefined> = {
  always: undefined,
  compact: "lg:hidden",
  wide: "max-lg:hidden",
};

const isShortcut = (item: NavigationItem) => (accountShortcutIds as readonly string[]).includes(item.id);

type AccountView = "main" | "language" | CollapsibleNavigationGroup;

/**
 * The account surface behind the header avatar, or behind Sign in for anonymous
 * visitors: profile, the destinations the current layout offers nowhere else,
 * the Language view, and authentication. Where the sidebar is shown, Discover,
 * Insights, and Tags are also shortcut tiles under the profile. A layout without
 * the sidebar lists the sidebar's pages here, with the Manage group behind one
 * entry. On phones the panel also opens Quick actions, and in the native shell
 * it holds the server connection.
 */
export function AccountPanel({
  user,
  language,
  server,
  destinations,
  currentPage,
  onOpenPage,
  onOpenQuickActions,
  onLogout,
  onOpenLogin,
}: {
  user: CurrentUser | null;
  language: LanguageControl;
  /** Present in the native shell. */
  server?: ServerConnection;
  destinations: readonly AccountDestination[];
  currentPage: string;
  onOpenPage: (id: PageID) => void;
  /** Present where the header has no Quick actions button of its own. */
  onOpenQuickActions?: () => void;
  onLogout: () => void;
  onOpenLogin: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<AccountView>("main");
  const returnFocus = useRef<AccountView | null>(null);
  const viewIds = useId();
  const back = (from: AccountView) => () => {
    returnFocus.current = from;
    setView("main");
  };

  // A shortcut is a tile where the sidebar is shown, so its list entry only serves the layouts below it.
  const destinationItem = ({ item, placement }: AccountDestination) => {
    const shortcut = isShortcut(item);
    if (shortcut && placement === "wide") return null;
    return (
      <ActionItem
        key={item.id}
        icon={<item.icon className="h-4 w-4" />}
        label={navigationLabel(item, t)}
        current={currentPage === item.id}
        className={shortcut ? placementClass.compact : placementClass[placement]}
        onClick={() => onOpenPage(item.id)}
      />
    );
  };
  const shortcuts = accountShortcutIds.flatMap((id) => {
    const destination = destinations.find((entry) => entry.item.id === id);
    return destination ? [destination.item] : [];
  });
  const groupDestinations = (group: NavigationItem["group"]) =>
    destinations.filter((destination) => destination.item.group === group);

  if (view === "language") {
    return (
      <NestedView title={t("account.language")} onBack={back("language")}>
        <LanguageControls {...language} />
      </NestedView>
    );
  }
  const openGroup = navigationGroups.find((group) => group.id === view);
  if (openGroup) {
    return (
      <NestedView title={navigationGroupLabel(openGroup, t)} onBack={back(openGroup.id)}>
        <MenuSection>{groupDestinations(openGroup.id).map(destinationItem)}</MenuSection>
      </NestedView>
    );
  }

  const localeOption = UI_LOCALE_OPTIONS.find((option) => option.value === language.localePreference);

  return (
    <MainView focusReturn={returnFocus} idPrefix={viewIds}>
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

      {shortcuts.length > 0 && (
        <div className="grid auto-cols-fr grid-flow-col gap-1.5 border-b p-2 max-lg:hidden">
          {shortcuts.map((item) => {
            const current = currentPage === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "flex min-h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg bg-muted/60 px-1 py-2.5 text-xs font-medium text-foreground transition-[background-color,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100",
                  current && "bg-primary/10 text-primary hover:bg-primary/15",
                )}
                aria-current={current ? "page" : undefined}
                onClick={() => onOpenPage(item.id)}
              >
                <item.icon
                  className={cn("h-5 w-5", current ? "text-primary" : "text-muted-foreground")}
                  aria-hidden="true"
                />
                <span className="w-full truncate text-center">{navigationLabel(item, t)}</span>
              </button>
            );
          })}
        </div>
      )}

      <MenuSection>
        {onOpenQuickActions && (
          <ActionItem
            icon={<Zap className="h-4 w-4" />}
            label={t("header.quickActions")}
            className="sm:hidden"
            onClick={onOpenQuickActions}
          />
        )}
        {groupDestinations("browse").map(destinationItem)}
        {navigationGroups.map((group) => {
          const entries = groupDestinations(group.id);
          if (entries.length === 0) return null;
          if (group.accountPanel === "inline") return entries.map(destinationItem);
          // A nested group is one entry that names the current page while it holds it.
          const current = entries.find((entry) => entry.item.id === currentPage);
          return (
            <ActionItem
              key={group.id}
              icon={<group.icon className="h-4 w-4" />}
              label={navigationGroupLabel(group, t)}
              detail={current ? navigationLabel(current.item, t) : undefined}
              current={Boolean(current)}
              navigates
              id={`${viewIds}-${group.id}`}
              className={placementClass.compact}
              onClick={() => setView(group.id)}
            />
          );
        })}
        {groupDestinations(undefined).map(destinationItem)}
      </MenuSection>

      <MenuSection className="border-t">
        <ActionItem
          icon={<Languages className="h-4 w-4" />}
          label={t("account.language")}
          detail={localeOption ? t(localeOption.labelKey) : undefined}
          navigates
          id={`${viewIds}-language`}
          onClick={() => setView("language")}
        />
      </MenuSection>

      {server && <ServerSection server={server} className="border-t" />}

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
    </MainView>
  );
}

/** Returns focus to the entry of the view the user came back from. */
function MainView({
  focusReturn,
  idPrefix,
  children,
}: {
  focusReturn: { current: AccountView | null };
  idPrefix: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const from = focusReturn.current;
    if (!from) return;
    focusReturn.current = null;
    document.getElementById(`${idPrefix}-${from}`)?.focus();
  }, [focusReturn, idPrefix]);
  return <>{children}</>;
}

function NestedView({
  title,
  subtitle,
  onBack,
  children,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  return (
    <div ref={ref} className="contents">
      <PopoverHeader title={title} subtitle={subtitle} onBack={onBack} />
      {children}
    </div>
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
