import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { SuggestionCombobox } from "@/components/ui/suggestion-combobox";
import { Switch } from "@/components/ui/switch";
import { useMetadataEntrySuggestions } from "@/hooks/useMetadataEntrySuggestions";
import { api, type LLMKeywordRule, type LLMPolicy, type MetadataTag } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { KEYWORD_RULE_FIELDS, KEYWORD_RULE_LIMIT } from "./llmSettingsModel";

/** Rows of the content safety policy; the owning section saves the edited policy as a whole. */
export function LLMPolicyEditor({
  policy,
  onChange,
  disabled = false,
}: {
  policy: LLMPolicy;
  onChange: (policy: LLMPolicy) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [names, setNames] = useState<Record<number, string>>({});
  const suggestions = useMetadataEntrySuggestions("tags", query);
  useEffect(() => {
    let active = true;
    void Promise.allSettled(policy.tagRules.map((rule) => api.getMetadataTag(rule.tagId))).then((results) => {
      if (!active) return;
      setNames((current) => ({
        ...current,
        ...Object.fromEntries(
          results.flatMap((result) =>
            result.status === "fulfilled" ? [[result.value.id, result.value.displayName]] : [],
          ),
        ),
      }));
    });
    return () => {
      active = false;
    };
  }, [policy.tagRules]);
  const updateRule = (index: number, change: Partial<LLMKeywordRule>) =>
    onChange({ ...policy, keywords: policy.keywords.map((rule, i) => (i === index ? { ...rule, ...change } : rule)) });
  const tagName = (id: number) => names[id] ?? `#${id}`;

  return (
    <>
      <SettingsRow title={t("maintenance.llm.remoteLyrics")} description={t("maintenance.llm.remoteLyricsDescription")}>
        <Switch
          aria-label={t("maintenance.llm.remoteLyrics")}
          disabled={disabled}
          checked={policy.remoteLyrics ?? false}
          onCheckedChange={(remoteLyrics) => onChange({ ...policy, remoteLyrics })}
        />
      </SettingsRow>
      <SettingsRow
        title={t("maintenance.llm.alwaysScanAllAges")}
        description={t("maintenance.llm.alwaysScanAllAgesDescription")}
      >
        <Switch
          aria-label={t("maintenance.llm.alwaysScanAllAges")}
          disabled={disabled}
          checked={policy.alwaysScanAllAges}
          onCheckedChange={(alwaysScanAllAges) => onChange({ ...policy, alwaysScanAllAges })}
        />
      </SettingsRow>
      <SettingsRow
        title={t("maintenance.llm.sensitiveTags")}
        description={t("maintenance.llm.sensitiveTagsDescription")}
        stack
      >
        <div className="grid w-full min-w-0 gap-2.5">
          {policy.tagRules.length > 0 ? (
            <ul className="flex min-w-0 flex-wrap gap-1.5">
              {policy.tagRules.map(({ tagId: id, action }) => (
                <li
                  key={id}
                  className="inline-flex min-h-9 min-w-0 max-w-full items-center gap-0.5 rounded-[var(--badge-radius)] bg-secondary pl-2.5 pr-1 text-xs font-medium text-secondary-foreground"
                >
                  <span className="min-w-0 truncate">{tagName(id)}</span>
                  <NativeSelect
                    aria-label={t("maintenance.llm.tagAction", { tag: tagName(id) })}
                    fieldSize="sm"
                    className="w-28 shrink-0"
                    disabled={disabled}
                    value={action}
                    onChange={(event) =>
                      onChange({
                        ...policy,
                        tagRules: policy.tagRules.map((rule) =>
                          rule.tagId === id
                            ? { ...rule, action: event.target.value as LLMKeywordRule["action"] }
                            : rule,
                        ),
                      })
                    }
                  >
                    <option value="sensitive">{t("maintenance.llm.sensitive")}</option>
                    <option value="restricted">{t("maintenance.llm.restricted")}</option>
                    <option value="blocked">{t("maintenance.llm.blocked")}</option>
                  </NativeSelect>
                  <button
                    type="button"
                    className="touch-target relative grid h-5 w-5 shrink-0 place-items-center rounded-[calc(var(--badge-radius)-2px)] opacity-70 transition-opacity hover:bg-foreground/10 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                    aria-label={t("common.removeItem", { value: tagName(id) })}
                    title={t("common.removeItem", { value: tagName(id) })}
                    disabled={disabled}
                    onClick={() =>
                      onChange({ ...policy, tagRules: policy.tagRules.filter((rule) => rule.tagId !== id) })
                    }
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t("maintenance.llm.sensitiveTagsEmpty")}</p>
          )}
          {!disabled && policy.tagRules.length < KEYWORD_RULE_LIMIT && (
            <div className="w-full sm:max-w-sm">
              <SuggestionCombobox
                ariaLabel={t("maintenance.llm.sensitiveTags")}
                placeholder={t("maintenance.llm.sensitiveTagsSearch")}
                value={query}
                onChange={setQuery}
                options={suggestions.entries
                  .filter((tag) => !policy.tagRules.some((rule) => rule.tagId === tag.id))
                  .map((entry) => {
                    const tag = entry as MetadataTag;
                    return {
                      key: String(tag.id),
                      label: tag.displayName,
                      onSelect: () => {
                        setNames((current) => ({ ...current, [tag.id]: tag.displayName }));
                        onChange({ ...policy, tagRules: [...policy.tagRules, { tagId: tag.id, action: "sensitive" }] });
                        setQuery("");
                      },
                    };
                  })}
              />
            </div>
          )}
          {suggestions.failed && (
            <p role="alert" className="text-xs text-error-foreground">
              {t("metadataEntries.loadFailed")}
            </p>
          )}
        </div>
      </SettingsRow>
      <SettingsRow title={t("maintenance.llm.keywords")} description={t("maintenance.llm.keywordsDescription")} stack>
        <div className="grid w-full min-w-0 gap-2.5">
          {policy.keywords.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("maintenance.llm.keywordsEmpty")}</p>
          )}
          {policy.keywords.map((rule, index) => (
            <fieldset
              key={rule.id}
              disabled={disabled}
              className="min-w-0 space-y-2.5 rounded-lg border bg-muted/20 p-3"
            >
              <legend className="sr-only">{t("maintenance.llm.ruleNumber", { number: index + 1 })}</legend>
              {/* A phone gives the keyword its own line and keeps the action beside the remove control. */}
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto]">
                <Input
                  aria-label={t("maintenance.llm.ruleTerm", { number: index + 1 })}
                  fieldSize="sm"
                  className="col-span-2 min-w-0 sm:col-span-1"
                  placeholder={t("maintenance.llm.ruleTermPlaceholder")}
                  value={rule.term}
                  onChange={(event) => updateRule(index, { term: event.target.value })}
                />
                <NativeSelect
                  aria-label={t("maintenance.llm.ruleAction", { number: index + 1 })}
                  fieldSize="sm"
                  className="min-w-0"
                  value={rule.action}
                  onChange={(event) => updateRule(index, { action: event.target.value as LLMKeywordRule["action"] })}
                >
                  <option value="sensitive">{t("maintenance.llm.sensitive")}</option>
                  <option value="restricted">{t("maintenance.llm.restricted")}</option>
                  <option value="blocked">{t("maintenance.llm.blocked")}</option>
                </NativeSelect>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={t("maintenance.llm.removeRule", { number: index + 1 })}
                  title={t("maintenance.llm.removeRule", { number: index + 1 })}
                  onClick={() => onChange({ ...policy, keywords: policy.keywords.filter((_, i) => i !== index) })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div
                role="group"
                aria-label={t("maintenance.llm.ruleFieldsLabel", { number: index + 1 })}
                className="flex min-w-0 flex-wrap gap-1.5"
              >
                {KEYWORD_RULE_FIELDS.map((field) => {
                  const checked = rule.fields.includes(field);
                  return (
                    <button
                      key={field}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      className={cn(
                        "touch-target relative inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                        checked
                          ? "border-primary bg-primary/10 font-medium text-primary"
                          : "border-input bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      onClick={() =>
                        updateRule(index, {
                          fields: checked ? rule.fields.filter((value) => value !== field) : [...rule.fields, field],
                        })
                      }
                    >
                      {t(`maintenance.llm.ruleFields.${field}`)}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={disabled || policy.keywords.length >= KEYWORD_RULE_LIMIT}
            onClick={() =>
              onChange({
                ...policy,
                keywords: [
                  ...policy.keywords,
                  {
                    id:
                      "rule-" +
                      Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
                        byte.toString(16).padStart(2, "0"),
                      ).join(""),
                    term: "",
                    fields: ["all"],
                    action: "sensitive",
                  },
                ],
              })
            }
          >
            <Plus className="h-4 w-4" />
            {t("maintenance.llm.addRule")}
          </Button>
        </div>
      </SettingsRow>
    </>
  );
}
