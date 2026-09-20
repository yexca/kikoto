import { forwardRef, useEffect, useRef, useState, type ComponentPropsWithoutRef } from "react";
import { useTranslation } from "react-i18next";

// Keep ordinary wheel events out of React Flow's native zoom listener without
// cancelling their default action: the enclosing page or Activity panel scrolls.
export const WorkflowCanvasScrollBoundary = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  function WorkflowCanvasScrollBoundary({ children, className, ...props }, ref) {
    const { t } = useTranslation();
    const [showHint, setShowHint] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout>>();
    const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

    useEffect(() => () => clearTimeout(timer.current), []);

    return (
      <div
        {...props}
        ref={ref}
        className={`relative ${className ?? ""}`}
        onWheelCapture={(event) => {
          clearTimeout(timer.current);
          if (event.ctrlKey || event.metaKey) {
            setShowHint(false);
            return;
          }
          event.stopPropagation();
          setShowHint(true);
          timer.current = setTimeout(() => setShowHint(false), 1800);
        }}
      >
        {children}
        <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex justify-center" role="status">
          {showHint && (
            <span className="rounded-md border bg-popover/95 px-3 py-2 text-center text-xs text-popover-foreground shadow-sm">
              {t("workflowCanvas.scrollZoomHint", { key: modifier })}
            </span>
          )}
        </div>
      </div>
    );
  },
);
