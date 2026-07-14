import { Monitor, Moon, Sun, UserRound } from "lucide-react";
import { useState } from "react";

import { applyThemeMode, getStoredThemeMode, storeThemeMode, type ThemeMode } from "@/app/theme";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CurrentUser } from "@/lib/api";

export function SettingsPage({ user }: { user: CurrentUser }) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredThemeMode());

  const updateTheme = (mode: ThemeMode) => {
    setThemeMode(mode);
    applyThemeMode(mode);
    storeThemeMode(mode);
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
          <CardContent>
            <div className="inline-flex max-w-full gap-1 overflow-x-auto rounded-md border bg-muted/40 p-1" aria-label="Theme preference">
              {([
                { value: "light", label: "Light", icon: <Sun className="h-4 w-4" /> },
                { value: "dark", label: "Dark", icon: <Moon className="h-4 w-4" /> },
                { value: "system", label: "System", icon: <Monitor className="h-4 w-4" /> },
              ] as const).map((option) => (
                <button
                  key={option.value}
                  className={`flex h-9 items-center gap-2 rounded px-3 text-sm font-medium ${themeMode === option.value ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                  aria-pressed={themeMode === option.value}
                  onClick={() => updateTheme(option.value)}
                >
                  {option.icon}
                  {option.label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
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
