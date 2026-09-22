package com.yexca.kikoto;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Floating lyrics shown above other apps. The WebView sends the full timed
 * lyric list once per track plus playback corrections; the overlay advances
 * lines on its own clock so it keeps working while the WebView is throttled.
 */
final class KikotoLyricsOverlay {
    interface CloseListener {
        void onClosed();
    }

    private static final long TICK_MS = 200L;

    private final Context context;
    private final WindowManager windowManager;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final CloseListener closeListener;

    private FrameLayout root;
    private TextView currentView;
    private TextView nextView;
    private WindowManager.LayoutParams params;

    private long[] times = new long[0];
    private String[] texts = new String[0];
    private String title = "";
    private long basePositionMs = 0L;
    private long baseRealtimeMs = 0L;
    private boolean playing = false;
    private float playbackRate = 1.0F;
    private int shownIndex = Integer.MIN_VALUE;
    private boolean requested = false;
    private boolean appForeground = true;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            render();
            if (root != null && playing) handler.postDelayed(this, TICK_MS);
        }
    };

    KikotoLyricsOverlay(Context context, CloseListener closeListener) {
        this.context = context.getApplicationContext();
        this.windowManager = (WindowManager) this.context.getSystemService(Context.WINDOW_SERVICE);
        this.closeListener = closeListener;
    }

    boolean isSupported() {
        return windowManager != null;
    }

    boolean hasPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context);
    }

    void show(String title, long[] times, String[] texts, long positionMs, boolean playing, float rate) {
        this.title = title == null ? "" : title;
        this.times = times;
        this.texts = texts;
        this.shownIndex = Integer.MIN_VALUE;
        this.requested = true;
        updatePlayback(positionMs, playing, rate);
        syncVisibility();
    }

    void updatePlayback(long positionMs, boolean playing, float rate) {
        this.basePositionMs = Math.max(0L, positionMs);
        this.baseRealtimeMs = SystemClock.elapsedRealtime();
        this.playing = playing;
        this.playbackRate = rate > 0 ? rate : 1.0F;
        handler.removeCallbacks(tick);
        if (root != null) handler.post(tick);
    }

    void hide() {
        requested = false;
        detach();
    }

    /** Floating lyrics only appear while the user is outside Kikoto. */
    void setAppForeground(boolean foreground) {
        appForeground = foreground;
        syncVisibility();
    }

    private void syncVisibility() {
        if (requested && !appForeground && hasPermission()) attach();
        else detach();
    }

    @SuppressLint("ClickableViewAccessibility")
    private void attach() {
        if (root != null || windowManager == null) return;
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setGravity(Gravity.CENTER_HORIZONTAL);
        int padH = dp(18);
        int padV = dp(10);
        column.setPadding(padH, padV, padH, padV);
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.argb(200, 20, 18, 16));
        background.setCornerRadius(dp(16));
        column.setBackground(background);

        currentView = new TextView(context);
        currentView.setTextColor(Color.WHITE);
        currentView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        currentView.setGravity(Gravity.CENTER);
        currentView.setMaxLines(2);
        currentView.setEllipsize(TextUtils.TruncateAt.END);
        currentView.setShadowLayer(dp(2), 0, dp(1), Color.argb(160, 0, 0, 0));
        column.addView(currentView, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        nextView = new TextView(context);
        nextView.setTextColor(Color.argb(170, 255, 255, 255));
        nextView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        nextView.setGravity(Gravity.CENTER);
        nextView.setSingleLine(true);
        nextView.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams nextParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        nextParams.topMargin = dp(2);
        column.addView(nextView, nextParams);

        root = new FrameLayout(context);
        FrameLayout.LayoutParams columnParams = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        root.addView(column, columnParams);

        TextView close = new TextView(context);
        close.setText("×");
        close.setTextColor(Color.argb(200, 255, 255, 255));
        close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        close.setGravity(Gravity.CENTER);
        close.setContentDescription("Close lyrics");
        FrameLayout.LayoutParams closeParams = new FrameLayout.LayoutParams(dp(32), dp(32), Gravity.END | Gravity.TOP);
        root.addView(close, closeParams);
        close.setOnClickListener(view -> {
            hide();
            if (closeListener != null) closeListener.onClosed();
        });

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            : WindowManager.LayoutParams.TYPE_PHONE;
        int width = Math.min(context.getResources().getDisplayMetrics().widthPixels - dp(24), dp(420));
        params = new WindowManager.LayoutParams(
            width,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        );
        // Open centered on screen; dragging moves the overlay vertically from there.
        params.gravity = Gravity.CENTER;
        params.y = 0;

        root.setOnTouchListener(new View.OnTouchListener() {
            private float startRawY;
            private int startY;

            @Override
            public boolean onTouch(View view, MotionEvent event) {
                if (params == null) return false;
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        startRawY = event.getRawY();
                        startY = params.y;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int limit = Math.max(
                            0,
                            (context.getResources().getDisplayMetrics().heightPixels - view.getHeight()) / 2
                        );
                        int nextY = startY + Math.round(event.getRawY() - startRawY);
                        params.y = Math.max(-limit, Math.min(limit, nextY));
                        try {
                            windowManager.updateViewLayout(root, params);
                        } catch (IllegalArgumentException ignored) {
                        }
                        return true;
                    default:
                        return false;
                }
            }
        });

        try {
            windowManager.addView(root, params);
        } catch (RuntimeException error) {
            root = null;
            return;
        }
        shownIndex = Integer.MIN_VALUE;
        handler.removeCallbacks(tick);
        handler.post(tick);
    }

    private void detach() {
        handler.removeCallbacks(tick);
        if (root == null || windowManager == null) return;
        try {
            windowManager.removeView(root);
        } catch (IllegalArgumentException ignored) {
        }
        root = null;
        currentView = null;
        nextView = null;
    }

    private void render() {
        if (currentView == null || nextView == null) return;
        long position = basePositionMs;
        if (playing) {
            position += (long) ((SystemClock.elapsedRealtime() - baseRealtimeMs) * playbackRate);
        }
        int index = activeIndex(position + 150L);
        if (index == shownIndex) return;
        shownIndex = index;
        String current = index >= 0 && index < texts.length ? texts[index] : "";
        String next = "";
        for (int i = index + 1; i < texts.length; i++) {
            if (texts[i] != null && !texts[i].trim().isEmpty()) {
                next = texts[i];
                break;
            }
        }
        currentView.setText(current == null || current.trim().isEmpty() ? title : current);
        nextView.setText(next);
        nextView.setVisibility(next.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private int activeIndex(long positionMs) {
        int low = 0;
        int high = times.length - 1;
        int found = times.length > 0 ? 0 : -1;
        while (low <= high) {
            int mid = (low + high) >>> 1;
            if (times[mid] <= positionMs) {
                found = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return found;
    }

    private int dp(float value) {
        return Math.round(TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, context.getResources().getDisplayMetrics()));
    }
}
