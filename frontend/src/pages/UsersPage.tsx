import { FormEvent, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Lock, Plus, Save, Search, Trash2, UserCog } from "lucide-react";

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
const USER_PAGE_SIZE = 10;

type UserFormPayload = {
  username: string;
  displayName: string;
  role: ManagedUser["role"];
  password: string;
  enabled: boolean;
};

type UserPermissions = {
  /** Role, password and enabled state are fixed by the environment or by role rules. */
  environmentManaged: boolean;
  canEditRole: boolean;
  canEditCredential: boolean;
  canToggleEnabled: boolean;
  canDelete: boolean;
};

function userPermissions(
  user: ManagedUser,
  { currentUserId, isSuperAdmin, readOnly }: { currentUserId: number; isSuperAdmin: boolean; readOnly: boolean },
): UserPermissions {
  const environmentManaged = Boolean(user.environmentManaged);
  const isSelf = user.id === currentUserId;
  const protectedRole = !isSuperAdmin && user.role === "super_admin";
  const editable = !readOnly && !protectedRole;
  return {
    environmentManaged,
    canEditRole: editable && !environmentManaged,
    canEditCredential: editable && !environmentManaged,
    canToggleEnabled: editable && !environmentManaged && !isSelf,
    canDelete: editable && !environmentManaged && !isSelf,
  };
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
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [query, setQuery] = useState("");
  const [detailUserId, setDetailUserId] = useState<number | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [userPage, setUserPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [togglingUserId, setTogglingUserId] = useState<number | null>(null);
  const requestSeq = useRef(0);

  const detailUser = useMemo(() => users.find((user) => user.id === detailUserId) ?? null, [detailUserId, users]);
  const filteredUsers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return users;
    return users.filter(
      (user) => user.username.toLowerCase().includes(needle) || user.displayName.toLowerCase().includes(needle),
    );
  }, [query, users]);
  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / USER_PAGE_SIZE));
  const currentPage = Math.min(userPage, totalPages);
  const visibleUsers = filteredUsers.slice((currentPage - 1) * USER_PAGE_SIZE, currentPage * USER_PAGE_SIZE);
  const initialLoading = isLoading && !hasLoaded;
  const permissionContext = { currentUserId, isSuperAdmin, readOnly };

  const refresh = async () => {
    const seq = ++requestSeq.current;
    setIsLoading(true);
    setLoadError("");
    try {
      const nextUsers = await api.listUsers();
      if (seq !== requestSeq.current) return;
      setUsers(nextUsers);
      setHasLoaded(true);
      setDetailUserId((current) =>
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

  const replaceUser = (updated: ManagedUser) =>
    setUsers((items) => items.map((item) => (item.id === updated.id ? updated : item)));

  const createUser = async (payload: UserFormPayload) => {
    setIsSaving(true);
    try {
      const created = await api.createUser(payload);
      setUsers((items) => [...items, created]);
      setIsCreateModalOpen(false);
      toast.success(t("admin.created"));
    } catch (err) {
      toast.notify(toastFromError(err, t("admin.createFailed")));
    } finally {
      setIsSaving(false);
    }
  };

  const updateUser = async (user: ManagedUser, payload: UserFormPayload) => {
    setIsSaving(true);
    try {
      const permissions = userPermissions(user, permissionContext);
      const updatePayload: Parameters<typeof api.updateUser>[1] = { displayName: payload.displayName };
      if (permissions.canEditRole) updatePayload.role = payload.role;
      if (permissions.canEditCredential && payload.password.trim() !== "") updatePayload.password = payload.password;
      replaceUser(await api.updateUser(user.id, updatePayload));
      toast.success(t("admin.updatedToast"));
      return true;
    } catch (err) {
      toast.notify(toastFromError(err, t("admin.saveFailed")));
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const toggleEnabled = async (user: ManagedUser, enabled: boolean) => {
    setTogglingUserId(user.id);
    try {
      replaceUser(await api.updateUser(user.id, { enabled }));
      toast.success(
        t(enabled ? "admin.enabledToast" : "admin.disabledToast", { name: user.displayName || user.username }),
      );
    } catch (err) {
      toast.notify(toastFromError(err, t("admin.saveFailed")));
    } finally {
      setTogglingUserId(null);
    }
  };

  const deleteUser = async (user: ManagedUser) => {
    setIsSaving(true);
    try {
      await api.deleteUser(user.id);
      setUsers((items) => items.filter((item) => item.id !== user.id));
      setDetailUserId(null);
      toast.success(t("admin.deleted"));
    } catch (err) {
      toast.notify(toastFromError(err, t("admin.deleteFailed")));
    } finally {
      setIsSaving(false);
    }
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

      <div className="flex items-center gap-2">
        <label className="flex h-10 min-w-0 max-w-sm flex-1 items-center gap-2 rounded-[var(--control-radius)] border border-input bg-card px-3 text-sm focus-within:border-ring/70 focus-within:ring-2 focus-within:ring-ring/35 max-sm:h-11">
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
        <Button className="ml-auto shrink-0" onClick={() => setIsCreateModalOpen(true)} disabled={readOnly}>
          <Plus className="h-4 w-4" />
          {t("admin.addUser")}
        </Button>
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
                  permissions={userPermissions(user, permissionContext)}
                  toggling={togglingUserId === user.id}
                  onToggleEnabled={(enabled) => void toggleEnabled(user, enabled)}
                  onOpenDetails={() => setDetailUserId(user.id)}
                />
              </li>
            ))}
          </ul>
        )}
        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-1 border-t px-3 py-1.5 text-xs text-muted-foreground">
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
            <span className="min-w-12 text-center tabular-nums">
              {t("admin.pageStatus", { page: currentPage, total: totalPages })}
            </span>
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
        )}
      </div>

      {detailUser && (
        <Dialog onClose={() => setDetailUserId(null)} size="md" dismissible={!isSaving}>
          <UserDetails
            key={`${detailUser.id}:${detailUser.updatedAt}`}
            user={detailUser}
            isSelf={detailUser.id === currentUserId}
            isSuperAdmin={isSuperAdmin}
            permissions={userPermissions(detailUser, permissionContext)}
            readOnly={readOnly}
            isSaving={isSaving}
            onSave={(payload) => updateUser(detailUser, payload)}
            onDelete={deleteUser}
            onClose={() => setDetailUserId(null)}
          />
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
  permissions,
  toggling,
  onToggleEnabled,
  onOpenDetails,
}: {
  user: ManagedUser;
  isSelf: boolean;
  permissions: UserPermissions;
  toggling: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onOpenDetails: () => void;
}) {
  const { t } = useTranslation();
  const { resolvedLocale } = useLocale();
  const name = user.displayName || user.username;
  const updated = formatDateTime(user.updatedAt, resolvedLocale) || user.updatedAt;
  const toggleHint = permissions.environmentManaged
    ? t("admin.environmentManagedShort")
    : isSelf
      ? t("admin.cannotDisableSelf")
      : t("admin.toggleEnabled", { name });
  return (
    <div className="flex min-h-14 items-center gap-3 px-3 py-2 max-sm:min-h-[3.75rem]">
      <UserAvatar user={user} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {isSelf && (
            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[11px]">
              {t("admin.you")}
            </Badge>
          )}
          {permissions.environmentManaged && (
            <span title={t("admin.environmentManagedShort")} className="shrink-0 text-muted-foreground">
              <Lock className="h-3.5 w-3.5" aria-label={t("admin.environmentManagedShort")} />
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">@{user.username}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {!user.enabled && <Badge variant="warning">{t("admin.disabledStatus")}</Badge>}
        <RoleBadge role={user.role} />
      </div>
      <span className="hidden w-36 shrink-0 truncate text-right text-xs text-muted-foreground lg:block">{updated}</span>
      <div className="flex shrink-0 items-center gap-1 border-l pl-3" title={toggleHint}>
        <Switch
          checked={user.enabled}
          onCheckedChange={onToggleEnabled}
          disabled={!permissions.canToggleEnabled || toggling}
          aria-label={toggleHint}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          className="max-sm:h-11 max-sm:w-11"
          onClick={onOpenDetails}
          aria-label={t("admin.viewDetails", { name })}
          title={t("admin.viewDetails", { name })}
        >
          <UserCog className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function UserDetails({
  user,
  isSelf,
  isSuperAdmin,
  permissions,
  readOnly,
  isSaving,
  onSave,
  onDelete,
  onClose,
}: {
  user: ManagedUser;
  isSelf: boolean;
  isSuperAdmin: boolean;
  permissions: UserPermissions;
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
  const [password, setPassword] = useState("");
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  const isDirty = displayName !== user.displayName || role !== user.role || password.trim() !== "";
  const notice = permissions.environmentManaged
    ? t("admin.environmentManagedNotice")
    : isSelf
      ? t("admin.cannotDeleteSelf")
      : !isSuperAdmin && user.role === "super_admin"
        ? t("admin.protectedRole")
        : "";
  const displayLabel = user.displayName || user.username;
  const updated = formatDateTime(user.updatedAt, resolvedLocale) || user.updatedAt;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isDirty) return;
    const saved = await onSave({ username: user.username, displayName, role, password, enabled: user.enabled });
    if (saved) onClose();
  };

  return (
    <>
      <DialogHeader
        title={displayLabel}
        description={`@${user.username} · ${t("admin.updatedAt", { time: updated })}`}
        onClose={onClose}
        closeLabel={t("admin.closeEditor")}
      >
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <RoleBadge role={user.role} />
          {!user.enabled && <Badge variant="warning">{t("admin.disabledStatus")}</Badge>}
          {isSelf && <Badge variant="outline">{t("admin.you")}</Badge>}
        </div>
      </DialogHeader>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <DialogBody className="space-y-4">
          {notice && (
            <p className="flex gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              {permissions.environmentManaged && <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              <span>{notice}</span>
            </p>
          )}
          <label className="grid gap-1.5 text-sm font-medium">
            {t("admin.displayName")}
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={readOnly || (!isSuperAdmin && user.role === "super_admin")}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            {t("admin.role")}
            <NativeSelect
              value={role}
              onChange={(event) => setRole(event.target.value as ManagedUser["role"])}
              disabled={!permissions.canEditRole}
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
              disabled={!permissions.canEditCredential}
              placeholder={
                permissions.environmentManaged ? t("admin.environmentCredential") : t("admin.keepCurrentCredential")
              }
              autoComplete="new-password"
            />
          </label>
        </DialogBody>
        <DialogFooter>
          {permissions.canDelete ? (
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
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={isSaving}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={readOnly || isSaving || !isDirty}>
            <Save className="h-4 w-4" />
            {isSaving ? t("admin.saving") : t("admin.save")}
          </Button>
        </DialogFooter>
      </form>
      {isConfirmingDelete && (
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
      )}
    </>
  );
}

function UserRowSkeletons() {
  return (
    <div className="divide-y">
      {Array.from({ length: 1 }, (_, index) => (
        <div key={index} className="flex min-h-14 items-center gap-3 px-3 py-2 max-sm:min-h-[3.75rem]">
          <SkeletonLine className="h-9 w-9 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonLine className="h-4 w-32" />
            <SkeletonLine className="h-3 w-20" />
          </div>
          <SkeletonLine className="h-5 w-16 rounded-full" />
          <SkeletonLine className="h-5 w-20 rounded-full" />
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

function UserAvatar({ user }: { user: ManagedUser }) {
  return (
    <div
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
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
