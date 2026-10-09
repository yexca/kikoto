package com.yexca.kikoto;

import android.media.AudioDeviceInfo;

/** Pure privacy decisions shared by the privacy plugin and the media service. */
final class KikotoPrivacyPolicy {
    static final String LOCK_SCREEN_FULL = "full";
    static final String LOCK_SCREEN_HIDE_COVER = "hideCover";
    static final String LOCK_SCREEN_HIDDEN = "hidden";
    static final String DEFAULT_LOCK_SCREEN_CONTENT = LOCK_SCREEN_HIDE_COVER;
    static final String HIDDEN_TITLE = "Kikoto";

    private KikotoPrivacyPolicy() {}

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
