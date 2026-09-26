import { RotateCcw, Tag } from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionField, SwitchControl } from "@/features/workflows/RunOptionControls";
import {
  TAG_NAME_MAX_LENGTH,
  TAG_TEMPLATE_MAX_LENGTH,
  type WorkflowTagTemplatePreview,
  type WorkflowTagTemplateToken,
} from "@/features/workflows/tagTemplateModel";
import { workflowCopy } from "@/features/workflows/workflowPageModel";

export function TagTemplateField({
  id,
  value,
  defaultValue,
  tokens,
  preview,
  error,
  spanColumns = true,
  row = false,
  enabled = true,
  onEnabledChange,
  onChange,
}: {
  id: string;
  value: string;
  defaultValue: string;
  tokens: WorkflowTagTemplateToken[];
  preview: WorkflowTagTemplatePreview;
  error?: string;
  spanColumns?: boolean;
  /** Render as a label-beside-control option row instead of a stacked field. */
  row?: boolean;
  /** When turned off the run adds no tag; the template stays ready to turn back on. */
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const insertToken = (name: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    const token = `{${name}}`;
    onChange(`${value.slice(0, start)}${token}${value.slice(end)}`);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const toggle = onEnabledChange && (
    <SwitchControl
      label={workflowCopy("tagCollectedWorks")}
      description={workflowCopy("tagCollectedWorks")}
      checked={enabled}
      onCheckedChange={onEnabledChange}
    />
  );
  const body = enabled && (
    <div className="grid min-w-0 max-w-2xl gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <Input
          ref={inputRef}
          id={id}
          fieldSize="sm"
          className="min-w-0 flex-1 font-mono"
          value={value}
          maxLength={TAG_TEMPLATE_MAX_LENGTH}
          aria-label={row ? workflowCopy("tagTemplate") : undefined}
          aria-invalid={Boolean(error)}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0 text-muted-foreground"
          disabled={value === defaultValue}
          onClick={() => onChange(defaultValue)}
          title={workflowCopy("resetTagTemplate")}
          aria-label={workflowCopy("resetTagTemplate")}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5" aria-label={workflowCopy("availableVariables")} role="group">
        {tokens.map((token) => (
          <button
            key={token.name}
            type="button"
            className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border bg-card px-2 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => insertToken(token.name)}
            title={`${token.description} · ${workflowCopy("insertTemplatePlaceholder", { placeholder: `{${token.name}}` })}`}
          >
            <code className="font-semibold text-primary">{`{${token.name}}`}</code>
            <span className="min-w-0 truncate font-mono text-muted-foreground">{token.value || "-"}</span>
          </button>
        ))}
      </div>
      {tokens.some((token) => token.name === "date") && (
        <p className="text-xs text-muted-foreground">{workflowCopy("tagTemplateDateHint")}</p>
      )}

      <div className="flex min-w-0 items-baseline gap-3 rounded-md bg-muted/50 px-3 py-2 text-xs" aria-live="polite">
        <span className="shrink-0 text-muted-foreground">{workflowCopy("preview")}</span>
        <code className="min-w-0 flex-1 break-all text-foreground">{preview.value || "-"}</code>
        <span
          className={`shrink-0 tabular-nums ${preview.truncated ? "text-warning-foreground" : "text-muted-foreground"}`}
        >
          {Math.min(preview.renderedLength, TAG_NAME_MAX_LENGTH)}/{TAG_NAME_MAX_LENGTH}
        </span>
      </div>
      {preview.truncated && (
        <p className="text-xs text-warning-foreground">
          {workflowCopy("tagTemplateTruncated", { count: TAG_NAME_MAX_LENGTH })}
        </p>
      )}
      {error && (
        <p className="text-xs text-error-foreground" role="alert">
          {error}
        </p>
      )}
    </div>
  );

  if (row) {
    return (
      <div data-testid={`${id}-field`}>
        <OptionField label={workflowCopy("tagTemplate")}>
          {toggle}
          {body}
        </OptionField>
      </div>
    );
  }
  return (
    <div
      className={`grid min-w-0 content-start gap-2 ${spanColumns ? "md:col-span-2" : ""}`}
      data-testid={`${id}-field`}
    >
      <label className="flex min-h-7 items-center gap-1.5 text-sm font-medium" htmlFor={enabled ? id : undefined}>
        <Tag className="h-3.5 w-3.5 text-muted-foreground" />
        {workflowCopy("tagTemplate")}
      </label>
      {toggle}
      {body}
    </div>
  );
}
