package com.yexca.kikoto;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

@CapacitorPlugin(name = "KikotoMedia")
public class KikotoMediaPlugin extends Plugin {
    private BroadcastReceiver controlReceiver;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private boolean hasAudioFocus = false;
    private KikotoLyricsOverlay lyricsOverlay;

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        lyricsOverlay = new KikotoLyricsOverlay(getContext(), () -> notifyListeners("lyricsOverlayClosed", new JSObject()));
        controlReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String command = intent.getStringExtra(KikotoMediaService.EXTRA_COMMAND);
                if (command == null || command.trim().isEmpty()) return;
                JSObject payload = new JSObject();
                payload.put("command", command);
                notifyListeners("mediaControl", payload);
            }
        };
        IntentFilter filter = new IntentFilter(KikotoMediaService.BROADCAST_CONTROL);
        ContextCompat.registerReceiver(getContext(), controlReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        if (controlReceiver != null) {
            try {
                getContext().unregisterReceiver(controlReceiver);
            } catch (IllegalArgumentException ignored) {
            }
            controlReceiver = null;
        }
        abandonAudioFocusInternal();
        if (lyricsOverlay != null) lyricsOverlay.hide();
        super.handleOnDestroy();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (lyricsOverlay != null) lyricsOverlay.setAppForeground(true);
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (lyricsOverlay != null) lyricsOverlay.setAppForeground(false);
    }

    @PluginMethod
    public void lyricsOverlayStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", lyricsOverlay != null && lyricsOverlay.isSupported());
        result.put("permitted", lyricsOverlay != null && lyricsOverlay.hasPermission());
        call.resolve(result);
    }

    @PluginMethod
    public void requestLyricsOverlayPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(getContext())) {
            Intent intent = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + getContext().getPackageName())
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(intent);
            } catch (RuntimeException ignored) {
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void showLyricsOverlay(PluginCall call) {
        JSArray lines = call.getArray("lines", new JSArray());
        int count = lines.length();
        long[] times = new long[count];
        String[] texts = new String[count];
        for (int index = 0; index < count; index++) {
            JSONObject line = lines.optJSONObject(index);
            times[index] = line == null ? 0L : line.optLong("timeMs", 0L);
            texts[index] = line == null ? "" : line.optString("text", "");
        }
        Double rate = call.getDouble("playbackRate", 1.0);
        lyricsOverlay.show(
            call.getString("title", ""),
            times,
            texts,
            call.getLong("positionMs", 0L),
            Boolean.TRUE.equals(call.getBoolean("playing", false)),
            rate == null ? 1.0F : rate.floatValue()
        );
        call.resolve();
    }

    @PluginMethod
    public void updateLyricsOverlay(PluginCall call) {
        Double rate = call.getDouble("playbackRate", 1.0);
        lyricsOverlay.updatePlayback(
            call.getLong("positionMs", 0L),
            Boolean.TRUE.equals(call.getBoolean("playing", false)),
            rate == null ? 1.0F : rate.floatValue()
        );
        call.resolve();
    }

    @PluginMethod
    public void hideLyricsOverlay(PluginCall call) {
        lyricsOverlay.hide();
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        Intent intent = new Intent(getContext(), KikotoMediaService.class);
        intent.setAction(KikotoMediaService.ACTION_UPDATE);
        intent.putExtra(KikotoMediaService.EXTRA_TITLE, call.getString("title", ""));
        intent.putExtra(KikotoMediaService.EXTRA_ARTIST, call.getString("artist", ""));
        intent.putExtra(KikotoMediaService.EXTRA_ALBUM, call.getString("album", ""));
        intent.putExtra(KikotoMediaService.EXTRA_COVER_URL, call.getString("coverUrl", ""));
        intent.putExtra(KikotoMediaService.EXTRA_PLAYING, call.getBoolean("playing", false));
        intent.putExtra(KikotoMediaService.EXTRA_POSITION_MS, call.getLong("positionMs", 0L));
        intent.putExtra(KikotoMediaService.EXTRA_DURATION_MS, call.getLong("durationMs", 0L));
        intent.putExtra(KikotoMediaService.EXTRA_PLAYBACK_RATE, call.getFloat("playbackRate", 1.0F));
        intent.putExtra(KikotoMediaService.EXTRA_CAN_PREVIOUS, call.getBoolean("canPrevious", false));
        intent.putExtra(KikotoMediaService.EXTRA_CAN_NEXT, call.getBoolean("canNext", false));
        intent.putExtra(
            KikotoMediaService.EXTRA_SEEK_BACKWARD_SECONDS,
            call.getInt("seekBackwardSeconds", 10)
        );
        intent.putExtra(
            KikotoMediaService.EXTRA_SEEK_FORWARD_SECONDS,
            call.getInt("seekForwardSeconds", 30)
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), KikotoMediaService.class);
        intent.setAction(KikotoMediaService.ACTION_STOP);
        getContext().startService(intent);
        abandonAudioFocusInternal();
        call.resolve();
    }

    @PluginMethod
    public void requestAudioFocus(PluginCall call) {
        boolean granted = requestAudioFocusInternal();
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void abandonAudioFocus(PluginCall call) {
        abandonAudioFocusInternal();
        call.resolve();
    }

    private boolean requestAudioFocusInternal() {
        if (audioManager == null) return false;
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest == null) {
                AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build();
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attributes)
                    .setOnAudioFocusChangeListener(this::handleAudioFocusChange)
                    .build();
            }
            result = audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            result = audioManager.requestAudioFocus(this::handleAudioFocusChange, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
        hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        return hasAudioFocus;
    }

    private void abandonAudioFocusInternal() {
        if (audioManager == null || !hasAudioFocus) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest);
        } else {
            audioManager.abandonAudioFocus(this::handleAudioFocusChange);
        }
        hasAudioFocus = false;
    }

    private void handleAudioFocusChange(int change) {
        JSObject payload = new JSObject();
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            payload.put("kind", "loss");
        } else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) {
            payload.put("kind", "duck");
        } else if (change == AudioManager.AUDIOFOCUS_GAIN) {
            payload.put("kind", "gain");
        } else {
            payload.put("kind", "unknown");
        }
        notifyListeners("audioFocus", payload);
    }
}
