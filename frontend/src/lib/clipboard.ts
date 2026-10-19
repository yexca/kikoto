/**
 * Copies text to the system clipboard. The Clipboard API exists only in a
 * secure context, so a server opened over plain HTTP on a LAN address, or a
 * page whose clipboard permission is denied, copies through a temporary
 * selection instead. Call it from the click that asked for the copy: both
 * paths need that click's user activation. Rejects when neither path copies.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // A denied permission or an unfocused document; the selection copy may still work.
    }
  }
  if (!selectionCopy(text)) throw new Error("Clipboard unavailable");
}

// The field is focused for the copy, so it is not hidden from assistive
// technology; it lives only for the duration of the copy. Read-only keeps the
// on-screen keyboard closed, and iOS selects a read-only field's text only
// through an explicit range.
function selectionCopy(text: string) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px";
  const previousFocus = document.activeElement as HTMLElement | null;
  document.body.append(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previousFocus?.focus?.({ preventScroll: true });
  }
}
