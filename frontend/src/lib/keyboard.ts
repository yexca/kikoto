import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export function dismissKeyboardOnEnter(event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  event.currentTarget.blur();
}
