import { Monitor, Moon, Sun, UserRound } from "lucide-react";
import { useEffect, useState } from "react";

import {
  applyThemeAccent,
  applyThemeMode,
  getStoredThemeAccent,
  getStoredThemeMode,
  storeThemeAccent,
  storeThemeMode,
  THEME_ACCENT_CHANGE_EVENT,
  THEME_CHANGE_EVENT,
  type ThemeAccent,
  type ThemeMode,
} from "@/app/theme";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CurrentUser } from "@/lib/api";

export function SettingsPage({ user }: { user: CurrentUser }) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());
  const [themeAccent, setThemeAccent] = useState<ThemeAccent>(() => getStoredThemeAccent());

  useEffect(() => {
    const syncMode = (event: Event) => setThemeMode((event as CustomEvent<ThemeMode>).detail ?? getStoredThemeMode());
    const syncAccent = (event: Event) =>
      setThemeAccent((event as CustomEvent<ThemeAccent>).detail ?? getStoredThemeAccent());
    window.addEventListener(THEME_CHANGE_EVENT, syncMode);
    window.addEventListener(THEME_ACCENT_CHANGE_EVENT, syncAccent);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, syncMode);
      window.removeEventListener(THEME_ACCENT_CHANGE_EVENT, syncAccent);
    };
  }, []);

  const updateTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    applyThemeMode(mode);
    storeThemeMode(mode);
  };

  const updateAccent = (accent: ThemeAccent) => {
    setThemeAccent(accent);
    applyThemeAccent(accent);
    storeThemeAccent(accent);
  };

  return (
    <div className="space-y-5">
      <section className="rounded-lg border bg-card p-4">
        <p className="text-sm font-medium text-muted-foreground">Personal preferences</p>
        <h2 className="mt-1 text-2xl font-semibold">Settings</h2>
      </section>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserRound className="h-4 w-4" />
              Account
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <ReadonlyField label="Display name" value={user.displayName || user.username} />
            <ReadonlyField label="Username" value={user.username} />
            <ReadonlyField label="Role" value={user.role.replace("_", " ")} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Monitor className="h-4 w-4" />
              Appearance
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Display mode</legend>
              <div
                className="inline-flex max-w-full gap-1 overflow-x-auto rounded-md border bg-muted/40 p-1"
                aria-label="Theme preference"
              >
                {(
                  [
                    { value: "light", label: "Light", icon: <Sun className="h-4 w-4" /> },
                    { value: "dark", label: "Dark", icon: <Moon className="h-4 w-4" /> },
                    { value: "system", label: "System", icon: <Monitor className="h-4 w-4" /> },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.value}
                    className={`flex h-9 items-center gap-2 rounded px-3 text-sm font-medium transition-[color,background-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] motion-reduce:active:scale-100 ${themeMode === option.value ? "bg-background shadow-sm" : "text-muted-foreground hover:bg-background/60 hover:text-foreground"}`}
                    aria-pressed={themeMode === option.value}
                    onClick={() => updateTheme(option.value)}
                  >
                    {option.icon}
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Accent color</legend>
              <AccentColorPicker value={themeAccent} onChange={updateAccent} />
            </fieldset>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const accentOptions: Array<{ value: ThemeAccent; label: string; swatch: string }> = [
  { value: "pink", label: "Pink", swatch: "bg-[#d94f7b]" },
  { value: "blue", label: "Blue", swatch: "bg-[#347fd8]" },
  { value: "green", label: "Green", swatch: "bg-[#349866]" },
];

function AccentColorPicker({ value, onChange }: { value: ThemeAccent; onChange: (accent: ThemeAccent) => void }) {
  return (
    <div className="flex flex-wrap gap-2" aria-label="Accent color">
      {accentOptions.map((option) => (
        <button
          key={option.value}
          className={`flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] motion-reduce:active:scale-100 ${value === option.value ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/20" : "bg-background text-muted-foreground"}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          <span
            className={`h-4 w-4 rounded-full border border-black/10 shadow-sm ${option.swatch}`}
            aria-hidden="true"
          />
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input className="h-10 w-full rounded-md border bg-muted px-3 text-sm" value={value} readOnly />
    </label>
  );
}
