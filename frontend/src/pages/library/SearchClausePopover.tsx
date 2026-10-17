import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { normalizeSearchClauseDraft, type SearchClause } from "@/lib/librarySearchClauses";
import { SearchClauseEditor, type SearchClauseEditorState } from "@/pages/library/SearchClauseEditor";

/**
 * The search clause editor's state. It floats next to whichever control
 * opened it: the add button in the search field or the edited clause badge.
 * Saving or removing a clause hands the new clause list to `onClausesChange`.
 */
export function useSearchClauseEditor({
  clauses,
  onClausesChange,
}: {
  clauses: SearchClause[];
  onClausesChange: (clauses: SearchClause[]) => void;
}) {
  const [editor, setEditor] = useState<SearchClauseEditorState | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  const openAdd = (anchor: HTMLElement) => {
    if (editor?.mode === "add") {
      setEditor(null);
      return;
    }
    anchorRef.current = anchor;
    setEditor({ mode: "add", index: null, draft: { kind: "text", value: "" } });
  };

  const openEdit = (clause: SearchClause, index: number, anchor: HTMLElement) => {
    if (editor?.mode === "edit" && editor.index === index) {
      setEditor(null);
      return;
    }
    anchorRef.current = anchor;
    setEditor({ mode: "edit", index, draft: { kind: clause.kind, value: clause.value } });
  };

  const onOpenChange = useCallback((open: boolean) => {
    if (!open) setEditor(null);
  }, []);

  const save = () => {
    if (!editor) return;
    const clause = normalizeSearchClauseDraft(editor.draft);
    if (!clause) return;
    if (editor.mode === "add") {
      onClausesChange([...clauses, clause]);
    } else if (editor.index !== null) {
      onClausesChange(clauses.map((item, index) => (index === editor.index ? clause : item)));
    }
    setEditor(null);
  };

  const remove = (index: number) => {
    onClausesChange(clauses.filter((_clause, clauseIndex) => clauseIndex !== index));
    setEditor(null);
  };

  return { editor, setEditor, anchorRef, openAdd, openEdit, onOpenChange, save, remove };
}

export type SearchClauseEditorControl = ReturnType<typeof useSearchClauseEditor>;

/** The search clause editor in a popover anchored to the control that opened it. */
export function SearchClausePopover({ open, control }: { open: boolean; control: SearchClauseEditorControl }) {
  const { t } = useTranslation();
  const { editor, setEditor } = control;
  return (
    <AnchoredPopover
      open={open && editor !== null}
      anchorRef={control.anchorRef}
      align="start"
      ariaLabel={editor?.mode === "edit" ? t("library.editSearchCondition") : t("library.addSearchCondition")}
      onOpenChange={control.onOpenChange}
      className="w-[min(24rem,calc(100vw-1.5rem))] p-3"
    >
      {editor && (
        <SearchClauseEditor
          editor={editor}
          onChange={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          onCancel={() => setEditor(null)}
          onSave={control.save}
        />
      )}
    </AnchoredPopover>
  );
}
