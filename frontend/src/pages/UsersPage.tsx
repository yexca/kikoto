import { FormEvent, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Save, Search, Trash2, UserRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, NativeSelect } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toastFromError, useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { api, type ManagedUser } from "@/lib/api";

const roles: ManagedUser["role"][] = ["user", "admin", "super_admin"];
const USER_PAGE_SIZE = 12;
const WIDE_LAYOUT_QUERY = "(min-width: 1280px)";

type UserFormPayload = {
  username: string;
  displayName: string;
  role: ManagedUser["role"];
  password: string;
  enabled: boolean;
};

function useWideLayout() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_LAYOUT_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia(WIDE_LAYOUT_QUERY);
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return wide;
}

export function UsersPage({
  currentUserId,
  isSuperAdmin,
  readOnly = false,
  embedded = false,
}: {
  currentUserId: number;
  isSuperAdmin: boolean;
  readOnly?: boolean;
  embedded?: boolean;
}) {
  const toast = useToast();
  const { t } = useTranslation();
  const isWide = useWideLayout();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [query, setQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [userPage, setUserPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const requestSeq = useRef(0);

  const selectedUser = useMemo(() => users.find((user) => user.id === selectedUserId) ?? null, [selectedUserId, users]);
  const filteredUsers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return users;
    return users.filter(
      (user) => user.username.toLowerCase().includes(needle) || user.displayName.toLowerCase().includes(needle),
    );
  }, [query, users]);
  const adminCount = users.filter((user) => user.role === "admin" || user.role === "super_admin").length;
  const disabledCount = users.filter((user) => !user.enabled).length;
  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / USER_PAGE_SIZE));
  const currentPage = Math.min(userPage, totalPages);
  const visibleUsers = filteredUsers.slice((currentPage - 1) * USER_PAGE_SIZE, currentPage * USER_PAGE_SIZE);
  const initialLoading = isLoading && !hasLoaded;
  const summary = [
    t("admin.summaryAccounts", { count: users.length }),
    t("admin.summaryAdmins", { count: adminCount }),
    ...(disabledCount > 0 ? [t("admin.summaryDisabled", { count: disabledCount })] : []),
  ].join(" · ");

  const refresh = async () => {
    const seq = ++requestSeq.current;
    setIsLoading(true);
    setLoadError("");
    try {
      const nextUsers = await api.listUsers();
      if (seq !== requestSeq.current) return;
      setUsers(nextUsers);
      setHasLoaded(true);
      setSelectedUserId((current) =>
        current !== null && !nextUsers.some((user) => user.id === current) ? null : current,
      );
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(t("admin.loadFailed"));
      toast.notify(toastFromError(err, t("admin.loadError")));
    } finally {
      if (seq === requestSeq.current) setIsLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    return () => {
      requestSeq.current += 1;
    };
  }, []);

  const createUser = async (payload: UserFormPayload) => {
    setIsSaving(true);
    try {
      const created = await api.createUser(payload);
      setUsers((items) => [...items, created]);
      setSelectedUserId(created.id);
      setIsCreateModalOpen(false);
      toast.success(t("admin.created"));
    } catch (err) {
      toast.notify(toastFromError(err, t("admin.createFailed")));
    } finally {
      setIsSaving(false);
    }
  };

  const updateUser = async (payload: UserFormPayload) => {
    if (!selectedUser) return false;
    setIsSaving(true);
    try {
      const updatePayload: Parameters<typeof api.updateUser>[1] = {
        displayName: payload.displayName,
        role: payload.role,
        enabled: payload.enabled,
      };
      if (payload.password.trim() !== "") {
        updatePayload.password = payload.password;
      }
      const updated = await api.updateUser(selectedUser.id, updatePayload);
      setUsers((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(t("admin.updatedToast"));
      return true;
    } catch (err) {
      toast.notify(toastFromError(err, t("admin.saveFailed")));
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const deleteUser = async (user: ManagedUser) => {
    setIsSaving(true);
    try {
      await api.deleteUser(user.id);
      setUsers((items) => items.filter((item) => item.id !== user.id));
      setSelectedUserId(null);
      toast.success(t("admin.deleted"));
    } catch (err) {
      toast.notify(toastFromError(err, t("admin.deleteFailed")));
    } finally {
      setIsSaving(false);
    }
  };

  const editor = (layout: "panel" | "dialog") => {
    if (!selectedUser) return null;
    return (
      <UserEditor
        key={`${selectedUser.id}:${selectedUser.updatedAt}`}
        layout={layout}
        user={selectedUser}
        currentUserId={currentUserId}
        isSuperAdmin={isSuperAdmin}
        readOnly={readOnly}
        isSaving={isSaving}
        onSave={updateUser}
        onDelete={deleteUser}
        onClose={() => setSelectedUserId(null)}
      />
    );
  };

  return (
    <div className="space-y-4">
      {!embedded && (
        <header>
          <p className="text-sm font-medium text-muted-foreground">{t("admin.heading")}</p>
          <h2 className="mt-1 text-2xl font-semibold">{t("admin.users")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("admin.subtitle")}</p>
        </header>
      )}

      {loadError && (
        <div
          className="flex min-h-12 flex-wrap items-center justify-between gap-3 rounded-lg border border-error-border bg-error-surface px-3 py-2"
          role="alert"
        >
          <span className="text-sm text-error-foreground">
            {loadError}
            {hasLoaded ? ` ${t("admin.existingDataShown")}` : ""}
          </span>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            {t("admin.retry")}
          </Button>
        </div>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-10 min-w-0 flex-[1_1_14rem] items-center gap-2 rounded-[var(--control-radius)] border border-input bg-card px-3 text-sm focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/35 max-sm:h-11">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                type="search"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/80"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setUserPage(1);
                }}
                placeholder={t("admin.searchPlaceholder")}
                aria-label={t("admin.searchPlaceholder")}
              />
            </label>
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
              <span className="mr-auto truncate text-sm text-muted-foreground sm:mr-1" aria-live="polite">
                {initialLoading ? "" : summary}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 max-sm:h-11 max-sm:w-11"
                onClick={() => void refresh()}
                disabled={isLoading}
                aria-label={t("admin.refresh")}
                title={t("admin.refresh")}
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
              </Button>
              <Button className="shrink-0" onClick={() => setIsCreateModalOpen(true)} disabled={readOnly}>
                <Plus className="h-4 w-4" />
                {t("admin.addUser")}
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border bg-card" aria-busy={isLoading}>
            {initialLoading ? (
              <UserRowSkeletons />
            ) : visibleUsers.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                {query.trim() ? t("admin.noMatches", { query: query.trim() }) : t("admin.noUsersFound")}
              </p>
            ) : (
              <ul className="divide-y">
                {visibleUsers.map((user) => (
                  <li key={user.id}>
                    <UserRow
                      user={user}
                      isSelf={user.id === currentUserId}
                      selected={user.id === selectedUserId}
                      onSelect={() => setSelectedUserId(user.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {totalPages > 1 && (
              <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
                <span>{t("admin.pageStatus", { page: currentPage, total: totalPages })}</span>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="max-sm:h-11 max-sm:w-11"
                    onClick={() => setUserPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage <= 1}
                    aria-label={t("admin.previousUsers")}
                    title={t("admin.previousUsers")}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="max-sm:h-11 max-sm:w-11"
                    onClick={() => setUserPage(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage >= totalPages}
                    aria-label={t("admin.nextUsers")}
                    title={t("admin.nextUsers")}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>

        {isWide && (
          <aside className="self-start overflow-hidden rounded-lg border bg-card xl:sticky xl:top-4">
            {editor("panel") ?? <EmptyUserEditor />}
          </aside>
        )}
      </div>

      {!isWide && selectedUser && (
        <Dialog onClose={() => setSelectedUserId(null)} size="md" dismissible={!isSaving}>
          {editor("dialog")}
        </Dialog>
      )}

      {isCreateModalOpen && (
        <UserCreateModal
          isSuperAdmin={isSuperAdmin}
          isSaving={isSaving}
          onSave={createUser}
          onClose={() => setIsCreateModalOpen(false)}
        />
      )}
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  selected,
  onSelect,
}: {
  user: ManagedUser;
  isSelf: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const updated = formatDateTime(user.updatedAt, resolvedLocale) || user.updatedAt;
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={`flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
        selected ? "bg-primary/10 shadow-[inset_3px_0_0_hsl(var(--primary))]" : "hover:bg-muted/50 active:bg-muted"
      }`}
    >
      <UserAvatar user={user} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{user.displayName || user.username}</span>
          {isSelf && (
            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[11px]">
              {t("admin.you")}
            </Badge>
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground">@{user.username}</span>
      </span>
      <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {!user.enabled && <Badge variant="warning">{t("admin.disabledStatus")}</Badge>}
        <RoleBadge role={user.role} />
      </span>
      <span className="hidden w-36 shrink-0 truncate text-right text-xs text-muted-foreground md:block">{updated}</span>
    </button>
  );
}

function UserEditor({
  layout,
  user,
  currentUserId,
  isSuperAdmin,
  readOnly,
  isSaving,
  onSave,
  onDelete,
  onClose,
}: {
  layout: "panel" | "dialog";
  user: ManagedUser;
  currentUserId: number;
  isSuperAdmin: boolean;
  readOnly: boolean;
  isSaving: boolean;
  onSave: (payload: UserFormPayload) => Promise<boolean>;
  onDelete: (user: ManagedUser) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<ManagedUser["role"]>(user.role);
  const [enabled, setEnabled] = useState(user.enabled);
  const [password, setPassword] = useState("");
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  const isEditingSelf = user.id === currentUserId;
  const canEditRole = isSuperAdmin || user.role !== "super_admin";
  const canDelete = !isEditingSelf && (isSuperAdmin || user.role !== "super_admin");
  const isDirty =
    displayName !== user.displayName || role !== user.role || enabled !== user.enabled || password.trim() !== "";
  const protectionNotice = isEditingSelf
    ? t("admin.cannotDeleteSelf")
    : !canEditRole
      ? t("admin.protectedRole")
      : !canDelete
        ? t("admin.protectedDelete")
        : "";
  const displayLabel = user.displayName || user.username;
  const updated = formatDateTime(user.updatedAt, resolvedLocale) || user.updatedAt;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isDirty) return;
    const saved = await onSave({ username: user.username, displayName, role, password, enabled });
    if (saved && layout === "dialog") onClose();
  };

  const statusBadges = (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <RoleBadge role={user.role} />
      {!user.enabled && <Badge variant="warning">{t("admin.disabledStatus")}</Badge>}
      {isEditingSelf && <Badge variant="outline">{t("admin.you")}</Badge>}
    </div>
  );

  const fields = (
    <div className="space-y-4">
      <label className="grid gap-1.5 text-sm font-medium">
        {t("admin.displayName")}
        <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={readOnly} />
      </label>

      <label className="grid gap-1.5 text-sm font-medium">
        {t("admin.role")}
        <NativeSelect
          value={role}
          onChange={(event) => setRole(event.target.value as ManagedUser["role"])}
          disabled={readOnly || !canEditRole}
        >
          <RoleOptions isSuperAdmin={isSuperAdmin} />
        </NativeSelect>
      </label>

      <label className="grid gap-1.5 text-sm font-medium">
        {t("admin.credentialField")}
        <Input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={readOnly}
          placeholder={t("admin.keepCurrentCredential")}
          autoComplete="new-password"
        />
      </label>

      <SwitchField
        label={t("admin.enabled")}
        description={t("admin.allowAssignedPermissions")}
        checked={enabled}
        onChange={setEnabled}
        disabled={readOnly}
      />

      {protectionNotice && (
        <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">{protectionNotice}</p>
      )}
    </div>
  );

  const actions = (
    <>
      {canDelete && !readOnly ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mr-auto text-muted-foreground hover:text-error-foreground"
          disabled={isSaving}
          onClick={() => setIsConfirmingDelete(true)}
        >
          <Trash2 className="h-4 w-4" />
          {t("admin.deleteUser")}
        </Button>
      ) : (
        <span className="mr-auto" />
      )}
      <Button type="submit" size="sm" disabled={readOnly || isSaving || !isDirty}>
        <Save className="h-4 w-4" />
        {isSaving ? t("admin.saving") : t("admin.save")}
      </Button>
    </>
  );

  const confirmDialog = isConfirmingDelete && (
    <Dialog
      onClose={() => setIsConfirmingDelete(false)}
      size="sm"
      role="alertdialog"
      layer="overlay-nested"
      dismissible={!isSaving}
    >
      <DialogHeader
        title={t("admin.deleteConfirmTitle", { name: displayLabel })}
        description={t("admin.deleteConfirmDescription", { username: user.username })}
      />
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={() => setIsConfirmingDelete(false)} disabled={isSaving}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={isSaving}
          onClick={async () => {
            await onDelete(user);
            setIsConfirmingDelete(false);
          }}
        >
          <Trash2 className="h-4 w-4" />
          {isSaving ? t("admin.deleting") : t("admin.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );

  if (layout === "dialog") {
    return (
      <>
        <DialogHeader
          title={displayLabel}
          description={`@${user.username}`}
          onClose={onClose}
          closeLabel={t("admin.closeEditor")}
        >
          {statusBadges}
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <DialogBody>{fields}</DialogBody>
          <DialogFooter>{actions}</DialogFooter>
        </form>
        {confirmDialog}
      </>
    );
  }

  return (
    <>
      <div className="flex items-start gap-3 border-b px-4 py-4">
        <UserAvatar user={user} size="lg" />
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold leading-6">{displayLabel}</h3>
          <p className="truncate text-sm text-muted-foreground">@{user.username}</p>
          {statusBadges}
        </div>
      </div>
      <form onSubmit={submit}>
        <div className="px-4 py-4">
          {fields}
          <p className="mt-4 text-xs text-muted-foreground">{t("admin.updatedAt", { time: updated })}</p>
        </div>
        <div className="flex items-center gap-2 border-t px-4 py-3">{actions}</div>
      </form>
      {confirmDialog}
    </>
  );
}

function EmptyUserEditor() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <div className="grid h-10 w-10 place-items-center rounded-full bg-muted text-muted-foreground">
        <UserRound className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium">{t("admin.selectUser")}</p>
      <p className="text-xs text-muted-foreground">{t("admin.selectUserHint")}</p>
    </div>
  );
}

function UserRowSkeletons() {
  return (
    <div className="divide-y">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex min-h-14 items-center gap-3 px-3 py-2">
          <SkeletonLine className="h-9 w-9 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonLine className="h-4 w-32" />
            <SkeletonLine className="h-3 w-20" />
          </div>
          <SkeletonLine className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function SkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

function UserCreateModal({
  isSuperAdmin,
  isSaving,
  onSave,
  onClose,
}: {
  isSuperAdmin: boolean;
  isSaving: boolean;
  onSave: (payload: UserFormPayload) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<ManagedUser["role"]>("user");
  const [enabled, setEnabled] = useState(true);
  const [password, setPassword] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onSave({ username, displayName, role, password, enabled });
  };

  return (
    <Dialog onClose={onClose} size="md" dismissible={false}>
      <DialogHeader
        title={t("admin.addUser")}
        description={t("admin.createAccount")}
        onClose={onClose}
        closeLabel={t("admin.closeAddDialog")}
      />
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <DialogBody className="space-y-4">
          <label className="grid gap-1.5 text-sm font-medium">
            {t("admin.username")}
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
            />
          </label>

          <label className="grid gap-1.5 text-sm font-medium">
            {t("admin.displayName")}
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>

          <label className="grid gap-1.5 text-sm font-medium">
            {t("admin.role")}
            <NativeSelect value={role} onChange={(event) => setRole(event.target.value as ManagedUser["role"])}>
              <RoleOptions isSuperAdmin={isSuperAdmin} />
            </NativeSelect>
          </label>

          <label className="grid gap-1.5 text-sm font-medium">
            {t("admin.credentialField")}
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("admin.atLeastEight")}
              autoComplete="new-password"
              required
            />
          </label>

          <SwitchField
            label={t("admin.enabled")}
            description={t("admin.allowImmediateSignIn")}
            checked={enabled}
            onChange={setEnabled}
          />
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isSaving}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={isSaving || username.trim() === "" || password.trim() === ""}>
            <Save className="h-4 w-4" />
            {isSaving ? t("admin.creating") : t("admin.createUser")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function RoleOptions({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      {roles.map((item) => (
        <option key={item} value={item} disabled={item === "super_admin" && !isSuperAdmin}>
          {t(`admin.roles.${item}`)}
        </option>
      ))}
    </>
  );
}

function RoleBadge({ role }: { role: ManagedUser["role"] }) {
  const { t } = useTranslation();
  if (role === "super_admin") return <Badge>{t("admin.roles.super_admin")}</Badge>;
  if (role === "admin") return <Badge variant="secondary">{t("admin.roles.admin")}</Badge>;
  return <Badge variant="outline">{t("admin.roles.user")}</Badge>;
}

function SwitchField({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />
    </div>
  );
}

function UserAvatar({ user, size = "md" }: { user: ManagedUser; size?: "md" | "lg" }) {
  const sizeClass = size === "lg" ? "h-12 w-12 text-base" : "h-9 w-9 text-sm";
  return (
    <div
      className={`grid ${sizeClass} shrink-0 place-items-center rounded-full bg-primary/10 font-semibold text-primary`}
      aria-hidden="true"
    >
      {userInitials(user)}
    </div>
  );
}

function userInitials(user: ManagedUser) {
  const value = (user.displayName || user.username || "U").trim();
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return value.slice(0, 2).toUpperCase();
}
