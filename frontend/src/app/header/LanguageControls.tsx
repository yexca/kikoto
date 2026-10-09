import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AppearanceGroup } from "@/app/AppearanceControls";
import { FloatingSelect } from "@/components/ui/floating-select";
import {
  dlsiteMetadataLanguageOptions,
  type DlsiteMetadataLanguage,
} from "@/features/maintenance/metadataLanguageModel";
import { UI_LOCALE_OPTIONS, type UiLocale } from "@/i18n";

/** The signed-in user's own metadata language; "origin" when the user has no preference. */
export type MetadataLanguageControl = {
  value: DlsiteMetadataLanguage | null;
  busy: boolean;
  failed: boolean;
  onChange: (value: DlsiteMetadataLanguage) => void | Promise<void>;
};

export type LanguageControl = {
  localePreference: UiLocale;
  onLocaleChange: (locale: UiLocale) => void | Promise<void>;
  localeBusy: boolean;
  localeError: string;
  /** Absent for anonymous visitors, who see each work's original language. */
  metadataLanguage?: MetadataLanguageControl;
};

/** UI language and, for a signed-in user, the personal preferred metadata language. */
export function LanguageControls({
  localePreference,
  onLocaleChange,
  localeBusy,
  localeError,
  metadataLanguage,
}: LanguageControl) {
  const { t } = useTranslation();
  return (
    <>
      <AppearanceGroup label={t("appearance.language")}>
        <FloatingSelect
          value={localePreference}
          disabled={localeBusy}
          ariaBusy={localeBusy}
          ariaInvalid={Boolean(localeError)}
          ariaLabel={t("appearance.language")}
          onValueChange={(value) => void onLocaleChange(value as UiLocale)}
          className="disabled:cursor-wait"
          options={UI_LOCALE_OPTIONS.map((option) => ({
            value: option.value,
            label:
              option.value === "auto" ? (
                <span title={t(option.labelKey)}>
                  <Globe className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">{t(option.labelKey)}</span>
                </span>
              ) : (
                t(option.labelKey)
              ),
          }))}
        />
        {localeError && <p className="mt-2 text-xs text-destructive">{localeError}</p>}
      </AppearanceGroup>
      {metadataLanguage && (
        <AppearanceGroup label={t("appearance.metadataLanguage")}>
          <FloatingSelect
            value={metadataLanguage.value ?? "origin"}
            disabled={metadataLanguage.busy || metadataLanguage.value === null}
            ariaBusy={metadataLanguage.busy || (metadataLanguage.value === null && !metadataLanguage.failed)}
            ariaInvalid={metadataLanguage.failed}
            ariaLabel={t("appearance.metadataLanguage")}
            onValueChange={(value) => void metadataLanguage.onChange(value as DlsiteMetadataLanguage)}
            className={metadataLanguage.busy ? "disabled:cursor-wait" : undefined}
            options={dlsiteMetadataLanguageOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
          />
          {metadataLanguage.failed && (
            <p className="mt-2 text-xs text-destructive">
              {t(
                metadataLanguage.value === null
                  ? "appearance.metadataLanguageLoadFailed"
                  : "appearance.metadataLanguageSaveFailed",
              )}
            </p>
          )}
        </AppearanceGroup>
      )}
    </>
  );
}
