package com.yexca.kikoto;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.media.AudioDeviceInfo;

import org.junit.Test;

public class KikotoPrivacyPolicyTest {
    @Test
    public void unlockedDeviceShowsEverythingInEveryMode() {
        for (String mode : new String[] {"full", "hideCover", "hidden"}) {
            KikotoPrivacyPolicy.MediaPresentation shown =
                KikotoPrivacyPolicy.mediaPresentation(mode, false, "Example Track", "Example Circle", "Example Work");
            assertEquals("Example Track", shown.title);
            assertEquals("Example Circle", shown.artist);
            assertEquals("Example Work", shown.album);
            assertTrue(shown.showCover);
        }
    }

    @Test
    public void lockedDeviceFollowsTheLockScreenSetting() {
        KikotoPrivacyPolicy.MediaPresentation full =
            KikotoPrivacyPolicy.mediaPresentation("full", true, "Example Track", "Example Circle", "Example Work");
        assertEquals("Example Track", full.title);
        assertTrue(full.showCover);

        KikotoPrivacyPolicy.MediaPresentation withoutCover =
            KikotoPrivacyPolicy.mediaPresentation("hideCover", true, "Example Track", "Example Circle", "Example Work");
        assertEquals("Example Track", withoutCover.title);
        assertEquals("Example Circle", withoutCover.artist);
        assertFalse(withoutCover.showCover);

        KikotoPrivacyPolicy.MediaPresentation hidden =
            KikotoPrivacyPolicy.mediaPresentation("hidden", true, "Example Track", "Example Circle", "Example Work");
        assertEquals("Kikoto", hidden.title);
        assertEquals("", hidden.artist);
        assertEquals("", hidden.album);
        assertFalse(hidden.showCover);
    }

    @Test
    public void unknownLockScreenSettingHidesTheCover() {
        assertEquals("hideCover", KikotoPrivacyPolicy.normalizeLockScreenContent(null));
        assertEquals("hideCover", KikotoPrivacyPolicy.normalizeLockScreenContent("everything"));
        assertFalse(
            KikotoPrivacyPolicy.mediaPresentation("everything", true, "Example Track", "", "").showCover
        );
    }

    @Test
    public void appLockAppliesAfterTheTimeoutOnlyWithASecureDevice() {
        long left = 10_000L;
        assertTrue(KikotoPrivacyPolicy.appLockRequired(true, true, left, left, 0));
        assertFalse(KikotoPrivacyPolicy.appLockRequired(true, true, left, left + 59_999L, 60));
        assertTrue(KikotoPrivacyPolicy.appLockRequired(true, true, left, left + 60_000L, 60));

        assertFalse(KikotoPrivacyPolicy.appLockRequired(false, true, left, left + 60_000L, 0));
        assertFalse(KikotoPrivacyPolicy.appLockRequired(true, false, left, left + 60_000L, 0));
        assertFalse(KikotoPrivacyPolicy.appLockRequired(
            true, true, KikotoPrivacyPolicy.NOT_BACKGROUNDED, left, 0
        ));
    }

    @Test
    public void unknownAppLockTimeoutLocksImmediately() {
        assertEquals(300, KikotoPrivacyPolicy.normalizeAppLockTimeoutSeconds(300));
        assertEquals(0, KikotoPrivacyPolicy.normalizeAppLockTimeoutSeconds(30));
        assertEquals(0, KikotoPrivacyPolicy.normalizeAppLockTimeoutSeconds(-1));
    }

    @Test
    public void signingOutOrSwitchingServersClearsTheWebCache() {
        String server = "https://server.example.invalid";
        assertFalse(KikotoPrivacyPolicy.sessionChangeClearsWebCache("", "", server, "synthetic-session"));
        assertFalse(KikotoPrivacyPolicy.sessionChangeClearsWebCache(server, "", server, "synthetic-session"));
        assertFalse(KikotoPrivacyPolicy.sessionChangeClearsWebCache(
            server, "synthetic-session", server, "synthetic-session"
        ));

        assertTrue(KikotoPrivacyPolicy.sessionChangeClearsWebCache(server, "synthetic-session", server, ""));
        assertTrue(KikotoPrivacyPolicy.sessionChangeClearsWebCache(server, "synthetic-session", "", ""));
        assertTrue(KikotoPrivacyPolicy.sessionChangeClearsWebCache(
            server, "", "https://other.example.invalid", ""
        ));
    }

    @Test
    public void mediaUsesThePhoneSpeakerOnlyWithoutAnExternalOutput() {
        assertTrue(KikotoPrivacyPolicy.routesMediaToPhoneSpeaker(new int[] {
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
            AudioDeviceInfo.TYPE_TELEPHONY,
        }));
        // A call-only Bluetooth link does not carry media.
        assertTrue(KikotoPrivacyPolicy.routesMediaToPhoneSpeaker(new int[] {
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        }));
        assertTrue(KikotoPrivacyPolicy.routesMediaToPhoneSpeaker(null));

        for (int external : new int[] {
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
        }) {
            assertFalse(KikotoPrivacyPolicy.routesMediaToPhoneSpeaker(new int[] {
                AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
                external,
            }));
        }
    }
}
