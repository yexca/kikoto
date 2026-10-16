import { AlertTriangle, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { SuggestionCombobox, type SuggestionOption } from "@/components/ui/suggestion-combobox";
import { api, type SmartRuleTagOption, type UserTagSuggestion } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import {
  addSmartRuleTag,
  removeSmartRuleTag,
  smartRuleCanSave,
  smartRuleFromDraft,
  smartRuleMatchKey,
  smartTagKey,
  type SmartRuleDraft,
  type SmartRuleDraftTag,
  type SmartRuleMode,
} from "./smartListModel";

/** The rule section of the smart list editor: included and excluded tags, and a live match count. */
export function SmartRuleEditor({
  listId,
  value,
  onChange,
}: {
  listId?: number;
  value: SmartRuleDraft;
  onChange: (value: SmartRuleDraft) => void;
}) {
  const { t } = useTranslation();
  const personalTags = usePersonalTagVocabulary();
  const matchLabelId = useId();
  return (
    <div className="grid gap-3 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={matchLabelId} className="text-xs font-medium text-muted-foreground">
          {t("favorites.smart.include")}
        </span>
        <div role="radiogroup" aria-labelledby={matchLabelId} className={segmentedListClassName("p-0.5")}>
          {(["all", "any"] as const).map((match) => (
            <button
              key={match}
              type="button"
              role="radio"
              aria-checked={value.includeMatch === match}
              className={segmentedItemClassName(value.includeMatch === match, "h-7 px-2.5 text-xs")}
              onClick={() => onChange({ ...value, includeMatch: match })}
            >
              {match === "all" ? t("favorites.smart.matchAll") : t("favorites.smart.matchAny")}
            </button>
          ))}
        </div>
      </div>
      <SmartRuleTagField
        mode="include"
        draft={value}
        personalTags={personalTags}
        onChange={onChange}
        placeholder={t("favorites.smart.searchTags")}
        label={t("favorites.smart.include")}
      />
      <div className="grid gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t("favorites.smart.exclude")}</span>
        <SmartRuleTagField
          mode="exclude"
          draft={value}
          personalTags={personalTags}
          onChange={onChange}
          placeholder={t("favorites.smart.searchTags")}
          label={t("favorites.smart.exclude")}
        />
      </div>
      <SmartRulePreviewLine listId={listId} draft={value} />
    </div>
  );
}

function SmartRuleTagField({
  mode,
  draft,
  personalTags,
  onChange,
  placeholder,
  label,
}: {
  mode: SmartRuleMode;
  draft: SmartRuleDraft;
  personalTags: UserTagSuggestion[];
  onChange: (value: SmartRuleDraft) => void;
  placeholder: string;
  label: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const { tags: metadataTags, loaded } = useMetadataTagSearch(query);
  const pick = (tag: SmartRuleDraftTag) => {
    onChange(addSmartRuleTag(draft, mode, tag));
    setQuery("");
  };
  const needle = query.trim().toLowerCase();
  const options: SuggestionOption[] = [
    ...metadataTags.map((tag) => ({
      key: `metadata:${tag.id}`,
      label: tag.name,
      detail: t("favorites.workCount", { count: tag.workCount }),
      disabled: draft[mode].some((item) => item.kind === "metadata" && item.id === tag.id),
      onSelect: () => pick({ kind: "metadata", id: tag.id, name: tag.name, state: "active" }),
    })),
    ...personalTags
      .filter((tag) => needle && tag.name.toLowerCase().includes(needle))
      .slice(0, 8)
      .map((tag) => ({
        key: `user:${tag.id}`,
        label: tag.name,
        detail: t("favorites.smart.personalTag"),
        disabled: draft[mode].some((item) => item.kind === "user" && item.id === tag.id),
        onSelect: () => pick({ kind: "user", id: tag.id, name: tag.name, state: "active" }),
      })),
  ];
  return (
    <div className="grid gap-2">
      {draft[mode].length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {draft[mode].map((tag) => (
            <SmartRuleChip
              key={smartTagKey(tag)}
              tag={tag}
              mode={mode}
              onRemove={() => onChange(removeSmartRuleTag(draft, mode, tag))}
            />
          ))}
        </ul>
      )}
      <SuggestionCombobox
        floating
        value={query}
        onChange={setQuery}
        options={options}
        placeholder={placeholder}
        ariaLabel={`${label}: ${placeholder}`}
        footer={
          needle && loaded && options.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("favorites.smart.noTagResults")}</p>
          ) : undefined
        }
      />
    </div>
  );
}

function SmartRuleChip({ tag, mode, onRemove }: { tag: SmartRuleDraftTag; mode: SmartRuleMode; onRemove: () => void }) {
  const { t } = useTranslation();
  const unusable = tag.state === "hidden" || tag.state === "missing";
  const name = tag.name || t("favorites.smart.unknownTag");
  const note =
    tag.state === "hidden"
      ? t("favorites.smart.stateHidden")
      : tag.state === "missing"
        ? t("favorites.smart.stateMissing")
        : tag.kind === "user"
          ? t("favorites.smart.personalTag")
          : undefined;
  return (
    <li
      className={cn(
        "inline-flex h-7 max-w-full items-center gap-1 rounded-full border pl-2.5 pr-1 text-xs",
        unusable ? "border-dashed text-muted-foreground" : mode === "include" ? "bg-card" : "bg-muted/60",
      )}
      title={note}
    >
      {unusable && <AlertTriangle className="h-3 w-3 shrink-0 text-warning-foreground" aria-hidden="true" />}
      {mode === "exclude" && <span aria-hidden="true">−</span>}
      <span className={cn("min-w-0 truncate", unusable && "line-through")}>{name}</span>
      {note && <span className="sr-only">{note}</span>}
      <button
        type="button"
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("favorites.smart.removeTag", { name })}
        onClick={onRemove}
      >
        <X className="h-3 w-3" />
      </button>
    </li>
  );
}

function SmartRulePreviewLine({ listId, draft }: { listId?: number; draft: SmartRuleDraft }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ key: string; total: number | null; failed: boolean }>({
    key: "",
    total: null,
    failed: false,
  });
  const key = smartRuleMatchKey(draft);
  const canPreview = smartRuleCanSave(draft);
  const rule = smartRuleFromDraft(draft);
  const ruleJSON = JSON.stringify(rule);
  useEffect(() => {
    if (!canPreview) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api
        .previewSmartRule(JSON.parse(ruleJSON), listId, controller.signal)
        .then((result) => setState({ key, total: result.total, failed: false }))
        .catch(() => {
          if (!controller.signal.aborted) setState({ key, total: null, failed: true });
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [canPreview, key, listId, ruleJSON]);
  let message: string;
  if (!canPreview) message = t("favorites.smart.includeRequired");
  else if (state.key !== key) message = t("favorites.smart.previewLoading");
  else if (state.failed || state.total === null) message = t("favorites.smart.previewFailed");
  else message = t("favorites.smart.previewCount", { count: state.total });
  return (
    <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
      {message}
    </p>
  );
}

function usePersonalTagVocabulary() {
  const [tags, setTags] = useState<UserTagSuggestion[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    api
      .listUserTags("work", controller.signal)
      .then((result) => setTags(result.tags))
      .catch(() => {
        // Personal tags are optional suggestions; metadata tags stay searchable.
      });
    return () => controller.abort();
  }, []);
  return tags;
}

function useMetadataTagSearch(query: string) {
  const [result, setResult] = useState<{ query: string; tags: SmartRuleTagOption[] }>({ query: "", tags: [] });
  const trimmed = query.trim();
  useEffect(() => {
    if (!trimmed) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api
        .listSmartRuleTags(trimmed, controller.signal)
        .then((page) => setResult({ query: trimmed, tags: page.tags }))
        .catch(() => {
          if (!controller.signal.aborted) setResult({ query: trimmed, tags: [] });
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);
  const loaded = Boolean(trimmed) && result.query === trimmed;
  return { tags: loaded ? result.tags : [], loaded };
}
