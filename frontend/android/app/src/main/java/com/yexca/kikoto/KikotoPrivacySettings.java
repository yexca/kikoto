package com.yexca.kikoto;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Device privacy choices. They live in native storage so the recent apps
 * cover and the media notification follow them before the web view loads and
 * after it is gone.
 */
final class KikotoPrivacySettings {
    private static final String PREFERENCES = "kikoto_privacy";
    private static final String KEY_RECENTS_SHIELD = "recentsShield";
    private static final String KEY_LOCK_SCREEN_CONTENT = "lockScreenContent";
    private static final String KEY_SPEAKER_CONFIRM = "speakerConfirm";

    final boolean recentsShield;
    final String lockScreenContent;
    final boolean speakerConfirm;

    private KikotoPrivacySettings(boolean recentsShield, String lockScreenContent, boolean speakerConfirm) {
        this.recentsShield = recentsShield;
        this.lockScreenContent = KikotoPrivacyPolicy.normalizeLockScreenContent(lockScreenContent);
        this.speakerConfirm = speakerConfirm;
    }

    static KikotoPrivacySettings read(Context context) {
        SharedPreferences preferences = preferences(context);
        return new KikotoPrivacySettings(
            preferences.getBoolean(KEY_RECENTS_SHIELD, true),
            preferences.getString(KEY_LOCK_SCREEN_CONTENT, KikotoPrivacyPolicy.DEFAULT_LOCK_SCREEN_CONTENT),
            preferences.getBoolean(KEY_SPEAKER_CONFIRM, true)
        );
    }

    /** Stores the provided fields; a null field keeps its current value. */
    static KikotoPrivacySettings update(
        Context context,
        Boolean recentsShield,
        String lockScreenContent,
        Boolean speakerConfirm
    ) {
        KikotoPrivacySettings current = read(context);
        KikotoPrivacySettings next = new KikotoPrivacySettings(
            recentsShield == null ? current.recentsShield : recentsShield,
            lockScreenContent == null ? current.lockScreenContent : lockScreenContent,
            speakerConfirm == null ? current.speakerConfirm : speakerConfirm
        );
        preferences(context).edit()
            .putBoolean(KEY_RECENTS_SHIELD, next.recentsShield)
            .putString(KEY_LOCK_SCREEN_CONTENT, next.lockScreenContent)
            .putBoolean(KEY_SPEAKER_CONFIRM, next.speakerConfirm)
            .apply();
        return next;
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
