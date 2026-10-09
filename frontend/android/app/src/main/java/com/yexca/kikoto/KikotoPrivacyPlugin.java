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
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Device privacy settings, the recent apps cover, screen capture protection,
 * the app lock, and whether media would play from the phone speaker.
 */
@CapacitorPlugin(name = "KikotoPrivacy")
public class KikotoPrivacyPlugin extends Plugin {
    private AudioManager audioManager;
    private AudioDeviceCallback outputCallback;
    private boolean phoneSpeaker = true;
    private View recentsCover;
    private KikotoAppLock appLock;

    @Override
    public void load() {
        KikotoPrivacySettings settings = KikotoPrivacySettings.read(getContext());
        applyRecentsShield(settings);
        applyScreenSecure(settings);
        appLock = new KikotoAppLock(getActivity(), getBridge().getWebView());
        appLock.onLaunch();
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
        if (appLock != null) appLock.onDestroy();
        super.handleOnDestroy();
    }

    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        if (appLock != null) appLock.onStart();
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        if (appLock != null) appLock.onStop();
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
        if (appLock != null) appLock.onResume();
    }

    @PluginMethod
    public void getSettings(PluginCall call) {
        call.resolve(settingsResult(KikotoPrivacySettings.read(getContext())));
    }

    @PluginMethod
    public void setSettings(PluginCall call) {
        KikotoPrivacySettings.Change change = new KikotoPrivacySettings.Change();
        change.recentsShield = call.getBoolean("recentsShield");
        change.speakerConfirm = call.getBoolean("speakerConfirm");
        change.screenSecure = call.getBoolean("screenSecure");
        change.appLock = call.getBoolean("appLock");
        // Unknown values keep the current choice.
        String lockScreenContent = call.getString("lockScreenContent");
        if (
            lockScreenContent != null &&
            lockScreenContent.equals(KikotoPrivacyPolicy.normalizeLockScreenContent(lockScreenContent))
        ) {
            change.lockScreenContent = lockScreenContent;
        }
        Integer timeout = call.getInt("appLockTimeoutSeconds");
        if (timeout != null && timeout == KikotoPrivacyPolicy.normalizeAppLockTimeoutSeconds(timeout)) {
            change.appLockTimeoutSeconds = timeout;
        }
        KikotoPrivacySettings settings = KikotoPrivacySettings.update(getContext(), change);
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> {
                applyRecentsShield(settings);
                applyScreenSecure(settings);
                if (appLock != null) appLock.settingsChanged(settings);
            });
        }
        KikotoMediaService.refreshPrivacy(getContext());
        call.resolve(settingsResult(settings));
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        result.put("appLockSupported", true);
        result.put("appLockAvailable", appLock != null && appLock.deviceSecure());
        call.resolve(result);
    }

    @PluginMethod
    public void setUnlockLabels(PluginCall call) {
        KikotoPrivacySettings.storeUnlockLabels(getContext(), call.getString("title"), call.getString("action"));
        call.resolve();
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

    /** Blocks screenshots, screen recording, and casting of the app window; floating lyrics follow it when attached. */
    private void applyScreenSecure(KikotoPrivacySettings settings) {
        Activity activity = getActivity();
        if (activity == null) return;
        if (settings.screenSecure) activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
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
        result.put("screenSecure", settings.screenSecure);
        result.put("appLock", settings.appLock);
        result.put("appLockTimeoutSeconds", settings.appLockTimeoutSeconds);
        return result;
    }
}
