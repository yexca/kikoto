package com.yexca.kikoto;

import android.app.Activity;
import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Device privacy settings, the recent apps cover, and whether media would
 * play from the phone speaker.
 */
@CapacitorPlugin(name = "KikotoPrivacy")
public class KikotoPrivacyPlugin extends Plugin {
    private AudioManager audioManager;
    private AudioDeviceCallback outputCallback;
    private boolean phoneSpeaker = true;
    private View recentsCover;

    @Override
    public void load() {
        applyRecentsShield(KikotoPrivacySettings.read(getContext()));
        audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (audioManager == null) return;
        phoneSpeaker = currentOutputIsPhoneSpeaker();
        outputCallback = new AudioDeviceCallback() {
            @Override
            public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                publishOutput();
            }

            @Override
            public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                publishOutput();
            }
        };
        audioManager.registerAudioDeviceCallback(outputCallback, new Handler(Looper.getMainLooper()));
    }

    @Override
    protected void handleOnDestroy() {
        if (audioManager != null && outputCallback != null) {
            audioManager.unregisterAudioDeviceCallback(outputCallback);
            outputCallback = null;
        }
        hideRecentsCover();
        super.handleOnDestroy();
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        // Android 13 and later leave the recent apps preview blank through
        // setRecentsScreenshotEnabled. Earlier versions capture the window as
        // it leaves the foreground, so cover it before that frame is drawn. A
        // split-screen or freeform window stays visible while paused.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return;
        Activity activity = getActivity();
        if (activity == null || activity.isInMultiWindowMode()) return;
        if (KikotoPrivacySettings.read(getContext()).recentsShield) showRecentsCover(activity);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        hideRecentsCover();
    }

    @PluginMethod
    public void getSettings(PluginCall call) {
        call.resolve(settingsResult(KikotoPrivacySettings.read(getContext())));
    }

    @PluginMethod
    public void setSettings(PluginCall call) {
        String lockScreenContent = call.getString("lockScreenContent");
        if (
            lockScreenContent != null &&
            !lockScreenContent.equals(KikotoPrivacyPolicy.normalizeLockScreenContent(lockScreenContent))
        ) {
            lockScreenContent = null;
        }
        KikotoPrivacySettings settings = KikotoPrivacySettings.update(
            getContext(),
            call.getBoolean("recentsShield"),
            lockScreenContent,
            call.getBoolean("speakerConfirm")
        );
        Activity activity = getActivity();
        if (activity != null) activity.runOnUiThread(() -> applyRecentsShield(settings));
        KikotoMediaService.refreshPrivacy(getContext());
        call.resolve(settingsResult(settings));
    }

    @PluginMethod
    public void outputStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("phoneSpeaker", currentOutputIsPhoneSpeaker());
        call.resolve(result);
    }

    private void publishOutput() {
        boolean next = currentOutputIsPhoneSpeaker();
        if (next == phoneSpeaker) return;
        phoneSpeaker = next;
        JSObject payload = new JSObject();
        payload.put("phoneSpeaker", next);
        notifyListeners("outputChanged", payload);
    }

    private boolean currentOutputIsPhoneSpeaker() {
        if (audioManager == null) return true;
        AudioDeviceInfo[] devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
        int[] types = new int[devices.length];
        for (int index = 0; index < devices.length; index++) types[index] = devices[index].getType();
        return KikotoPrivacyPolicy.routesMediaToPhoneSpeaker(types);
    }

    private void applyRecentsShield(KikotoPrivacySettings settings) {
        Activity activity = getActivity();
        if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        activity.setRecentsScreenshotEnabled(!settings.recentsShield);
    }

    private void showRecentsCover(Activity activity) {
        if (recentsCover != null) return;
        FrameLayout cover = new FrameLayout(activity);
        cover.setBackgroundColor(ContextCompat.getColor(activity, R.color.ic_launcher_background));
        ImageView icon = new ImageView(activity);
        icon.setImageResource(R.mipmap.ic_launcher_foreground);
        int size = Math.round(160 * activity.getResources().getDisplayMetrics().density);
        cover.addView(icon, new FrameLayout.LayoutParams(size, size, Gravity.CENTER));
        ((ViewGroup) activity.getWindow().getDecorView()).addView(
            cover,
            new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        );
        recentsCover = cover;
    }

    private void hideRecentsCover() {
        View cover = recentsCover;
        recentsCover = null;
        if (cover == null || cover.getParent() == null) return;
        ((ViewGroup) cover.getParent()).removeView(cover);
    }

    private static JSObject settingsResult(KikotoPrivacySettings settings) {
        JSObject result = new JSObject();
        result.put("recentsShield", settings.recentsShield);
        result.put("lockScreenContent", settings.lockScreenContent);
        result.put("speakerConfirm", settings.speakerConfirm);
        return result;
    }
}
