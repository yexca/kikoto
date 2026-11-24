import { useEffect, useState } from "react";

import { defaultDirectoryRoutingRules } from "@/features/work-detail/directory/directoryModel";
import { api, type DirectoryRoutingRule } from "@/lib/api";
import { startLoad } from "@/lib/effectScope";

/** The configured directory routing rules, or the defaults until and unless they load. */
export function useDirectoryRoutingRules() {
  const [rules, setRules] = useState<DirectoryRoutingRule[]>(defaultDirectoryRoutingRules);
  useEffect(
    () =>
      startLoad((signal) => api.getRuntimeSettings(signal), {
        onSuccess: (settings) => setRules(settings.directoryRoutingRules ?? defaultDirectoryRoutingRules),
        onError: () => setRules(defaultDirectoryRoutingRules),
      }),
    [],
  );
  return rules;
}
