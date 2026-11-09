package com.yexca.kikoto;

import androidx.activity.EdgeToEdge;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private KikotoVideoFullscreen videoFullscreen;

    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(KikotoMediaPlugin.class);
        registerPlugin(KikotoAssetTransportPlugin.class);
        registerPlugin(KikotoPersonalDataPlugin.class);
        registerPlugin(KikotoPrivacyPlugin.class);
        registerPlugin(KikotoVideoFullscreenPlugin.class);
        SplashScreen.installSplashScreen(this);
        // Every Android version draws under the system bars, as Android 15 and later always do.
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new KikotoWebViewClient(bridge));
        KikotoSystemInsets.install(this, bridge);
        videoFullscreen = new KikotoVideoFullscreen(this);
        bridge.getWebView().setWebChromeClient(new KikotoWebChromeClient(bridge, videoFullscreen));
    }

    /** The fullscreen view of the WebView, once the bridge is created. */
    KikotoVideoFullscreen videoFullscreen() {
        return videoFullscreen;
    }
}
