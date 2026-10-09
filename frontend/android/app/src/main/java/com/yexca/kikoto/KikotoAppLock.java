package com.yexca.kikoto;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

/**
 * Covers the app until the device owner authenticates with a biometric or the
 * device screen lock. Kikoto stores no secret of its own: Android 11 and later
 * use BiometricPrompt with the device credential as a fallback, and earlier
 * versions use the system screen lock confirmation.
 */
final class KikotoAppLock {
    private final AppCompatActivity activity;
    private final View content;
    private final ActivityResultLauncher<Intent> credentialLauncher;
    private View cover;
    private boolean locked = false;
    private boolean authenticating = false;
    // A cancelled prompt waits for the Unlock button instead of reopening.
    private boolean promptDismissed = false;
    private long backgroundedAt = KikotoPrivacyPolicy.NOT_BACKGROUNDED;
    private CancellationSignal cancellation;

    /** Must be created before the activity starts, so the result launcher can register. */
    KikotoAppLock(AppCompatActivity activity, View content) {
        this.activity = activity;
        this.content = content;
        this.credentialLauncher = activity.registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            result -> finishAuthentication(result.getResultCode() == Activity.RESULT_OK)
        );
    }

    /** A cold start opens locked. */
    void onLaunch() {
        if (KikotoPrivacySettings.read(activity).appLock && deviceSecure()) lock();
    }

    void onStart() {
        if (authenticating) return;
        if (locked) {
            promptDismissed = false;
            return;
        }
        KikotoPrivacySettings settings = KikotoPrivacySettings.read(activity);
        if (KikotoPrivacyPolicy.appLockRequired(
            settings.appLock,
            deviceSecure(),
            backgroundedAt,
            SystemClock.elapsedRealtime(),
            settings.appLockTimeoutSeconds
        )) {
            lock();
        }
        backgroundedAt = KikotoPrivacyPolicy.NOT_BACKGROUNDED;
    }

    void onResume() {
        if (locked && !authenticating && !promptDismissed) authenticate();
    }

    void onStop() {
        if (locked || authenticating) return;
        backgroundedAt = SystemClock.elapsedRealtime();
        // An immediate lock covers the window while it leaves, so returning
        // never draws a frame of the page.
        KikotoPrivacySettings settings = KikotoPrivacySettings.read(activity);
        if (KikotoPrivacyPolicy.appLockRequired(
            settings.appLock,
            deviceSecure(),
            backgroundedAt,
            backgroundedAt,
            settings.appLockTimeoutSeconds
        )) {
            lock();
        }
    }

    void onDestroy() {
        if (cancellation != null) cancellation.cancel();
        cancellation = null;
    }

    void settingsChanged(KikotoPrivacySettings settings) {
        if (!settings.appLock && locked) unlock();
    }

    boolean deviceSecure() {
        KeyguardManager keyguard = activity.getSystemService(KeyguardManager.class);
        return keyguard != null && keyguard.isDeviceSecure();
    }

    private void lock() {
        locked = true;
        promptDismissed = false;
        showCover();
        content.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    }

    private void unlock() {
        locked = false;
        promptDismissed = false;
        hideCover();
        content.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
    }

    private void authenticate() {
        // Without a screen lock there is nothing to authenticate against, and
        // anyone holding the device can already reach it.
        if (!deviceSecure()) {
            unlock();
            return;
        }
        String title = KikotoPrivacySettings.unlockLabels(activity)[0];
        authenticating = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            cancellation = new CancellationSignal();
            BiometricPrompt prompt = new BiometricPrompt.Builder(activity)
                .setTitle(title)
                .setAllowedAuthenticators(
                    BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL
                )
                .build();
            prompt.authenticate(cancellation, activity.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    finishAuthentication(true);
                }

                @Override
                public void onAuthenticationError(int errorCode, CharSequence message) {
                    finishAuthentication(false);
                }
            });
            return;
        }
        KeyguardManager keyguard = activity.getSystemService(KeyguardManager.class);
        Intent intent = keyguard == null ? null : keyguard.createConfirmDeviceCredentialIntent(title, null);
        if (intent == null) {
            authenticating = false;
            unlock();
            return;
        }
        try {
            credentialLauncher.launch(intent);
        } catch (ActivityNotFoundException error) {
            finishAuthentication(false);
        }
    }

    private void finishAuthentication(boolean success) {
        authenticating = false;
        cancellation = null;
        if (success) unlock();
        else promptDismissed = true;
    }

    private void showCover() {
        if (cover != null) return;
        float density = activity.getResources().getDisplayMetrics().density;
        LinearLayout layout = new LinearLayout(activity);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setBackgroundColor(ContextCompat.getColor(activity, R.color.ic_launcher_background));
        // Touches stop here instead of reaching the page underneath.
        layout.setClickable(true);
        layout.setFocusable(true);

        ImageView icon = new ImageView(activity);
        icon.setImageResource(R.mipmap.ic_launcher_foreground);
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        int size = Math.round(160 * density);
        layout.addView(icon, new LinearLayout.LayoutParams(size, size));

        Button unlockButton = new Button(activity);
        unlockButton.setText(KikotoPrivacySettings.unlockLabels(activity)[1]);
        unlockButton.setOnClickListener(view -> {
            if (!authenticating) authenticate();
        });
        layout.addView(unlockButton, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        ((ViewGroup) activity.getWindow().getDecorView()).addView(
            layout,
            new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        );
        cover = layout;
    }

    private void hideCover() {
        View current = cover;
        cover = null;
        if (current == null || current.getParent() == null) return;
        ((ViewGroup) current.getParent()).removeView(current);
    }
}
