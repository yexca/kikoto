import { Check, Loader2, Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { maxUserTagNameLength } from "@/components/userTagEditorModel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { UserTagScope } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

import { mergeTargetCandidates, USER_TAG_PAGE_SIZE, validateTagRename } from "./userTagManagementModel";
import { userTagsApi, type ManagedUserTag } from "./userTagsApi";

export function RenameUserTagDialog({
  tag,
  busy,
  duplicate,
  onDraftChange,
  onClose,
  onRename,
}: {
  tag: ManagedUserTag;
  busy: boolean;
  /** The last attempt was rejected because the name already exists. */
  duplicate: boolean;
  onDraftChange: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const { t } = useTranslation();
  const inputId = useId();
  const [draft, setDraft] = useState(tag.name);
  const validation = validateTagRename(draft, tag);
  const invalid = !validation.ok && validation.reason === "invalid";
  const message = invalid ? t("personal.tags.nameInvalid") : duplicate ? t("personal.tags.nameDuplicate") : null;

  return (
    <Dialog onClose={onClose} dismissible={!busy} size="sm">
      <DialogHeader
        title={t("personal.tags.renameTitle")}
        onClose={busy ? undefined : onClose}
        closeLabel={t("common.close")}
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (validation.ok && !busy) onRename(validation.name);
        }}
      >
        <DialogBody className="space-y-2">
          <label htmlFor={inputId} className="block text-sm font-medium">
            {t("personal.tags.nameLabel")}
          </label>
          <Input
            id={inputId}
            className="w-full"
            value={draft}
            autoFocus
            maxLength={maxUserTagNameLength * 2}
            aria-invalid={Boolean(message)}
            aria-describedby={`${inputId}-hint`}
            onChange={(event) => {
              setDraft(event.target.value);
              onDraftChange();
            }}
          />
          <p
            id={`${inputId}-hint`}
            className={cn("text-xs", message ? "text-error-foreground" : "text-muted-foreground")}
            role={message ? "alert" : undefined}
          >
            {message ?? t("personal.tags.nameHint")}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={!validation.ok || busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {t("personal.tags.renameConfirm")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

export function MergeUserTagDialog({
  scope,
  source,
  busy,
  onClose,
  onMerge,
}: {
  scope: UserTagScope;
  source: ManagedUserTag;
  busy: boolean;
  onClose: () => void;
  onMerge: (target: ManagedUserTag) => void;
}) {
  const { t } = useTranslation();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [candidates, setCandidates] = useState<ManagedUserTag[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [target, setTarget] = useState<ManagedUserTag | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    userTagsApi
      .list({ scope, query: debouncedQuery, page: 1, pageSize: USER_TAG_PAGE_SIZE }, controller.signal)
      .then((result) => setCandidates(mergeTargetCandidates(result.tags, source)))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [debouncedQuery, reloadToken, scope, source]);

  return (
    <Dialog onClose={onClose} dismissible={!busy} size="md">
      <DialogHeader
        title={t("personal.tags.mergeTitle", { name: source.name })}
        description={t("personal.tags.mergeDescription", { name: source.name })}
        onClose={busy ? undefined : onClose}
        closeLabel={t("common.close")}
      />
      <DialogBody className="space-y-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id={searchId}
            className="w-full pl-9"
            value={query}
            placeholder={t("personal.tags.mergeSearch")}
            aria-label={t("personal.tags.mergeSearch")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <fieldset className="min-w-0">
          <legend className="mb-1.5 text-sm font-medium">{t("personal.tags.mergeTarget")}</legend>
          {failed ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground">
              <span>{t("personal.tags.mergeTargetsFailed")}</span>
              <Button size="sm" variant="outline" onClick={() => setReloadToken((value) => value + 1)}>
                {t("common.retry")}
              </Button>
            </div>
          ) : candidates === null ? (
            <div className="grid place-items-center py-6 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-label={t("common.loading")} />
            </div>
          ) : candidates.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("personal.tags.mergeNoTargets")}</p>
          ) : (
            <div className="app-scrollbar max-h-72 divide-y overflow-y-auto rounded-lg border">
              {candidates.map((candidate) => {
                const selected = target?.id === candidate.id;
                return (
                  <label
                    key={candidate.id}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-3 px-3 text-sm hover:bg-muted/60",
                      selected && "bg-primary/10",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${searchId}-target`}
                      className="h-4 w-4 accent-[hsl(var(--primary))]"
                      checked={selected}
                      onChange={() => setTarget(candidate)}
                    />
                    <span className="min-w-0 flex-1 truncate" title={candidate.name}>
                      {candidate.name}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {candidate.usageCount > 0
                        ? t("personal.tags.usage", { count: candidate.usageCount })
                        : t("personal.tags.unused")}
                    </span>
                    {selected && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button disabled={!target || busy} onClick={() => target && onMerge(target)}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {t("personal.tags.mergeConfirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export function DeleteUserTagDialog({
  tag,
  busy,
  onClose,
  onDelete,
}: {
  tag: ManagedUserTag;
  busy: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog onClose={onClose} dismissible={!busy} size="sm" role="alertdialog">
      <DialogHeader
        title={t("personal.tags.deleteTitle", { name: tag.name })}
        description={
          tag.usageCount > 0
            ? t("personal.tags.deleteDescription", { count: tag.usageCount })
            : t("personal.tags.deleteUnused")
        }
      />
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy} autoFocus>
          {t("common.cancel")}
        </Button>
        <Button variant="destructive" onClick={onDelete} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {t("personal.tags.deleteConfirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
