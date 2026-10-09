package com.yexca.kikoto;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Device privacy choices. They live in native storage so the recent apps
 * cover, the app lock, and the media notification follow them before the web
 * view loads and after it is gone.
 */
final class KikotoPrivacySettings {
    static final String DEFAULT_UNLOCK_TITLE = "Unlock Kikoto";
    static final String DEFAULT_UNLOCK_ACTION = "Unlock";

    private static final String PREFERENCES = "kikoto_privacy";
    private static final String KEY_RECENTS_SHIELD = "recentsShield";
    private static final String KEY_LOCK_SCREEN_CONTENT = "lockScreenContent";
    private static final String KEY_SPEAKER_CONFIRM = "speakerConfirm";
    private static final String KEY_SCREEN_SECURE = "screenSecure";
    private static final String KEY_APP_LOCK = "appLock";
    private static final String KEY_APP_LOCK_TIMEOUT_SECONDS = "appLockTimeoutSeconds";
    private static final String KEY_UNLOCK_TITLE = "unlockTitle";
    private static final String KEY_UNLOCK_ACTION = "unlockAction";

    final boolean recentsShield;
    final String lockScreenContent;
    final boolean speakerConfirm;
    final boolean screenSecure;
    final boolean appLock;
    final int appLockTimeoutSeconds;

    private KikotoPrivacySettings(
        boolean recentsShield,
        String lockScreenContent,
        boolean speakerConfirm,
        boolean screenSecure,
        boolean appLock,
        int appLockTimeoutSeconds
    ) {
        this.recentsShield = recentsShield;
        this.lockScreenContent = KikotoPrivacyPolicy.normalizeLockScreenContent(lockScreenContent);
        this.speakerConfirm = speakerConfirm;
        this.screenSecure = screenSecure;
        this.appLock = appLock;
        this.appLockTimeoutSeconds = KikotoPrivacyPolicy.normalizeAppLockTimeoutSeconds(appLockTimeoutSeconds);
    }

    static KikotoPrivacySettings read(Context context) {
        SharedPreferences preferences = preferences(context);
        return new KikotoPrivacySettings(
            preferences.getBoolean(KEY_RECENTS_SHIELD, true),
            preferences.getString(KEY_LOCK_SCREEN_CONTENT, KikotoPrivacyPolicy.DEFAULT_LOCK_SCREEN_CONTENT),
            preferences.getBoolean(KEY_SPEAKER_CONFIRM, true),
            preferences.getBoolean(KEY_SCREEN_SECURE, false),
            preferences.getBoolean(KEY_APP_LOCK, false),
            preferences.getInt(KEY_APP_LOCK_TIMEOUT_SECONDS, KikotoPrivacyPolicy.DEFAULT_APP_LOCK_TIMEOUT_SECONDS)
        );
    }

    /** Stores the provided fields; a null field keeps its current value. */
    static KikotoPrivacySettings update(Context context, Change change) {
        KikotoPrivacySettings current = read(context);
        KikotoPrivacySettings next = new KikotoPrivacySettings(
            change.recentsShield == null ? current.recentsShield : change.recentsShield,
            change.lockScreenContent == null ? current.lockScreenContent : change.lockScreenContent,
            change.speakerConfirm == null ? current.speakerConfirm : change.speakerConfirm,
            change.screenSecure == null ? current.screenSecure : change.screenSecure,
            change.appLock == null ? current.appLock : change.appLock,
            change.appLockTimeoutSeconds == null ? current.appLockTimeoutSeconds : change.appLockTimeoutSeconds
        );
        preferences(context).edit()
            .putBoolean(KEY_RECENTS_SHIELD, next.recentsShield)
            .putString(KEY_LOCK_SCREEN_CONTENT, next.lockScreenContent)
            .putBoolean(KEY_SPEAKER_CONFIRM, next.speakerConfirm)
            .putBoolean(KEY_SCREEN_SECURE, next.screenSecure)
            .putBoolean(KEY_APP_LOCK, next.appLock)
            .putInt(KEY_APP_LOCK_TIMEOUT_SECONDS, next.appLockTimeoutSeconds)
            .apply();
        return next;
    }

    /** The unlock prompt's title and button in the app language, kept for a cold start before the web view loads. */
    static String[] unlockLabels(Context context) {
        SharedPreferences preferences = preferences(context);
        return new String[] {
            preferences.getString(KEY_UNLOCK_TITLE, DEFAULT_UNLOCK_TITLE),
            preferences.getString(KEY_UNLOCK_ACTION, DEFAULT_UNLOCK_ACTION),
        };
    }

    static void storeUnlockLabels(Context context, String title, String action) {
        preferences(context).edit()
            .putString(KEY_UNLOCK_TITLE, title == null || title.trim().isEmpty() ? DEFAULT_UNLOCK_TITLE : title)
            .putString(KEY_UNLOCK_ACTION, action == null || action.trim().isEmpty() ? DEFAULT_UNLOCK_ACTION : action)
            .apply();
    }

    private static SharedPreferences preferences(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    static final class Change {
        Boolean recentsShield;
        String lockScreenContent;
        Boolean speakerConfirm;
        Boolean screenSecure;
        Boolean appLock;
        Integer appLockTimeoutSeconds;
    }
}
