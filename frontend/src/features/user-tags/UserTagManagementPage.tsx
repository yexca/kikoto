import { GitMerge, Loader2, Pencil, Search, Tags, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { CollectionPagination } from "@/components/collection/CollectionPagination";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/usePendingAction";
import type { UserTagScope } from "@/lib/api";
import { announceUserTagsChanged } from "@/lib/userTagEvents";

import { DeleteUserTagDialog, MergeUserTagDialog, RenameUserTagDialog } from "./UserTagDialogs";
import { isDuplicateTagNameError, pageAfterRemoval, replaceTag, USER_TAG_PAGE_SIZE } from "./userTagManagementModel";
import { userTagsApi, type ManagedUserTagPage, type ManagedUserTag } from "./userTagsApi";

const scopes: readonly UserTagScope[] = ["work", "circle", "voice"];

type TagDialog =
  | { kind: "rename"; tag: ManagedUserTag }
  | { kind: "merge"; tag: ManagedUserTag }
  | { kind: "delete"; tag: ManagedUserTag };

export function UserTagManagementPage({ canEdit, demoMode }: { canEdit: boolean; demoMode: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [scope, setScope] = useState<UserTagScope>("work");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ManagedUserTagPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<TagDialog | null>(null);
  const [duplicateName, setDuplicateName] = useState(false);
  const { pending, run } = usePendingAction<"rename" | "merge" | "delete">();

  useEffect(() => {
    const next = query.trim();
    if (next === debouncedQuery) return;
    const timer = window.setTimeout(() => {
      setDebouncedQuery(next);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [debouncedQuery, query]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadFailed(false);
    userTagsApi
      .list({ scope, query: debouncedQuery, page, pageSize: USER_TAG_PAGE_SIZE }, controller.signal)
      .then((next) => {
        setResult(next);
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoadFailed(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [debouncedQuery, page, reloadToken, scope]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);
  const visible = result && result.scope === scope ? result : null;
  const tags = visible?.tags ?? [];
  const total = visible?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / USER_TAG_PAGE_SIZE));
  const closeDialog = () => {
    if (pending) return;
    setDialog(null);
    setDuplicateName(false);
  };

  const rename = (tag: ManagedUserTag, name: string) =>
    void run(
      "rename",
      async () => {
        const updated = await userTagsApi.rename(scope, tag.id, name);
        setResult((current) => (current ? { ...current, tags: replaceTag(current.tags, updated) } : current));
        setDialog(null);
        announceUserTagsChanged(scope);
        toast.success(t("personal.tags.renamed"));
      },
      (error) => {
        if (isDuplicateTagNameError(error)) setDuplicateName(true);
        else toast.notify(toastFromError(error, t("personal.tags.renameFailed")));
      },
    );

  const merge = (source: ManagedUserTag, target: ManagedUserTag) =>
    void run(
      "merge",
      async () => {
        const merged = await userTagsApi.merge(scope, source.id, target.id);
        setDialog(null);
        setPage((current) => pageAfterRemoval(current, tags.length));
        reload();
        announceUserTagsChanged(scope);
        toast.success(t("personal.tags.merged", { source: source.name, target: merged.name }));
      },
      (error) => toast.notify(toastFromError(error, t("personal.tags.mergeFailed"))),
    );

  const remove = (tag: ManagedUserTag) =>
    void run(
      "delete",
      async () => {
        await userTagsApi.remove(scope, tag.id);
        setDialog(null);
        setPage((current) => pageAfterRemoval(current, tags.length));
        reload();
        announceUserTagsChanged(scope);
        toast.success(t("personal.tags.deleted"));
      },
      (error) => toast.notify(toastFromError(error, t("personal.tags.deleteFailed"))),
    );

  return (
    <div className="w-full max-w-4xl space-y-4">
      {!demoMode && !canEdit && <p className="text-sm text-muted-foreground">{t("personal.readOnlyAccount")}</p>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div role="radiogroup" aria-label={t("personal.tags.scope")} className={segmentedListClassName()}>
          {scopes.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              className={segmentedItemClassName(scope === value)}
              onClick={() => {
                if (scope === value) return;
                setScope(value);
                setPage(1);
              }}
            >
              {t(`personal.tags.scopes.${value}`)}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            className="w-full pl-9 pr-10"
            value={query}
            placeholder={t("personal.tags.search")}
            aria-label={t("personal.tags.search")}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              aria-label={t("personal.tags.clearSearch")}
              title={t("personal.tags.clearSearch")}
              onClick={() => setQuery("")}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {loadFailed && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground"
        >
          <span>{t("personal.tags.loadFailed")}</span>
          <Button size="sm" variant="outline" onClick={reload}>
            {t("common.retry")}
          </Button>
        </div>
      )}

      {visible && (
        <CollectionPagination
          placement="top"
          page={page}
          pageSize={USER_TAG_PAGE_SIZE}
          totalItems={total}
          totalPages={totalPages}
          itemLabel={t("personal.tags.itemLabel")}
          ariaLabel={t("personal.tags.pages")}
          refreshing={loading}
          onPageChange={setPage}
        />
      )}

      {!visible && loading ? (
        <div className="grid place-items-center rounded-xl border bg-card py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-label={t("common.loading")} />
        </div>
      ) : visible && tags.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          <Tags className="h-5 w-5" aria-hidden="true" />
          {debouncedQuery ? t("personal.tags.noMatch") : t("personal.tags.empty")}
        </div>
      ) : (
        visible && (
          <ul
            aria-label={t("personal.tags.listLabel")}
            aria-busy={loading}
            className="theme-card-surface divide-y overflow-hidden rounded-xl border bg-card"
          >
            {tags.map((tag) => (
              <li key={tag.id} className="flex min-h-12 items-center gap-3 px-4 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" title={tag.name}>
                    {tag.name}
                  </span>
                  <span className="block text-xs tabular-nums text-muted-foreground">
                    {tag.usageCount > 0
                      ? t("personal.tags.usage", { count: tag.usageCount })
                      : t("personal.tags.unused")}
                  </span>
                </span>
                {canEdit && (
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label={t("personal.tags.rename", { name: tag.name })}
                      title={t("personal.tags.rename", { name: tag.name })}
                      onClick={() => {
                        setDuplicateName(false);
                        setDialog({ kind: "rename", tag });
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label={t("personal.tags.merge", { name: tag.name })}
                      title={t("personal.tags.merge", { name: tag.name })}
                      onClick={() => setDialog({ kind: "merge", tag })}
                    >
                      <GitMerge className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="ml-2 text-muted-foreground hover:text-destructive"
                      aria-label={t("personal.tags.delete", { name: tag.name })}
                      title={t("personal.tags.delete", { name: tag.name })}
                      onClick={() => setDialog({ kind: "delete", tag })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )
      )}

      {visible && (
        <CollectionPagination
          placement="bottom"
          page={page}
          pageSize={USER_TAG_PAGE_SIZE}
          totalItems={total}
          totalPages={totalPages}
          itemLabel={t("personal.tags.itemLabel")}
          ariaLabel={t("personal.tags.pages")}
          onPageChange={setPage}
        />
      )}

      {dialog?.kind === "rename" && (
        <RenameUserTagDialog
          tag={dialog.tag}
          busy={pending === "rename"}
          duplicate={duplicateName}
          onDraftChange={() => setDuplicateName(false)}
          onClose={closeDialog}
          onRename={(name) => rename(dialog.tag, name)}
        />
      )}
      {dialog?.kind === "merge" && (
        <MergeUserTagDialog
          scope={scope}
          source={dialog.tag}
          busy={pending === "merge"}
          onClose={closeDialog}
          onMerge={(target) => merge(dialog.tag, target)}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteUserTagDialog
          tag={dialog.tag}
          busy={pending === "delete"}
          onClose={closeDialog}
          onDelete={() => remove(dialog.tag)}
        />
      )}
    </div>
  );
}
