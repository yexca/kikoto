import { useEffect, useState } from "react";

import { defaultDirectoryRoutingRules } from "@/features/work-detail/directory/directoryModel";
import { api, type DirectoryRoutingRule } from "@/lib/api";

/** The configured directory routing rules, or the defaults until and unless they load. */
export function useDirectoryRoutingRules() {
  const [rules, setRules] = useState<DirectoryRoutingRule[]>(defaultDirectoryRoutingRules);
  useEffect(() => {
    let cancelled = false;
    api
      .getRuntimeSettings()
      .then((settings) => {
        if (!cancelled) setRules(settings.directoryRoutingRules ?? defaultDirectoryRoutingRules);
      })
      .catch(() => {
        if (!cancelled) setRules(defaultDirectoryRoutingRules);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return rules;
}
