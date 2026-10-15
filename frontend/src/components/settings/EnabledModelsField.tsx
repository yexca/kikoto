import { Plus, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { addModel, ENABLED_MODEL_LIMIT, MODEL_ID_LIMIT, removeModel } from "@/lib/serviceModels";

/**
 * Edits the models an LLM provider or ASR service offers and which one is
 * chosen first. Discovered models are suggestions; any ID can be added.
 */
export function EnabledModelsField({
  models,
  defaultModel,
  suggestions,
  hint,
  action,
  onChange,
}: {
  models: string[];
  defaultModel: string;
  suggestions: Array<{ id: string; name?: string }>;
  hint: string;
  /** A control beside the add button, such as model discovery. */
  action?: ReactNode;
  onChange: (models: string[], defaultModel: string) => void;
}) {
  const { t } = useTranslation();
  const [candidate, setCandidate] = useState("");
  const listId = useId();
  const hintId = useId();
  const groupName = useId();
  const full = models.length >= ENABLED_MODEL_LIMIT;

  const add = () => {
    const next = addModel(models, candidate);
    if (next !== models) onChange(next, defaultModel || next[0]);
    setCandidate("");
  };

  return (
    <div role="group" aria-label={t("serviceModels.label")} className="grid min-w-0 gap-2 border-t pt-5">
      <span className="text-sm font-medium">{t("serviceModels.label")}</span>
      {models.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {models.map((model) => (
            <li key={model} className="flex min-w-0 items-center gap-3 px-3 py-1.5">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm">
                <input
                  type="radio"
                  name={groupName}
                  className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
                  checked={model === defaultModel}
                  aria-label={t("serviceModels.makeDefault", { model })}
                  onChange={() => onChange(models, model)}
                />
                <span className="min-w-0 truncate font-mono text-xs" title={model}>
                  {model}
                </span>
                {model === defaultModel && (
                  <span className="shrink-0 text-xs text-muted-foreground">{t("serviceModels.default")}</span>
                )}
              </label>
              <IconButton
                title={t("serviceModels.remove", { model })}
                onClick={() => {
                  const next = removeModel(models, defaultModel, model);
                  onChange(next.models, next.defaultModel);
                }}
              >
                <X className="h-4 w-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          {t("serviceModels.empty")}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap gap-2">
        <Input
          aria-label={t("serviceModels.addLabel")}
          aria-describedby={hintId}
          className="min-w-0 flex-1 basis-40"
          value={candidate}
          maxLength={MODEL_ID_LIMIT}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          list={listId}
          disabled={full}
          placeholder={t("serviceModels.addPlaceholder")}
          onChange={(event) => setCandidate(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the typed model instead of submitting the dialog.
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <datalist id={listId}>
          {suggestions
            .filter((model) => !models.includes(model.id))
            .map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
        </datalist>
        <Button type="button" variant="outline" className="shrink-0" disabled={full || !candidate.trim()} onClick={add}>
          <Plus className="h-4 w-4" />
          {t("serviceModels.add")}
        </Button>
        {action}
      </div>
      <p id={hintId} className="text-xs leading-5 text-muted-foreground">
        {full ? t("serviceModels.limit", { count: ENABLED_MODEL_LIMIT }) : hint}
      </p>
    </div>
  );
}
