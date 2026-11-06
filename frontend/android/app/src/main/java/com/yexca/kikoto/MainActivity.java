package com.yexca.kikoto;

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
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new KikotoWebViewClient(bridge));
        videoFullscreen = new KikotoVideoFullscreen(this);
        bridge.getWebView().setWebChromeClient(new KikotoWebChromeClient(bridge, videoFullscreen));
    }

    /** The fullscreen view of the WebView, once the bridge is created. */
    KikotoVideoFullscreen videoFullscreen() {
        return videoFullscreen;
    }
}
