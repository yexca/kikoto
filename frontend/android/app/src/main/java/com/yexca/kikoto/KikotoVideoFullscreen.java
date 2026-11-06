package com.yexca.kikoto;

import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.widget.FrameLayout;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

/**
 * Shows the WebView's fullscreen element over the app content with the system
 * bars hidden, and turns the screen to landscape while the page asks for it.
 * The view goes into the content frame, so the app lock cover, which sits on
 * the decor view, stays above it. Back leaves fullscreen before it reaches the
 * web back order.
 */
final class KikotoVideoFullscreen {
    private final AppCompatActivity activity;
    private final OnBackPressedCallback back = new OnBackPressedCallback(false) {
        @Override
        public void handleOnBackPressed() {
            exit();
        }
    };
    private View view;
    private WebChromeClient.CustomViewCallback callback;
    private boolean landscapeRequested;
    private boolean orientationHeld;
    private int restoredOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;

    KikotoVideoFullscreen(AppCompatActivity activity) {
        this.activity = activity;
        // Registered after the bridge's own back handling, so it runs first while enabled.
        activity.getOnBackPressedDispatcher().addCallback(activity, back);
    }

    void show(View fullscreenView, WebChromeClient.CustomViewCallback fullscreenCallback) {
        if (view != null) {
            fullscreenCallback.onCustomViewHidden();
            return;
        }
        view = fullscreenView;
        callback = fullscreenCallback;
        fullscreenView.setBackgroundColor(Color.BLACK);
        ViewGroup content = activity.findViewById(android.R.id.content);
        content.addView(
            fullscreenView,
            new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        );
        WindowInsetsControllerCompat insets = insetsController();
        insets.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        insets.hide(WindowInsetsCompat.Type.systemBars());
        back.setEnabled(true);
        applyOrientation();
    }

    /** The WebView left fullscreen; puts the app back as it was. */
    void hide() {
        if (view == null) return;
        View current = view;
        view = null;
        callback = null;
        landscapeRequested = false;
        back.setEnabled(false);
        if (current.getParent() instanceof ViewGroup) ((ViewGroup) current.getParent()).removeView(current);
        insetsController().show(WindowInsetsCompat.Type.systemBars());
        applyOrientation();
    }

    /**
     * Asks for landscape until fullscreen ends or the page releases it. The page
     * may ask just before the WebView shows its fullscreen view.
     */
    void lockLandscape() {
        landscapeRequested = true;
        applyOrientation();
    }

    void unlockOrientation() {
        landscapeRequested = false;
        applyOrientation();
    }

    private void exit() {
        WebChromeClient.CustomViewCallback current = callback;
        hide();
        if (current != null) current.onCustomViewHidden();
    }

    private void applyOrientation() {
        boolean landscape = landscapeRequested && view != null;
        if (landscape && !orientationHeld) {
            restoredOrientation = activity.getRequestedOrientation();
            orientationHeld = true;
            activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        } else if (!landscape && orientationHeld) {
            orientationHeld = false;
            activity.setRequestedOrientation(restoredOrientation);
        }
    }

    private WindowInsetsControllerCompat insetsController() {
        return WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
    }
}
