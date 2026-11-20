import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Clipboard, Languages, LogIn, LogOut, Palette, RotateCcw, Server, Zap, type LucideIcon } from "lucide-react";

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

type AccountView = "main" | "language" | "appearance" | "server" | CollapsibleNavigationGroup;

// Settings concerns the account itself, so it stays a list entry beside Language rather than a page tile.
const listedDestinationIds: readonly string[] = ["settings"];

/**
 * The account surface behind the header avatar, or behind Sign in for anonymous
 * visitors: a one-line profile, page tiles, the account's own entries, and a
 * closing row with About and Sign out. Where the sidebar is shown, Discover,
 * Insights, and Tags are the tiles. A layout without the sidebar tiles the
 * sidebar's pages that the bottom navigation does not carry, and lists
 * Settings with the Manage group behind one entry. On phones the panel also
 * opens Quick actions and Appearance, which the header has no button for, and
 * in the native shell it holds the server connection behind one entry.
 */
export function AccountPanel({
  user,
  language,
  server,
  destinations,
  currentPage,
  onOpenPage,
  onOpenQuickActions,
  appearance,
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
  /** Present where the header has no Appearance button of its own. */
  appearance?: { detail: string; content: ReactNode };
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
  // Below the sidebar breakpoint the pages the bottom navigation does not carry are tiles, except the listed ones.
  const pageTiles = destinations.filter(
    ({ item, placement }) =>
      placement !== "wide" &&
      item.group !== "app" &&
      item.group !== "manage" &&
      !listedDestinationIds.includes(item.id),
  );
  const listedDestinations = destinations.filter(({ item }) => listedDestinationIds.includes(item.id));
  const aboutDestinations = groupDestinations("app");
  if (view === "language") {
    return (
      <NestedView title={t("account.language")} onBack={back("language")}>
        <LanguageControls {...language} />
      </NestedView>
    );
  }
  if (view === "appearance" && appearance) {
    return (
      <NestedView title={t("appearance.title")} onBack={back("appearance")}>
        {appearance.content}
      </NestedView>
    );
  }
  if (view === "server" && server) {
    return (
      <NestedView title={t("account.server")} onBack={back("server")}>
        <ServerSection server={server} heading={false} />
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
          {shortcuts.map((item) => (
            <DestinationTile
              key={item.id}
              icon={item.icon}
              label={navigationLabel(item, t)}
              current={currentPage === item.id}
              onClick={() => onOpenPage(item.id)}
            />
          ))}
        </div>
      )}

      {/* Where the sidebar is shown it offers every page, so these tiles serve only the layouts without it. */}
      {(pageTiles.length > 0 || onOpenQuickActions) && (
        <div className="grid grid-cols-3 gap-1.5 border-b p-2 lg:hidden">
          {pageTiles.map(({ item }) => (
            <DestinationTile
              key={item.id}
              icon={item.icon}
              label={navigationLabel(item, t)}
              current={currentPage === item.id}
              onClick={() => onOpenPage(item.id)}
            />
          ))}
          {onOpenQuickActions && (
            <DestinationTile
              icon={Zap}
              label={t("header.quickActions")}
              className="sm:hidden"
              onClick={onOpenQuickActions}
            />
          )}
        </div>
      )}

      <MenuSection>
        {listedDestinations.map(destinationItem)}
        {navigationGroups.map((group) => {
          const entries = groupDestinations(group.id);
          if (group.accountPanel === "inline" || entries.length === 0) return null;
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
        {appearance && (
          <ActionItem
            icon={<Palette className="h-4 w-4" />}
            label={t("appearance.title")}
            detail={appearance.detail}
            navigates
            id={`${viewIds}-appearance`}
            onClick={() => setView("appearance")}
          />
        )}
        <ActionItem
          icon={<Languages className="h-4 w-4" />}
          label={t("account.language")}
          detail={localeOption ? t(localeOption.labelKey) : undefined}
          navigates
          id={`${viewIds}-language`}
          onClick={() => setView("language")}
        />
        {server && (
          <ActionItem
            icon={
              <span className="relative">
                <Server className="h-4 w-4" />
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-card",
                    connectionTone[server.connection.kind] ?? "bg-muted-foreground",
                  )}
                />
              </span>
            }
            label={t("account.server")}
            detail={getStoredServerURL() || t("common.notConfigured")}
            navigates
            id={`${viewIds}-server`}
            onClick={() => setView("server")}
          />
        )}
      </MenuSection>

      {(aboutDestinations.length > 0 || user) && (
        <MenuSection className={cn("flex items-center gap-1 border-t", !user && "lg:hidden")}>
          {aboutDestinations.map(({ item, placement }) => (
            <ActionItem
              key={item.id}
              icon={<item.icon className="h-4 w-4" />}
              label={navigationLabel(item, t)}
              current={currentPage === item.id}
              className={cn("w-auto min-w-0 flex-1", placementClass[placement])}
              onClick={() => onOpenPage(item.id)}
            />
          ))}
          {user &&
            (user.devMode || user.demoMode ? (
              <p className="min-w-0 flex-1 px-2 text-xs text-muted-foreground">
                {user.demoMode ? t("account.demoSessionReadOnly") : t("account.devSessionNoSignOut")}
              </p>
            ) : (
              <ActionItem
                icon={<LogOut className="h-4 w-4" />}
                label={t("account.signOut")}
                className="w-auto min-w-0 flex-1"
                onClick={onLogout}
              />
            ))}
        </MenuSection>
      )}
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

function NestedView({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  return (
    <div ref={ref} className="contents">
      <PopoverHeader title={title} onBack={onBack} />
      {children}
    </div>
  );
}

/** The signed-in user on one compact block: the handle shows only where it differs from the name. */
function ProfileHeader({ user }: { user: CurrentUser }) {
  const { t } = useTranslation();
  const name = userDisplayName(user);
  return (
    <div className="flex items-center gap-2.5 border-b px-3 py-2.5">
      <UserAvatar user={user} className="h-9 w-9 shrink-0 text-sm" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-semibold">{name}</span>
          {user.username !== name && <span className="truncate text-xs text-muted-foreground">@{user.username}</span>}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{t(`account.roles.${user.role}`, { defaultValue: user.role })}</span>
          {user.devMode && (
            <Badge variant="warning" className="shrink-0 px-1.5 py-0 text-3xs">
              {t("account.devMode")}
            </Badge>
          )}
          {user.demoMode && (
            <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-3xs">
              {t("account.demoMode")}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

/** A page tile: its icon over its name, primary while it is the page on screen. */
function DestinationTile({
  icon: Icon,
  label,
  current = false,
  className,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  current?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg bg-muted/60 px-1 py-2.5 text-xs font-medium text-foreground transition-[background-color,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[var(--press-scale)] motion-reduce:active:scale-100",
        current && "bg-primary/10 text-primary hover:bg-primary/15",
        className,
      )}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
    >
      <Icon className={cn("h-5 w-5", current ? "text-primary" : "text-muted-foreground")} aria-hidden="true" />
      <span className="w-full truncate text-center">{label}</span>
    </button>
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
export function ServerSection({
  server,
  heading = true,
  className,
}: {
  server: ServerConnection;
  /** False inside a view whose header already names the server. */
  heading?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const host = getStoredServerURL() || t("common.notConfigured");
  const message = server.status || server.connection.message;
  return (
    <MenuSection label={heading ? t("account.server") : undefined} className={className}>
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
