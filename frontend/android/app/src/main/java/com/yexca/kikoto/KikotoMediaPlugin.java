package com.yexca.kikoto;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "KikotoMedia",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class KikotoMediaPlugin extends Plugin {
    private BroadcastReceiver controlReceiver;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private boolean hasAudioFocus = false;

    @Override
    public void load() {
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(controlReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(controlReceiver, filter);
        }
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
        super.handleOnDestroy();
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
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            resolveNotificationPermission(call, true);
            return;
        }
        if (getPermissionState("notifications") == com.getcapacitor.PermissionState.GRANTED) {
            resolveNotificationPermission(call, true);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        resolveNotificationPermission(call, getPermissionState("notifications") == com.getcapacitor.PermissionState.GRANTED);
    }

    @PluginMethod
    public void abandonAudioFocus(PluginCall call) {
        abandonAudioFocusInternal();
        call.resolve();
    }

    private void resolveNotificationPermission(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
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
