import { RecordsBrowser } from "@/features/records";
import { systemSettingsPath } from "@/pages/settingsPaths";

/** The `/records` route: the independent record library of personal videos and photos. */
export function RecordsPage() {
  return <RecordsBrowser librarySettingsPath={`${systemSettingsPath("library")}#record`} />;
}
