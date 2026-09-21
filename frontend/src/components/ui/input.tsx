import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/tailwindClassNames";

/**
 * Shared field treatment for text inputs, native selects, and textareas so
 * forms keep one border, focus, and disabled language across every surface.
 */
const fieldBase =
  "rounded-[var(--control-radius)] border border-input bg-card text-sm text-foreground shadow-[inset_0_1px_1px_hsl(var(--foreground)/0.03)] outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/80 hover:border-muted-foreground/40 focus:border-ring/70 focus:ring-2 focus:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-error-border aria-[invalid=true]:focus:ring-error/30";

const fieldSizeVariants = {
  sm: "h-9 px-3",
  default: "h-[var(--control-height)] px-3",
  lg: "h-11 px-3",
};

const inputVariants = cva(fieldBase, {
  variants: { fieldSize: fieldSizeVariants },
  defaultVariants: { fieldSize: "default" },
});

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">, VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, fieldSize, ...props }, ref) => (
  <input ref={ref} className={cn(inputVariants({ fieldSize }), className)} {...props} />
));
Input.displayName = "Input";

const nativeSelectVariants = cva(cn(fieldBase, "cursor-pointer pr-2"), {
  variants: { fieldSize: fieldSizeVariants },
  defaultVariants: { fieldSize: "default" },
});

export interface NativeSelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "size">, VariantProps<typeof nativeSelectVariants> {}

const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, fieldSize, ...props }, ref) => (
    <select ref={ref} className={cn(nativeSelectVariants({ fieldSize }), className)} {...props} />
  ),
);
NativeSelect.displayName = "NativeSelect";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldBase, "min-h-20 px-3 py-2", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";

export { Input, NativeSelect, Textarea, inputVariants };
