import { useTranslation } from "react-i18next";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { NativeSelect } from "@/components/ui/input";
import { contentMaxima, type ContentMaximum } from "@/lib/contentPolicy";

export function ContentMaximumField({
  value,
  onChange,
}: {
  value: ContentMaximum;
  onChange: (value: ContentMaximum) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsRow title={t("contentRating.maximumLabel")} description={t("contentRating.maximumHint")}>
      <NativeSelect
        aria-label={t("contentRating.maximumLabel")}
        value={value}
        onChange={(event) => onChange(event.target.value as ContentMaximum)}
      >
        {contentMaxima.map((maximum) => (
          <option key={maximum} value={maximum}>
            {t(`contentRating.maximumOptions.${maximum}`)}
          </option>
        ))}
      </NativeSelect>
    </SettingsRow>
  );
}
