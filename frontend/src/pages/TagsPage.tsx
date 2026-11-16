import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { contentPageClassName } from "@/components/ui/page-width";
import { UserTagManagementPage } from "@/features/user-tags/UserTagManagementPage";
import { cn } from "@/lib/tailwindClassNames";

/** The signed-in account's personal tags for works, circles, and voice actors. */
export function TagsPage({ canEdit, demoMode }: { canEdit: boolean; demoMode: boolean }) {
  return (
    <div className={cn(contentPageClassName, "space-y-6")}>
      {demoMode && <DemoReadOnlyNotice />}
      <UserTagManagementPage canEdit={canEdit} demoMode={demoMode} />
    </div>
  );
}
