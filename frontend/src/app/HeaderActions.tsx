import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, LogIn, Server, Zap } from "lucide-react";

import { AppearanceControls } from "@/app/AppearanceControls";
import { AccountPanel, ServerSection } from "@/app/header/AccountPanel";
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
import { isNativeApp } from "@/lib/serverConfig";
import type { UiLocale } from "@/i18n";
import { useLocale } from "@/i18n/LocaleProvider";

type HeaderActionsProps = {
  user: CurrentUser | null;
  /** Gates navigation and read-only views; Demo can open every surface it cannot change. */
  canView: (permission: string) => boolean;
  onLogout: () => void;
  onOpenLogin: () => void;
  onOpenPath: (path: string, state?: unknown) => void;
  onOpenCommandPalette: () => void;
  onLocaleChange: (locale: UiLocale) => Promise<void>;
};

const appleShortcuts = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const commandShortcutLabel = appleShortcuts ? "⌘K" : "Ctrl K";
const commandShortcutKeys = appleShortcuts ? "Meta+K" : "Control+K";

// Phones show Quick actions, Notifications, Appearance, and the account avatar,
// whose panel also holds the native server actions. Wider screens group Quick
// actions, the server connection, Notifications, and Appearance in a tray. Quick
// actions stays an icon so it is not mistaken for the library search field.
export function HeaderActions({
  user,
  canView,
  onLogout,
  onOpenLogin,
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
  const [connectionOpen, setConnectionOpen] = useState(false);
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
          readOnly,
          onChange: metadataDisplayLanguage.change,
        }
      : undefined,
  };

  const openMobileAccount = (open: boolean) => {
    setMobileAccountOpen(open);
    if (open) server.reset();
  };

  const accountPanelProps = { user, canView, language };

  return (
    <div className="flex shrink-0 items-center gap-0.5 sm:gap-2">
      <div className="contents sm:flex sm:items-center sm:gap-0.5 sm:rounded-full sm:border sm:bg-background/70 sm:p-0.5">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("header.quickActions")}
          aria-keyshortcuts={commandShortcutKeys}
          title={`${t("header.quickActions")} (${commandShortcutLabel})`}
          className={trayButtonClass}
          onClick={onOpenCommandPalette}
        >
          <Zap className="h-4 w-4" />
        </Button>

        {native && (
          <div className="hidden sm:block">
            <HeaderPopover
              open={connectionOpen}
              onOpenChange={(open) => {
                setConnectionOpen(open);
                if (open) server.reset();
              }}
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("account.serverConnection")}
                  title={t("account.serverConnection")}
                  className={trayButtonClass}
                >
                  <Server className="h-4 w-4" />
                </Button>
              }
              align="right"
              ariaLabel={t("account.serverConnection")}
            >
              <div className="w-80">
                <PopoverHeader title={t("account.connection")} subtitle={t("account.androidClientServer")} />
                <ServerSection server={server} />
              </div>
            </HeaderPopover>
          </div>
        )}

        {user && <NotificationCenter user={user} canView={canView} readOnly={readOnly} onOpenPath={onOpenPath} />}

        <div>
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
            align="right"
            ariaLabel={t("appearance.title")}
          >
            <div className="w-[min(16rem,calc(100vw-1rem))]">
              <div className="app-scroll max-h-[calc(var(--visual-viewport-height)-4rem)] overflow-y-auto">
                <PopoverHeader title={t("appearance.title")} subtitle={t("appearance.subtitle")} />
                <AppearanceControls
                  mode={themeMode}
                  preset={themePreset}
                  palette={themePalette}
                  onModeChange={setThemeMode}
                  onPresetChange={setThemePreset}
                  onPaletteChange={setThemePalette}
                />
              </div>
            </div>
          </HeaderPopover>
        </div>
      </div>

      <span aria-hidden="true" className="hidden h-5 w-px bg-border sm:block" />

      <div className="sm:hidden">
        <HeaderPopover
          open={mobileAccountOpen}
          onOpenChange={openMobileAccount}
          trigger={
            user ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("account.accountMenu")}
                title={t("account.accountMenu")}
                className="relative h-11 w-11 rounded-full aria-expanded:bg-muted"
              >
                <UserAvatar user={user} className="h-8 w-8 text-xs" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("account.signIn")}
                title={t("account.signIn")}
                className={trayButtonClass}
              >
                <LogIn className="h-4 w-4" />
              </Button>
            )
          }
          align="right"
          ariaLabel={t("account.account")}
        >
          <div className="w-[min(20rem,calc(100vw-1rem))]">
            <div className="app-scroll max-h-[calc(var(--visual-viewport-height)-4rem)] overflow-y-auto">
              <AccountPanel
                {...accountPanelProps}
                server={native ? server : undefined}
                onNavigate={(path) => {
                  setMobileAccountOpen(false);
                  onOpenPath(path);
                }}
                onLogout={() => {
                  setMobileAccountOpen(false);
                  onLogout();
                }}
                onOpenLogin={() => {
                  setMobileAccountOpen(false);
                  onOpenLogin();
                }}
              />
            </div>
          </div>
        </HeaderPopover>
      </div>

      <div className="hidden sm:block">
        <HeaderPopover
          open={userOpen}
          onOpenChange={setUserOpen}
          trigger={
            user ? (
              <Button
                variant="ghost"
                className="h-[var(--control-height)] gap-2 rounded-full px-1 aria-expanded:bg-muted xl:pr-2.5"
                aria-label={t("account.userMenu")}
              >
                <UserAvatar user={user} className="h-8 w-8 text-xs" />
                <span className="hidden min-w-0 text-left xl:block">
                  <span className="block max-w-32 truncate text-xs font-medium leading-4">{userDisplayName(user)}</span>
                  <span className="block max-w-32 truncate text-3xs leading-3 text-muted-foreground">
                    {t(`account.roles.${user.role}`, { defaultValue: user.role })}
                    {user.devMode ? " · dev" : user.demoMode ? " · demo" : ""}
                  </span>
                </span>
                <ChevronDown className="hidden h-3.5 w-3.5 text-muted-foreground xl:block" />
              </Button>
            ) : (
              <Button className="h-[var(--control-height)] gap-2 rounded-full px-4">
                <LogIn className="h-4 w-4" />
                {t("account.signIn")}
              </Button>
            )
          }
          align="right"
          ariaLabel={t("account.account")}
        >
          <div className="w-72">
            <AccountPanel
              {...accountPanelProps}
              onNavigate={(path) => {
                setUserOpen(false);
                onOpenPath(path);
              }}
              onLogout={() => {
                setUserOpen(false);
                onLogout();
              }}
              onOpenLogin={() => {
                setUserOpen(false);
                onOpenLogin();
              }}
            />
          </div>
        </HeaderPopover>
      </div>
    </div>
  );
}
