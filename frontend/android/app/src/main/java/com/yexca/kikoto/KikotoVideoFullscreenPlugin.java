package com.yexca.kikoto;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.function.Consumer;

/** Lets the page turn a fullscreen video to landscape; the WebView rejects the Screen Orientation lock. */
@CapacitorPlugin(name = "KikotoVideoFullscreen")
public class KikotoVideoFullscreenPlugin extends Plugin {
    @PluginMethod
    public void lockLandscape(PluginCall call) {
        withFullscreen(call, KikotoVideoFullscreen::lockLandscape);
    }

    @PluginMethod
    public void unlockOrientation(PluginCall call) {
        withFullscreen(call, KikotoVideoFullscreen::unlockOrientation);
    }

    private void withFullscreen(PluginCall call, Consumer<KikotoVideoFullscreen> action) {
        if (!(getActivity() instanceof MainActivity)) {
            call.unavailable("Video fullscreen is unavailable.");
            return;
        }
        MainActivity activity = (MainActivity) getActivity();
        activity.runOnUiThread(() -> {
            KikotoVideoFullscreen fullscreen = activity.videoFullscreen();
            if (fullscreen == null) {
                call.unavailable("Video fullscreen is unavailable.");
                return;
            }
            action.accept(fullscreen);
            call.resolve();
        });
    }
}
