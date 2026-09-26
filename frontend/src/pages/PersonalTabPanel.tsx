import { lazy, Suspense, type ComponentProps } from "react";

import type { PersonalTab } from "@/pages/personalTabs";

// Each personal tab loads its own chunk so Settings does not download them up front.
const ListeningHistoryPage = lazy(() =>
  import("@/features/listening-history/ListeningHistoryPage").then((module) => ({
    default: module.ListeningHistoryPage,
  })),
);
const UserTagManagementPage = lazy(() =>
  import("@/features/user-tags/UserTagManagementPage").then((module) => ({ default: module.UserTagManagementPage })),
);
const UserDataPage = lazy(() =>
  import("@/features/user-data/UserDataPage").then((module) => ({ default: module.UserDataPage })),
);

export type PersonalTabProps = {
  history: ComponentProps<typeof ListeningHistoryPage>;
  tags: ComponentProps<typeof UserTagManagementPage>;
  data: ComponentProps<typeof UserDataPage>;
};

export function PersonalTabPanel({ tab, history, tags, data }: PersonalTabProps & { tab: PersonalTab }) {
  return (
    <Suspense fallback={null}>
      {tab === "history" && <ListeningHistoryPage {...history} />}
      {tab === "tags" && <UserTagManagementPage {...tags} />}
      {tab === "data" && <UserDataPage {...data} />}
    </Suspense>
  );
}
