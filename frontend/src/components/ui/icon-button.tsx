import type { MouseEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function IconButton({
  title,
  disabled,
  children,
  onClick,
  "aria-pressed": pressed,
}: {
  title: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  "aria-pressed"?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="toolbar"
      size="icon-sm"
      className="relative"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
