import { ControlButton, Controls, MiniMap } from "@xyflow/react";
import { Map as MapIcon } from "lucide-react";
import { useState } from "react";

const VIEWPORT_EDGE_GAP = 12;
const CONTROL_COLUMN_WIDTH_WITH_GAP = 48;

export function WorkflowViewportTools({
  compact = false,
  rightInset = 0,
}: {
  compact?: boolean;
  rightInset?: number;
}) {
  const [miniMapVisible, setMiniMapVisible] = useState(false);
  const controlsRight = rightInset + VIEWPORT_EDGE_GAP;

  return (
    <>
      {miniMapVisible && (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          ariaLabel="Workflow minimap"
          className="workflow-viewport-minimap border border-border"
          style={{
            right: controlsRight + CONTROL_COLUMN_WIDTH_WITH_GAP,
            bottom: VIEWPORT_EDGE_GAP,
            width: compact ? 160 : 200,
            height: compact ? 100 : 150,
          }}
          bgColor="hsl(var(--card))"
          maskColor="hsl(var(--muted) / 0.6)"
          nodeColor="hsl(var(--muted-foreground) / 0.7)"
        />
      )}
      <Controls
        showInteractive={false}
        position="bottom-right"
        className="workflow-viewport-controls"
        style={{ right: controlsRight, bottom: VIEWPORT_EDGE_GAP }}
        aria-label="Workflow viewport controls"
      >
        <ControlButton
          className="workflow-minimap-toggle"
          aria-label={miniMapVisible ? "Hide minimap" : "Show minimap"}
          title={miniMapVisible ? "Hide minimap" : "Show minimap"}
          aria-pressed={miniMapVisible}
          onClick={() => setMiniMapVisible((visible) => !visible)}
        >
          <MapIcon />
        </ControlButton>
      </Controls>
    </>
  );
}
