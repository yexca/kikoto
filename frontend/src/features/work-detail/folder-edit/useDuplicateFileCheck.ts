import { useEffect, useRef, useState } from "react";

import { api, type DuplicateFileGroup } from "@/lib/api";

export type DuplicateFileCheck =
  | { status: "idle" | "error" }
  | { status: "running"; checkedFiles: number; pendingFiles: number }
  | { status: "done"; groups: DuplicateFileGroup[] };

/**
 * Runs the identical-file check of a work's family on demand. The server does
 * a bounded share per request, so the check repeats until it is complete and
 * stops when the workspace closes or the check is cancelled.
 */
export function useDuplicateFileCheck(workId: number) {
  const [check, setCheck] = useState<DuplicateFileCheck>({ status: "idle" });
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );
  const start = async () => {
    const current = ++run.current;
    setCheck({ status: "running", checkedFiles: 0, pendingFiles: 0 });
    try {
      for (;;) {
        const result = await api.findWorkDuplicateFiles(workId);
        if (current !== run.current) return;
        if (result.complete) {
          setCheck({ status: "done", groups: result.groups });
          return;
        }
        setCheck({ status: "running", checkedFiles: result.checkedFiles, pendingFiles: result.pendingFiles });
      }
    } catch {
      if (current === run.current) setCheck({ status: "error" });
    }
  };
  const reset = () => {
    run.current += 1;
    setCheck({ status: "idle" });
  };
  return { check, start, reset };
}
