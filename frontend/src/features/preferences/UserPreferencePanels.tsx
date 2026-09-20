import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type UserPreferences } from "@/lib/api";
import { currentClientStorageScope } from "@/lib/clientStorageScope";
import { renewRecommendationSession, USER_PREFERENCES_CHANGED } from "@/lib/recommendationSession";
import { FolderPreferences, reweightDirectoryRoutingRules } from "./FolderPreferences";
import { RecommendationPreferences } from "./RecommendationPreferences";

export function UserPreferencePanels({
  userId,
  section,
  readOnly,
}: {
  userId: number;
  section: "playback" | "recommendation";
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setPreferences(null);
    setError(false);
    api
      .getUserPreferences(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPreferences(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [userId, retry]);
  const save = async () => {
    if (!preferences || saving || readOnly) return;
    setSaving(true);
    try {
      const next = await api.updateUserPreferences(
        section === "playback"
          ? {
              directoryRoutingRules: preferences.directoryRoutingRules,
            }
          : {
              recommendationConfig: preferences.recommendationConfig,
              recommendationThreshold: preferences.recommendationThreshold,
            },
      );
      setPreferences(next);
      const scope = currentClientStorageScope(userId);
      if (section === "recommendation") renewRecommendationSession(scope);
      window.dispatchEvent(new CustomEvent(USER_PREFERENCES_CHANGED, { detail: scope }));
      toast.success(t("maintenance.settingsSaved"));
    } catch (error) {
      toast.notify(toastFromError(error, t("maintenance.settingsApiUnavailable")));
    } finally {
      setSaving(false);
    }
  };
  if (error)
    return (
      <div role="alert" className="rounded-lg border p-4">
        <p>{t("maintenance.settingsApiUnavailable")}</p>
        <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
          {t("admin.retry")}
        </Button>
      </div>
    );
  if (!preferences)
    return (
      <div
        role="status"
        className="min-h-40 animate-pulse rounded-lg border bg-muted"
        aria-label={t("common.loading")}
      />
    );
  return (
    <fieldset disabled={readOnly || saving} aria-busy={saving} className="min-w-0 border-0 p-0">
      {section === "playback" ? (
        <FolderPreferences
          rules={preferences.directoryRoutingRules}
          onRulesChange={(rules) =>
            setPreferences({ ...preferences, directoryRoutingRules: reweightDirectoryRoutingRules(rules) })
          }
          onSave={save}
        />
      ) : (
        <RecommendationPreferences
          config={preferences.recommendationConfig}
          defaults={preferences.recommendationDefaults}
          threshold={preferences.recommendationThreshold}
          onConfigChange={(recommendationConfig) =>
            setPreferences((current) => (current ? { ...current, recommendationConfig } : current))
          }
          onThresholdChange={(recommendationThreshold) =>
            setPreferences((current) => (current ? { ...current, recommendationThreshold } : current))
          }
          onSave={save}
        />
      )}
    </fieldset>
  );
}
