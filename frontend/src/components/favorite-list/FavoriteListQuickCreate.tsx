import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toastFromError } from "@/components/ui/toast";
import { api, type FavoriteList } from "@/lib/api";

/** Creates a list in place; the caller stages its membership with the other selected lists. */
export function FavoriteListQuickCreate({
  disabled,
  onCreated,
  onCancel,
}: {
  disabled: boolean;
  onCreated: (list: FavoriteList) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    if (disabled || saving || !name.trim()) return;
    setSaving(true);
    setError("");
    try {
      onCreated(await api.createFavoriteList({ name: name.trim() }));
    } catch (nextError) {
      setError(toastFromError(nextError, t("favorites.listSaveFailed")).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-label={t("favorites.addList")}
      className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void create();
      }}
    >
      <label htmlFor={nameId} className="block text-xs font-medium">
        {t("favorites.name")}
      </label>
      <Input
        id={nameId}
        fieldSize="sm"
        value={name}
        autoFocus
        disabled={disabled || saving}
        onChange={(event) => setName(event.target.value)}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          {t("content.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={disabled || saving || !name.trim()}>
          {saving ? t("favorites.saving") : t("favorites.addList")}
        </Button>
      </div>
    </form>
  );
}
