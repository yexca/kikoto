import { FormEvent, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Save, Trash2, UserCog } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type ManagedUser } from "@/lib/api";

const roles: ManagedUser["role"][] = ["user", "admin", "super_admin"];

export function UsersPage({ currentUserId, isSuperAdmin }: { currentUserId: number; isSuperAdmin: boolean }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | "new">("new");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) ?? null,
    [selectedUserId, users],
  );

  const refresh = async () => {
    setIsLoading(true);
    setError("");
    try {
      const nextUsers = await api.listUsers();
      setUsers(nextUsers);
      if (selectedUserId !== "new" && !nextUsers.some((user) => user.id === selectedUserId)) {
        setSelectedUserId("new");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const saveUser = async (payload: UserFormPayload) => {
    setIsSaving(true);
    setError("");
    setMessage("");
    try {
      if (selectedUser) {
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
        setMessage("User updated");
      } else {
        const created = await api.createUser(payload);
        setUsers((items) => [...items, created]);
        setSelectedUserId(created.id);
        setMessage("User created");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setIsSaving(false);
    }
  };

  const deleteUser = async (user: ManagedUser) => {
    setIsSaving(true);
    setError("");
    setMessage("");
    try {
      await api.deleteUser(user.id);
      setUsers((items) => items.filter((item) => item.id !== user.id));
      setSelectedUserId("new");
      setMessage("User deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">User management</h2>
            <p className="text-sm text-muted-foreground">Create users, assign roles, and disable accounts.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={isLoading}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setSelectedUserId("new")}>
              <Plus className="h-4 w-4" />
              New user
            </Button>
          </div>
        </div>

        {(error || message) && (
          <div className={error ? "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" : "rounded-md border bg-secondary px-3 py-2 text-sm text-secondary-foreground"}>
            {error || message}
          </div>
        )}

        <Card>
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
                  {users.map((user) => (
                    <tr key={user.id} className="border-b last:border-0">
                      <td className="px-4 py-3">
                        <div className="font-medium">{user.displayName || user.username}</div>
                        <div className="text-xs text-muted-foreground">@{user.username}</div>
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
        key={selectedUser ? selectedUser.id : "new"}
        user={selectedUser}
        currentUserId={currentUserId}
        isSuperAdmin={isSuperAdmin}
        isSaving={isSaving}
        onSave={saveUser}
        onDelete={deleteUser}
      />
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
    <Card className="self-start">
      <CardHeader>
        <CardTitle>{user ? "Edit user" : "New user"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={submit}>
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

          <label className="flex min-h-10 items-center gap-2 rounded-md border bg-card px-3 text-sm font-medium">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            Enabled
          </label>

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

function RoleBadge({ role }: { role: ManagedUser["role"] }) {
  if (role === "super_admin") return <Badge>super admin</Badge>;
  if (role === "admin") return <Badge variant="secondary">admin</Badge>;
  return <Badge variant="outline">user</Badge>;
}
