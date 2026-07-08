import { FormEvent, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Crown, Plus, RefreshCw, Save, Shield, Trash2, UserCog, UserRound, Users, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type ManagedUser } from "@/lib/api";

const roles: ManagedUser["role"][] = ["user", "admin", "super_admin"];
const USER_PAGE_SIZE = 8;

export function UsersPage({ currentUserId, isSuperAdmin }: { currentUserId: number; isSuperAdmin: boolean }) {
  const toast = useToast();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [userPage, setUserPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) ?? null,
    [selectedUserId, users],
  );
  const enabledCount = users.filter((user) => user.enabled).length;
  const adminCount = users.filter((user) => user.role === "admin" || user.role === "super_admin").length;
  const superAdminCount = users.filter((user) => user.role === "super_admin").length;
  const totalPages = Math.max(1, Math.ceil(users.length / USER_PAGE_SIZE));
  const currentPage = Math.min(userPage, totalPages);
  const visibleUsers = users.slice((currentPage - 1) * USER_PAGE_SIZE, currentPage * USER_PAGE_SIZE);

  const refresh = async () => {
    setIsLoading(true);
    try {
      const nextUsers = await api.listUsers();
      setUsers(nextUsers);
      if (selectedUserId !== null && !nextUsers.some((user) => user.id === selectedUserId)) {
        setSelectedUserId(null);
      }
    } catch (err) {
      toast.notify(toastFromError(err, "Failed to load users"));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const createUser = async (payload: UserFormPayload) => {
    setIsSaving(true);
    try {
      const created = await api.createUser(payload);
      setUsers((items) => [...items, created]);
      setSelectedUserId(created.id);
      setIsCreateModalOpen(false);
      toast.success("User created");
    } catch (err) {
      toast.notify(toastFromError(err, "Create failed"));
    } finally {
      setIsSaving(false);
    }
  };

  const updateUser = async (payload: UserFormPayload) => {
    if (!selectedUser) return;
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
      toast.success("User updated");
    } catch (err) {
      toast.notify(toastFromError(err, "Save failed"));
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
      toast.success("User deleted");
    } catch (err) {
      toast.notify(toastFromError(err, "Delete failed"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Administration</p>
            <h2 className="mt-1 text-2xl font-semibold">Users</h2>
            <p className="mt-2 text-sm text-muted-foreground">Create accounts, assign roles, and keep access tidy.</p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-sm sm:flex">
            <UserMetric icon={<Users className="h-4 w-4" />} label="Users" value={String(users.length)} />
            <UserMetric icon={<Shield className="h-4 w-4" />} label="Enabled" value={String(enabledCount)} />
            <UserMetric icon={<Crown className="h-4 w-4" />} label="Admins" value={String(adminCount)} />
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <section className="space-y-4">
        <Card className="overflow-hidden">
          <CardContent className="space-y-3 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">User directory</h2>
                <p className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages} · {users.length} account{users.length === 1 ? "" : "s"}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={isLoading}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </Button>
                <Button size="sm" onClick={() => setIsCreateModalOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Add user
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={() => setUserPage((page) => Math.max(1, page - 1))} disabled={currentPage <= 1} aria-label="Previous users">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
                {visibleUsers.map((user) => (
                  <Button
                    key={user.id}
                    type="button"
                    variant="outline"
                    className={`h-14 min-w-[160px] justify-start px-2 text-left ${
                      selectedUserId === user.id ? "border-primary bg-primary/10 hover:bg-primary/10" : "bg-background"
                    }`}
                    onClick={() => setSelectedUserId(user.id)}
                  >
                    <UserAvatar user={user} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{user.displayName || user.username}</span>
                      <span className="block truncate text-xs text-muted-foreground">@{user.username}</span>
                    </span>
                  </Button>
                ))}
                {!isLoading && visibleUsers.length === 0 && (
                  <div className="grid min-h-14 flex-1 place-items-center rounded-md border border-dashed text-sm text-muted-foreground">
                    No users on this page.
                  </div>
                )}
              </div>
              <Button variant="outline" size="icon" onClick={() => setUserPage((page) => Math.min(totalPages, page + 1))} disabled={currentPage >= totalPages} aria-label="Next users">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">User management</h2>
            <p className="text-sm text-muted-foreground">
              {superAdminCount} super administrator{superAdminCount === 1 ? "" : "s"} can grant protected access.
            </p>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <RoleSummaryCard icon={<UserRound className="h-4 w-4" />} label="Standard users" value={String(users.filter((user) => user.role === "user").length)} />
          <RoleSummaryCard icon={<Shield className="h-4 w-4" />} label="Administrators" value={String(users.filter((user) => user.role === "admin").length)} />
          <RoleSummaryCard icon={<Crown className="h-4 w-4" />} label="Super admins" value={String(superAdminCount)} />
        </div>

        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse text-sm">
                <thead className="border-b bg-muted/60 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-semibold">User</th>
                    <th className="px-4 py-3 font-semibold">Role</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Updated</th>
                    <th className="px-4 py-3 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map((user) => (
                    <tr
                      key={user.id}
                      className={`border-b last:border-0 ${selectedUserId === user.id ? "bg-primary/5" : "hover:bg-muted/40"}`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <UserAvatar user={user} />
                          <div className="min-w-0">
                            <div className="truncate font-medium">{user.displayName || user.username}</div>
                            <div className="truncate text-xs text-muted-foreground">@{user.username}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <RoleBadge role={user.role} />
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={user.enabled ? "secondary" : "warning"}>{user.enabled ? "enabled" : "disabled"}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{user.updatedAt}</td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="outline" size="sm" onClick={() => setSelectedUserId(user.id)}>
                          <UserCog className="h-4 w-4" />
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {!isLoading && users.length === 0 && (
                    <tr>
                      <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                        No users found.
                      </td>
                    </tr>
                  )}
                  {isLoading && (
                    <tr>
                      <td className="px-4 py-8 text-center text-muted-foreground" colSpan={5}>
                        Loading users...
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </section>

      <UserEditor
        key={selectedUser ? selectedUser.id : "empty"}
        user={selectedUser}
        currentUserId={currentUserId}
        isSuperAdmin={isSuperAdmin}
        isSaving={isSaving}
        onSave={updateUser}
        onDelete={deleteUser}
      />
      </div>
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

type UserFormPayload = {
  username: string;
  displayName: string;
  role: ManagedUser["role"];
  password: string;
  enabled: boolean;
};

function UserEditor({
  user,
  currentUserId,
  isSuperAdmin,
  isSaving,
  onSave,
  onDelete,
}: {
  user: ManagedUser | null;
  currentUserId: number;
  isSuperAdmin: boolean;
  isSaving: boolean;
  onSave: (payload: UserFormPayload) => Promise<void>;
  onDelete: (user: ManagedUser) => Promise<void>;
}) {
  const [username, setUsername] = useState(user?.username ?? "");
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [role, setRole] = useState<ManagedUser["role"]>(user?.role ?? "user");
  const [enabled, setEnabled] = useState(user?.enabled ?? true);
  const [password, setPassword] = useState("");

  if (!user) {
    return <EmptyUserEditor />;
  }

  const isEditingSelf = user?.id === currentUserId;
  const canEditRole = isSuperAdmin || role !== "super_admin";
  const canDelete = Boolean(user && !isEditingSelf && (isSuperAdmin || user.role !== "super_admin"));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onSave({ username, displayName, role, password, enabled });
    if (!user) {
      setPassword("");
    }
  };

  return (
    <Card className="self-start overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          {user ? <UserAvatar user={user} size="lg" /> : <EmptyUserAvatar />}
          <span className="min-w-0">
            <span className="block truncate">{user ? "Edit user" : "New user"}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {user ? `@${user.username}` : "Create a local Kikoto account"}
            </span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={submit}>
          <div className="grid gap-2 rounded-lg border bg-background p-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Role</span>
              <RoleBadge role={role} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Status</span>
              <Badge variant={enabled ? "secondary" : "warning"}>{enabled ? "enabled" : "disabled"}</Badge>
            </div>
          </div>

          <label className="grid gap-1.5 text-sm font-medium">
            Username
            <input
              className="h-10 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={Boolean(user)}
              autoComplete="username"
            />
          </label>

          <label className="grid gap-1.5 text-sm font-medium">
            Display name
            <input
              className="h-10 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>

          <label className="grid gap-1.5 text-sm font-medium">
            Role
            <select
              className="h-10 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              value={role}
              onChange={(event) => setRole(event.target.value as ManagedUser["role"])}
              disabled={!canEditRole}
            >
              {roles.map((item) => (
                <option key={item} value={item} disabled={item === "super_admin" && !isSuperAdmin}>
                  {item}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-1.5 text-sm font-medium">
            Password
            <input
              className="h-10 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={user ? "Leave blank to keep current" : "At least 8 characters"}
              autoComplete={user ? "new-password" : "current-password"}
            />
          </label>

          <SwitchField
            label="Enabled"
            description="Allow this account to sign in and use assigned permissions."
            checked={enabled}
            onChange={setEnabled}
          />

          {(isEditingSelf || !canEditRole || (user && !canDelete)) && (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {isEditingSelf
                ? "You cannot delete your own active account from this panel."
                : !canEditRole
                  ? "Only a super administrator can modify protected super administrator access."
                  : "Protected accounts cannot be deleted by your current role."}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button disabled={isSaving}>
              <Save className="h-4 w-4" />
              {isSaving ? "Saving" : "Save"}
            </Button>
            {user && (
              <Button type="button" variant="outline" disabled={isSaving || !canDelete} onClick={() => void onDelete(user)}>
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function EmptyUserEditor() {
  return (
    <Card className="self-start overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          <EmptyUserAvatar />
          <span>
            <span className="block">Select a user</span>
            <span className="block text-xs font-normal text-muted-foreground">Use the user bar or table to edit an account.</span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-dashed bg-background p-4 text-sm text-muted-foreground">
          Add users from the top toolbar. Existing accounts open here for role, status, password, and deletion controls.
        </div>
      </CardContent>
    </Card>
  );
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <Card className="max-h-[90vh] w-full max-w-xl overflow-auto">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-3">
              <EmptyUserAvatar />
              <span className="min-w-0">
                <span className="block truncate">Add user</span>
                <span className="block truncate text-xs font-normal text-muted-foreground">Create a local Kikoto account</span>
              </span>
            </span>
            <Button type="button" variant="outline" size="icon" onClick={onClose} aria-label="Close add user dialog">
              <X className="h-4 w-4" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={submit}>
            <label className="grid gap-1.5 text-sm font-medium">
              Username
              <input
                className="h-10 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
              />
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Display name
              <input
                className="h-10 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Role
              <select
                className="h-10 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={role}
                onChange={(event) => setRole(event.target.value as ManagedUser["role"])}
              >
                {roles.map((item) => (
                  <option key={item} value={item} disabled={item === "super_admin" && !isSuperAdmin}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Password
              <input
                className="h-10 rounded-md border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                required
              />
            </label>

            <SwitchField
              label="Enabled"
              description="Allow this account to sign in immediately."
              checked={enabled}
              onChange={setEnabled}
            />

            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button disabled={isSaving || username.trim() === "" || password.trim() === ""}>
                <Save className="h-4 w-4" />
                {isSaving ? "Creating" : "Create user"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function RoleBadge({ role }: { role: ManagedUser["role"] }) {
  if (role === "super_admin") return <Badge>super admin</Badge>;
  if (role === "admin") return <Badge variant="secondary">admin</Badge>;
  return <Badge variant="outline">user</Badge>;
}

function SwitchField({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-4 rounded-md border bg-card px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
      <Button
        type="button"
        role="switch"
        aria-checked={checked}
        variant={checked ? "default" : "outline"}
        size="icon"
        className={`relative h-6 w-11 shrink-0 rounded-full p-0 ${
          checked ? "border-primary" : "bg-muted hover:bg-muted/80"
        }`}
        onClick={() => onChange(!checked)}
      >
        <span
          className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-background shadow-sm transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </Button>
    </div>
  );
}

function UserMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold leading-6">{value}</div>
    </div>
  );
}

function RoleSummaryCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">{icon}</div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-base font-semibold">{value}</div>
      </div>
    </div>
  );
}

function UserAvatar({ user, size = "md" }: { user: ManagedUser; size?: "md" | "lg" }) {
  const initials = userInitials(user);
  const sizeClass = size === "lg" ? "h-12 w-12 text-base" : "h-9 w-9 text-sm";
  return (
    <div className={`grid ${sizeClass} shrink-0 place-items-center rounded-md bg-primary text-primary-foreground font-semibold`}>
      {initials}
    </div>
  );
}

function EmptyUserAvatar() {
  return (
    <div className="grid h-12 w-12 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
      <Plus className="h-5 w-5" />
    </div>
  );
}

function userInitials(user: ManagedUser) {
  const value = (user.displayName || user.username || "U").trim();
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return value.slice(0, 2).toUpperCase();
}
