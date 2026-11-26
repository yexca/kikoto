import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LogIn, Zap } from "lucide-react";

import { AppearanceControls } from "@/app/AppearanceControls";
import { AccountPanel, type AccountDestination } from "@/app/header/AccountPanel";
import { HeaderPopover, PopoverHeader, trayButtonClass } from "@/app/header/HeaderPopover";
import type { LanguageControl } from "@/app/header/LanguageControls";
import { NotificationCenter } from "@/app/header/NotificationCenter";
import { UserAvatar, userDisplayName } from "@/app/header/UserAvatar";
import { useServerConnection } from "@/app/header/useServerConnection";
import {
  applyThemeMode,
  applyThemePalette,
  applyThemePreset,
  getStoredThemeMode,
  getStoredThemePalette,
  getStoredThemePreset,
  storeThemeMode,
  storeThemePalette,
  storeThemePreset,
  THEME_CHANGE_EVENT,
  THEME_PALETTE_CHANGE_EVENT,
  THEME_PRESET_CHANGE_EVENT,
  type ThemeMode,
  type ThemePalette,
  type ThemePreset,
  watchSystemTheme,
} from "@/app/theme";
import { ThemeTrigger } from "@/app/ThemeTrigger";
import { useMetadataDisplayLanguage } from "@/features/maintenance/useMetadataDisplayLanguage";
import { Button } from "@/components/ui/button";
import type { CurrentUser } from "@/lib/api";
import type { PageID } from "@/lib/appPages";
import { cx } from "@/lib/classNames";
import { isNativeApp } from "@/lib/serverConfig";
import type { UiLocale } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";

type HeaderActionsProps = {
  user: CurrentUser | null;
  /** Gates navigation and read-only views; Demo can open every surface it cannot change. */
  canView: (permission: string) => boolean;
  /** Destinations the account panel lists. */
  accountDestinations: readonly AccountDestination[];
  /** The page on screen. */
  currentPage: string;
  onLogout: () => void;
  onOpenLogin: () => void;
  onOpenPage: (id: PageID) => void;
  onOpenPath: (path: string, state?: unknown) => void;
  onOpenCommandPalette: () => void;
  onLocaleChange: (locale: UiLocale) => Promise<void>;
};

// The selected state of the account trigger, on the layouts where its panel lists the current page.
const accountTriggerCurrentClass: Record<AccountDestination["placement"], string> = {
  always: "bg-primary/10 ring-1 ring-primary/30",
  compact: "max-lg:bg-primary/10 max-lg:ring-1 max-lg:ring-primary/30",
  wide: "lg:bg-primary/10 lg:ring-1 lg:ring-primary/30",
};

const appleShortcuts = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const commandShortcutLabel = appleShortcuts ? "⌘K" : "Ctrl K";
const commandShortcutKeys = appleShortcuts ? "Meta+K" : "Control+K";

// Phones show Notifications and the account avatar; the account panel opens
// Quick actions and Appearance there. Wider screens group Quick actions,
// Notifications, and Appearance in a tray before the avatar. Quick actions stays
// an icon so it is not mistaken for the library search field. Languages and the
// native server connection live in the account panel on every screen size.
export function HeaderActions({
  user,
  canView,
  accountDestinations,
  currentPage,
  onLogout,
  onOpenLogin,
  onOpenPage,
  onOpenPath,
  onOpenCommandPalette,
  onLocaleChange,
}: HeaderActionsProps) {
  const { t } = useTranslation();
  const readOnly = user?.demoMode ?? false;
  const native = isNativeApp();
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [themePreset, setThemePreset] = useState<ThemePreset>(() => getStoredThemePreset());
  const [themePalette, setThemePalette] = useState<ThemePalette>(() => getStoredThemePalette());
  const [themeOpen, setThemeOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [mobileAccountOpen, setMobileAccountOpen] = useState(false);
  const [localeBusy, setLocaleBusy] = useState(false);
  const [localeError, setLocaleError] = useState("");
  const server = useServerConnection(user);
  const locale = useLocale();
  // Every signed-in user chooses an own metadata language; anonymous visitors
  // see each work's original language.
  const canViewMetadataLanguage = Boolean(user);
  const metadataDisplayLanguage = useMetadataDisplayLanguage(
    canViewMetadataLanguage && (userOpen || mobileAccountOpen),
    user?.id ?? null,
    user?.demoMode ?? false,
  );

  const changeLocale = async (next: UiLocale) => {
    if (localeBusy || next === locale.preference) return;
    setLocaleBusy(true);
    setLocaleError("");
    try {
      await onLocaleChange(next);
    } catch {
      setLocaleError(t("appearance.saveFailed"));
    } finally {
      setLocaleBusy(false);
    }
  };

  useEffect(() => {
    applyThemeMode(themeMode);
    storeThemeMode(themeMode);
    return watchSystemTheme(() => {
      if (getStoredThemeMode() === "system") applyThemeMode("system");
    });
  }, [themeMode]);

  useEffect(() => {
    applyThemePreset(themePreset);
    storeThemePreset(themePreset);
  }, [themePreset]);

  useEffect(() => {
    applyThemePalette(themePalette);
    storeThemePalette(themePalette);
  }, [themePalette]);

  useEffect(() => {
    const syncTheme = (event: Event) => setThemeMode((event as CustomEvent<ThemeMode>).detail ?? getStoredThemeMode());
    window.addEventListener(THEME_CHANGE_EVENT, syncTheme);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, syncTheme);
  }, []);

  useEffect(() => {
    const syncPreset = (event: Event) =>
      setThemePreset((event as CustomEvent<ThemePreset>).detail ?? getStoredThemePreset());
    window.addEventListener(THEME_PRESET_CHANGE_EVENT, syncPreset);
    return () => window.removeEventListener(THEME_PRESET_CHANGE_EVENT, syncPreset);
  }, []);

  useEffect(() => {
    const syncPalette = (event: Event) =>
      setThemePalette((event as CustomEvent<ThemePalette>).detail ?? getStoredThemePalette());
    window.addEventListener(THEME_PALETTE_CHANGE_EVENT, syncPalette);
    return () => window.removeEventListener(THEME_PALETTE_CHANGE_EVENT, syncPalette);
  }, []);

  const language: LanguageControl = {
    localePreference: locale.preference,
    onLocaleChange: changeLocale,
    localeBusy,
    localeError,
    metadataLanguage: canViewMetadataLanguage
      ? {
          value: metadataDisplayLanguage.value,
          busy: metadataDisplayLanguage.busy,
          failed: metadataDisplayLanguage.failed,
          onChange: metadataDisplayLanguage.change,
        }
      : undefined,
  };

  const openAccount = (setOpen: (open: boolean) => void) => (open: boolean) => {
    setOpen(open);
    if (open) server.reset();
  };

  const appearanceControls = (
    <AppearanceControls
      mode={themeMode}
      preset={themePreset}
      palette={themePalette}
      onModeChange={setThemeMode}
      onPresetChange={setThemePreset}
      onPaletteChange={setThemePalette}
    />
  );

  // One panel serves both triggers; `close` belongs to the popover it is in. The phone
  // panel also holds Quick actions and Appearance, which its header has no buttons for.
  const accountPanel = (close: () => void, phone: boolean) => (
    <AccountPanel
      user={user}
      language={language}
      server={native ? server : undefined}
      destinations={accountDestinations}
      currentPage={currentPage}
      onOpenPage={(id) => {
        close();
        onOpenPage(id);
      }}
      onOpenQuickActions={
        phone
          ? () => {
              close();
              onOpenCommandPalette();
            }
          : undefined
      }
      appearance={phone ? { detail: t(`appearance.${themeMode}`), content: appearanceControls } : undefined}
      onLogout={() => {
        close();
        onLogout();
      }}
      onOpenLogin={() => {
        close();
        onOpenLogin();
      }}
    />
  );

  // The account trigger carries the selected state while its panel holds the current page.
  const currentPlacement = accountDestinations.find((destination) => destination.item.id === currentPage)?.placement;
  const currentClass = currentPlacement && accountTriggerCurrentClass[currentPlacement];

  return (
    <div className="flex shrink-0 items-center gap-0.5 sm:gap-2">
      <div className="contents sm:flex sm:items-center sm:gap-0.5 sm:rounded-full sm:border sm:bg-background/70 sm:p-0.5">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("header.quickActions")}
          aria-keyshortcuts={commandShortcutKeys}
          title={`${t("header.quickActions")} (${commandShortcutLabel})`}
          className={cx(trayButtonClass, "max-sm:hidden")}
          onClick={onOpenCommandPalette}
        >
          <Zap className="h-4 w-4" />
        </Button>

        {user && <NotificationCenter user={user} canView={canView} readOnly={readOnly} onOpenPath={onOpenPath} />}

        {/* Phones open Appearance from the account panel. */}
        <div className="max-sm:hidden">
          <HeaderPopover
            open={themeOpen}
            onOpenChange={setThemeOpen}
            trigger={
              <ThemeTrigger
                mode={themeMode}
                preset={themePreset}
                palette={themePalette}
                variant="ghost"
                className={trayButtonClass}
              />
            }
            ariaLabel={t("appearance.title")}
          >
            <div className="w-[min(16rem,calc(100vw-1rem))]">
              <PopoverHeader title={t("appearance.title")} />
              {appearanceControls}
            </div>
          </HeaderPopover>
        </div>
      </div>

      <span aria-hidden="true" className="hidden h-5 w-px bg-border sm:block" />

      <div className="sm:hidden">
        <HeaderPopover
          open={mobileAccountOpen}
          onOpenChange={openAccount(setMobileAccountOpen)}
          trigger={
            user ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("account.accountMenu")}
                title={t("account.accountMenu")}
                className={cx("relative h-11 w-11 rounded-full aria-expanded:bg-muted", currentClass)}
              >
                <UserAvatar user={user} className="h-8 w-8 text-xs" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("account.signIn")}
                title={t("account.signIn")}
                className={cx(trayButtonClass, currentClass)}
              >
                <LogIn className="h-4 w-4" />
              </Button>
            )
          }
          ariaLabel={t("account.account")}
        >
          <div className="w-[min(20rem,calc(100vw-1rem))]">{accountPanel(() => setMobileAccountOpen(false), true)}</div>
        </HeaderPopover>
      </div>

      <div className="hidden sm:block">
        <HeaderPopover
          open={userOpen}
          onOpenChange={openAccount(setUserOpen)}
          trigger={
            user ? (
              <Button
                variant="ghost"
                className={cx(
                  "h-[var(--control-height)] gap-2 rounded-full px-1 aria-expanded:bg-muted xl:pr-3",
                  currentClass,
                )}
                aria-label={t("account.userMenu")}
              >
                <UserAvatar user={user} className="h-8 w-8 text-xs" />
                <span className="hidden max-w-32 truncate text-xs font-medium xl:block">{userDisplayName(user)}</span>
              </Button>
            ) : (
              <Button className="h-[var(--control-height)] gap-2 rounded-full px-4">
                <LogIn className="h-4 w-4" />
                {t("account.signIn")}
              </Button>
            )
          }
          ariaLabel={t("account.account")}
        >
          <div className="w-72">{accountPanel(() => setUserOpen(false), false)}</div>
        </HeaderPopover>
      </div>
    </div>
  );
}
