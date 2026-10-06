import type { CurrentUser } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";

export function UserAvatar({ user, className }: { user: CurrentUser; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-primary/15 font-semibold text-primary ring-1 ring-inset ring-primary/25",
        className,
      )}
    >
      {userInitial(user)}
    </span>
  );
}

export function userDisplayName(user: CurrentUser) {
  return user.displayName || user.username;
}

function userInitial(user: CurrentUser) {
  return (user.displayName || user.username || "U").trim().slice(0, 1).toUpperCase();
}
