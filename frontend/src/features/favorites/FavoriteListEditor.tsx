import { ChevronDown, Trash2, Zap } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { favoriteListIcon } from "@/components/favorite-list/favoriteListIcons";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError } from "@/components/ui/toast";
import type { FavoriteList, SmartListRule } from "@/lib/api";
import { FavoriteListDeleteConfirm } from "./FavoriteListDeleteConfirm";
import { FavoriteListIconPicker } from "./FavoriteListIconPicker";
import { SmartRuleEditor } from "./SmartRuleEditor";
import { smartRuleCanSave, smartRuleDraftFromView, smartRuleFromDraft, smartRuleMatchKey } from "./smartListModel";

export type FavoriteListDraft = {
  name: string;
  description: string;
  icon: string;
  /** Sent only when a list is created. */
  kind?: "user" | "smart";
  rule?: SmartListRule;
};

/** What the dialog around the editor must respect: unsaved edits and popovers that own Escape. */
export type FavoriteListEditorGuard = { dirty: boolean; layerOpen: boolean };

function nameKey(name: string) {
  return name.trim().toLocaleLowerCase();
}

/**
 * Creates one list or edits one list inside the list dialog: its header,
 * fields, and footer. An edited list can also be deleted from here.
 */
export function FavoriteListEditor({
  list,
  lists,
  cancelLabel,
  deleting,
  onCancel,
  onClose,
  onSave,
  onDelete,
  onGuardChange,
}: {
  list: FavoriteList | null;
  /** The user's lists, so a name another list already uses can be pointed out. */
  lists: FavoriteList[];
  cancelLabel: string;
  deleting: boolean;
  onCancel: () => void;
  onClose: () => void;
  onSave: (payload: FavoriteListDraft) => Promise<void>;
  onDelete: (list: FavoriteList) => Promise<void>;
  onGuardChange: (guard: FavoriteListEditorGuard) => void;
}) {
  const { t } = useTranslation();
  const formID = useId();
  const nameID = useId();
  const descriptionID = useId();
  const iconButtonRef = useRef<HTMLButtonElement | null>(null);
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [icon, setIcon] = useState(list?.icon ?? "");
  const [kind, setKind] = useState<"user" | "smart">(list?.kind === "smart" ? "smart" : "user");
  const [rule, setRule] = useState(() => smartRuleDraftFromView(list?.rule));
  // Saving a rule marks every current match as seen, so an unchanged rule is not sent.
  const [savedRuleKey] = useState(() => smartRuleMatchKey(smartRuleDraftFromView(list?.rule)));
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const PreviewIcon = favoriteListIcon({ icon });
  const smart = kind === "smart";
  const ruleChanged = smart && smartRuleMatchKey(rule) !== savedRuleKey;
  const canSave = Boolean(name.trim()) && (!smart || smartRuleCanSave(rule));
  const duplicate =
    Boolean(name.trim()) && lists.some((item) => item.id !== list?.id && nameKey(item.name) === nameKey(name));
  const dirty =
    name !== (list?.name ?? "") ||
    description !== (list?.description ?? "") ||
    icon !== (list?.icon ?? "") ||
    (!list && kind !== "user") ||
    ruleChanged;
  const iconLabel = icon ? t(`favorites.iconNames.${icon}`) : t("favorites.iconDefault");

  const layerOpen = iconPickerOpen || confirmingDelete;
  useEffect(() => {
    onGuardChange({ dirty, layerOpen });
  }, [dirty, layerOpen, onGuardChange]);

  const save = async () => {
    if (isSaving || !canSave) return;
    setIsSaving(true);
    setError("");
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        icon,
        ...(list ? {} : { kind }),
        ...(smart && (!list || ruleChanged) ? { rule: smartRuleFromDraft(rule) } : {}),
      });
    } catch (nextError) {
      setError(toastFromError(nextError, t("favorites.listSaveFailed")).message);
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!list) return;
    try {
      await onDelete(list);
      setConfirmingDelete(false);
    } catch (nextError) {
      setConfirmingDelete(false);
      setError(toastFromError(nextError, t("favorites.listDeleteFailed")).message);
    }
  };

  return (
    <>
      <DialogHeader
        title={list ? t("favorites.editList") : t("favorites.newList")}
        onClose={onClose}
        closeLabel={t("favorites.closeListEditor")}
      />
      <DialogBody>
        <form
          id={formID}
          aria-label={list ? `${t("favorites.editList")}: ${list.name}` : t("favorites.newList")}
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {!list ? (
            <div className="grid gap-1.5">
              <div
                role="radiogroup"
                aria-label={t("favorites.smart.listType")}
                className={segmentedListClassName("w-fit p-0.5")}
              >
                {(["user", "smart"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={kind === option}
                    className={segmentedItemClassName(kind === option, "h-7 px-2.5 text-xs")}
                    onClick={() => setKind(option)}
                  >
                    {option === "smart" && <Zap className="h-3.5 w-3.5" aria-hidden="true" />}
                    {option === "smart" ? t("favorites.smart.kind") : t("favorites.smart.regularKind")}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {smart ? t("favorites.smart.kindDescription") : t("favorites.regularKindDescription")}
              </p>
            </div>
          ) : list.kind === "smart" ? (
            <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Zap className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              {t("favorites.smart.kindDescription")}
            </p>
          ) : null}
          <div className="grid gap-1.5">
            <label htmlFor={nameID} className="text-xs font-medium text-muted-foreground">
              {t("favorites.name")}
            </label>
            <div className="flex items-center gap-2">
              <button
                ref={iconButtonRef}
                type="button"
                className="inline-flex h-[var(--control-height)] shrink-0 items-center gap-1 rounded-[var(--control-radius)] border border-input bg-card px-2 text-primary transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`${t("favorites.icon")}: ${iconLabel}`}
                title={`${t("favorites.icon")}: ${iconLabel}`}
                aria-haspopup="dialog"
                aria-expanded={iconPickerOpen}
                onClick={() => setIconPickerOpen((open) => !open)}
              >
                <PreviewIcon className="h-[18px] w-[18px]" aria-hidden="true" />
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              </button>
              <Input
                id={nameID}
                className="min-w-0 flex-1"
                value={name}
                autoFocus
                autoComplete="off"
                aria-describedby={duplicate ? `${nameID}-duplicate` : undefined}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            {duplicate && (
              <p id={`${nameID}-duplicate`} className="text-xs text-muted-foreground">
                {t("favorites.duplicateListName")}
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={descriptionID} className="text-xs font-medium text-muted-foreground">
              {t("favorites.description")}
            </label>
            <Input
              id={descriptionID}
              value={description}
              placeholder={t("favorites.descriptionPlaceholder")}
              autoComplete="off"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          {smart && <SmartRuleEditor listId={list?.id} value={rule} onChange={setRule} />}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
        <AnchoredPopover
          open={iconPickerOpen}
          anchorRef={iconButtonRef}
          align="start"
          ariaLabel={t("favorites.icon")}
          onOpenChange={setIconPickerOpen}
          className="w-[min(20rem,calc(100vw-1.5rem))] p-3"
          zIndex={60}
        >
          <div
            // A pointer pick closes the picker; arrow keys keep it open while they move the choice.
            onClick={(event) => {
              if (event.detail > 0 && (event.target as Element).closest('[role="radio"]')) {
                setIconPickerOpen(false);
                iconButtonRef.current?.focus();
              }
            }}
          >
            <FavoriteListIconPicker value={icon} onChange={setIcon} />
          </div>
        </AnchoredPopover>
      </DialogBody>
      <DialogFooter>
        {list && (
          <>
            <Button
              ref={deleteButtonRef}
              type="button"
              variant="ghost"
              size="sm"
              className="mr-auto text-destructive hover:text-destructive"
              disabled={isSaving || deleting}
              aria-haspopup="dialog"
              aria-expanded={confirmingDelete}
              onClick={() => setConfirmingDelete(true)}
            >
              <Trash2 className="h-4 w-4" />
              {t("favorites.deleteList")}
            </Button>
            <FavoriteListDeleteConfirm
              name={list.name}
              listId={list.id}
              open={confirmingDelete}
              anchorRef={deleteButtonRef}
              deleting={deleting}
              onCancel={() => {
                setConfirmingDelete(false);
                window.requestAnimationFrame(() => deleteButtonRef.current?.focus());
              }}
              onConfirm={() => void confirmDelete()}
            />
          </>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isSaving || deleting}>
          {cancelLabel}
        </Button>
        <Button type="submit" form={formID} size="sm" disabled={isSaving || deleting || !canSave}>
          {isSaving ? t("favorites.saving") : list ? t("content.save") : t("favorites.createList")}
        </Button>
      </DialogFooter>
    </>
  );
}
