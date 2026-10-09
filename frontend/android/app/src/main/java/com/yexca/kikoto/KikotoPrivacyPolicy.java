package com.yexca.kikoto;

import android.media.AudioDeviceInfo;

/** Pure privacy decisions shared by the privacy plugin and the media service. */
final class KikotoPrivacyPolicy {
    static final String LOCK_SCREEN_FULL = "full";
    static final String LOCK_SCREEN_HIDE_COVER = "hideCover";
    static final String LOCK_SCREEN_HIDDEN = "hidden";
    static final String DEFAULT_LOCK_SCREEN_CONTENT = LOCK_SCREEN_HIDE_COVER;
    static final String HIDDEN_TITLE = "Kikoto";
    static final int DEFAULT_APP_LOCK_TIMEOUT_SECONDS = 0;
    static final long NOT_BACKGROUNDED = -1L;
    private static final int[] APP_LOCK_TIMEOUTS_SECONDS = {0, 60, 300, 900};

    private KikotoPrivacyPolicy() {}

    static int normalizeAppLockTimeoutSeconds(int value) {
        for (int allowed : APP_LOCK_TIMEOUTS_SECONDS) {
            if (allowed == value) return value;
        }
        return DEFAULT_APP_LOCK_TIMEOUT_SECONDS;
    }

    /**
     * Whether returning to Kikoto needs an unlock. The lock needs a secure
     * device screen lock to authenticate against, and applies once the app
     * has spent at least the timeout outside the foreground.
     */
    static boolean appLockRequired(
        boolean enabled,
        boolean deviceSecure,
        long backgroundedAtMs,
        long nowMs,
        int timeoutSeconds
    ) {
        if (!enabled || !deviceSecure || backgroundedAtMs == NOT_BACKGROUNDED) return false;
        return nowMs - backgroundedAtMs >= normalizeAppLockTimeoutSeconds(timeoutSeconds) * 1000L;
    }

    /**
     * Whether a session change discards the WebView's HTTP cache: signing out,
     * replacing the session, or switching servers. Signing in to the server
     * already in use keeps it, because nothing private was cached before.
     */
    static boolean sessionChangeClearsWebCache(
        String previousServer,
        String previousSession,
        String nextServer,
        String nextSession
    ) {
        if (previousServer == null || previousServer.isEmpty()) return false;
        if (!previousServer.equals(nextServer)) return true;
        return previousSession != null && !previousSession.isEmpty() && !previousSession.equals(nextSession);
    }

    static String normalizeLockScreenContent(String value) {
        if (LOCK_SCREEN_FULL.equals(value) || LOCK_SCREEN_HIDE_COVER.equals(value) || LOCK_SCREEN_HIDDEN.equals(value)) {
            return value;
        }
        return DEFAULT_LOCK_SCREEN_CONTENT;
    }

    /**
     * What the system media controls may show. The notification, the media
     * session, and connected Bluetooth or car displays all read this, so a
     * locked device publishes only what its lock screen setting allows.
     */
    static MediaPresentation mediaPresentation(
        String lockScreenContent,
        boolean deviceLocked,
        String title,
        String artist,
        String album
    ) {
        String content = normalizeLockScreenContent(lockScreenContent);
        if (!deviceLocked || LOCK_SCREEN_FULL.equals(content)) {
            return new MediaPresentation(title, artist, album, true);
        }
        if (LOCK_SCREEN_HIDE_COVER.equals(content)) {
            return new MediaPresentation(title, artist, album, false);
        }
        return new MediaPresentation(HIDDEN_TITLE, "", "", false);
    }

    /**
     * Whether media plays from the phone itself. Android routes media to a
     * connected headset, Bluetooth A2DP or LE audio device, USB, HDMI, or dock
     * output; without one it uses the built-in speaker. A call-only Bluetooth
     * SCO link does not carry media.
     */
    static boolean routesMediaToPhoneSpeaker(int[] outputTypes) {
        if (outputTypes == null) return true;
        for (int type : outputTypes) {
            if (isExternalMediaOutput(type)) return false;
        }
        return true;
    }

    private static boolean isExternalMediaOutput(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_LINE_ANALOG:
            case AudioDeviceInfo.TYPE_LINE_DIGITAL:
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
            case AudioDeviceInfo.TYPE_HDMI:
            case AudioDeviceInfo.TYPE_HDMI_ARC:
            case AudioDeviceInfo.TYPE_HDMI_EARC:
            case AudioDeviceInfo.TYPE_USB_DEVICE:
            case AudioDeviceInfo.TYPE_USB_ACCESSORY:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_DOCK:
            case AudioDeviceInfo.TYPE_DOCK_ANALOG:
            case AudioDeviceInfo.TYPE_AUX_LINE:
            case AudioDeviceInfo.TYPE_HEARING_AID:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
            case AudioDeviceInfo.TYPE_BLE_SPEAKER:
            case AudioDeviceInfo.TYPE_BLE_BROADCAST:
                return true;
            default:
                return false;
        }
    }

    static final class MediaPresentation {
        final String title;
        final String artist;
        final String album;
        final boolean showCover;

        MediaPresentation(String title, String artist, String album, boolean showCover) {
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.showCover = showCover;
        }
    }
}
