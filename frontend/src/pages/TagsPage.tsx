import { DemoReadOnlyNotice } from "@/components/DemoReadOnlyNotice";
import { UserTagManagementPage } from "@/features/user-tags/UserTagManagementPage";

/** The signed-in account's personal tags for works, circles, and voice actors. */
export function TagsPage({ canEdit, demoMode }: { canEdit: boolean; demoMode: boolean }) {
  return (
    <div className="space-y-6">
      {demoMode && <DemoReadOnlyNotice />}
      <UserTagManagementPage canEdit={canEdit} demoMode={demoMode} />
    </div>
  );
}
