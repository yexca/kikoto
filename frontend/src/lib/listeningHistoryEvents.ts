/**
 * Announced after the listener's history is cleared on the server. Players for
 * the same server and principal discard unreported listening sessions so a
 * delayed report cannot add pre-clear time back. Other tabs of this origin
 * hear it through a BroadcastChannel where the browser supports one.
 */
export const LISTENING_HISTORY_CLEARED_EVENT = "kikoto:listening-history-cleared";

const LISTENING_HISTORY_CHANNEL = "kikoto:listening-history";

type ListeningHistoryClearedMessage = {
  type: "cleared";
  /** The client storage scope: server identity and principal. */
  scope: string;
  /** Identifies the announcing tab, whose own listeners already heard the window event. */
  tab: string;
};

const tabID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function openChannel() {
  try {
    return typeof BroadcastChannel === "function" ? new BroadcastChannel(LISTENING_HISTORY_CHANNEL) : null;
  } catch {
    return null;
  }
}

export function announceListeningHistoryCleared(scope: string) {
  window.dispatchEvent(new CustomEvent<{ scope: string }>(LISTENING_HISTORY_CLEARED_EVENT, { detail: { scope } }));
  const channel = openChannel();
  if (!channel) return;
  try {
    channel.postMessage({ type: "cleared", scope, tab: tabID } satisfies ListeningHistoryClearedMessage);
  } finally {
    channel.close();
  }
}

/** Calls `onCleared` when history is cleared for exactly this server and principal. */
export function subscribeListeningHistoryCleared(scope: string, onCleared: () => void) {
  const handleWindowEvent = (event: Event) => {
    if ((event as CustomEvent<{ scope?: string }>).detail?.scope === scope) onCleared();
  };
  window.addEventListener(LISTENING_HISTORY_CLEARED_EVENT, handleWindowEvent);
  const channel = openChannel();
  if (channel) {
    channel.onmessage = (event: MessageEvent<Partial<ListeningHistoryClearedMessage>>) => {
      const message = event.data;
      if (message?.type === "cleared" && message.scope === scope && message.tab !== tabID) onCleared();
    };
  }
  return () => {
    window.removeEventListener(LISTENING_HISTORY_CLEARED_EVENT, handleWindowEvent);
    channel?.close();
  };
}
