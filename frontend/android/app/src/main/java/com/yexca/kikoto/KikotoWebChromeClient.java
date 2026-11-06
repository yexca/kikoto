package com.yexca.kikoto;

import android.view.View;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/** The bridge's chrome client, with WebView fullscreen shown by {@link KikotoVideoFullscreen}. */
final class KikotoWebChromeClient extends BridgeWebChromeClient {
    private final KikotoVideoFullscreen fullscreen;

    KikotoWebChromeClient(Bridge bridge, KikotoVideoFullscreen fullscreen) {
        super(bridge);
        this.fullscreen = fullscreen;
    }

    @Override
    public void onShowCustomView(View view, CustomViewCallback callback) {
        fullscreen.show(view, callback);
    }

    @Override
    public void onHideCustomView() {
        fullscreen.hide();
    }
}
