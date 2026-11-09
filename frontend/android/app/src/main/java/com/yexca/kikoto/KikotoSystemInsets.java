package com.yexca.kikoto;

import android.app.Activity;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.WebViewListener;

import java.util.Locale;

/**
 * Lets the page draw under the system bars and pad for them itself, exactly
 * once. The window never pads natively for a bar, so a WebView that also
 * reports the bar through env(safe-area-inset-*) cannot leave a second gap.
 * The sizes are also published as CSS variables for WebViews that do not
 * report them; the page takes the larger of the two.
 */
final class KikotoSystemInsets {
    private static final int BAR_TYPES = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();

    private String script = safeAreaScript(0, 0, 0, 0, false, 1f);

    private KikotoSystemInsets() {}

    static void install(Activity activity, Bridge bridge) {
        KikotoSystemInsets insets = new KikotoSystemInsets();
        View decor = activity.getWindow().getDecorView();
        float density = activity.getResources().getDisplayMetrics().density;
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(BAR_TYPES);
            boolean keyboardVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
            // An edge-to-edge window does not resize for the keyboard, so the page ends above it here.
            int keyboard = keyboardVisible ? windowInsets.getInsets(WindowInsetsCompat.Type.ime()).bottom : 0;
            view.setPadding(0, 0, 0, keyboard);
            insets.script = safeAreaScript(bars.top, bars.right, bars.bottom, bars.left, keyboardVisible, density);
            insets.publish(bridge.getWebView());
            // Returning CONSUMED would stop later inset changes from reaching the WebView.
            return new WindowInsetsCompat.Builder(windowInsets)
                .setInsets(BAR_TYPES, Insets.of(bars.left, bars.top, bars.right, keyboardVisible ? 0 : bars.bottom))
                .build();
        });
        // A reload starts without the variables, so each committed page receives them again.
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageCommitVisible(WebView view, String url) {
                insets.publish(view);
            }
        });
    }

    private void publish(WebView webView) {
        if (webView == null) return;
        String current = script;
        webView.post(() -> webView.evaluateJavascript(current, null));
    }

    /** Sets the page's native safe-area variables, in CSS pixels; an open keyboard already covers the bottom bar. */
    static String safeAreaScript(int topPx, int rightPx, int bottomPx, int leftPx, boolean keyboardVisible, float density) {
        return String.format(
            Locale.ROOT,
            "(function(){var s=document.documentElement.style;"
                + "s.setProperty('--native-safe-area-top','%dpx');"
                + "s.setProperty('--native-safe-area-right','%dpx');"
                + "s.setProperty('--native-safe-area-bottom','%dpx');"
                + "s.setProperty('--native-safe-area-left','%dpx');})();",
            cssPixels(topPx, density),
            cssPixels(rightPx, density),
            cssPixels(keyboardVisible ? 0 : bottomPx, density),
            cssPixels(leftPx, density)
        );
    }

    private static int cssPixels(int px, float density) {
        return density > 0 ? Math.round(px / density) : px;
    }
}
