package com.yexca.kikoto;

import android.app.Activity;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "KikotoAssetTransport")
public class KikotoAssetTransportPlugin extends Plugin {
    private String configuredServer = "";
    private String configuredSession = "";

    @PluginMethod
    public void configure(PluginCall call) {
        String serverUrl = call.getString("serverUrl", "");
        String sessionToken = call.getString("sessionToken", "");
        try {
            KikotoAssetTransport.configure(serverUrl, sessionToken);
        } catch (IllegalArgumentException error) {
            call.reject("Invalid mobile server configuration.");
            return;
        }
        sessionChanged(serverUrl, sessionToken);
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        KikotoAssetTransport.clear();
        sessionChanged("", "");
        call.resolve();
    }

    /** Signing out or switching servers drops cached responses from the previous session. */
    private synchronized void sessionChanged(String serverUrl, String sessionToken) {
        boolean clearCache = KikotoPrivacyPolicy.sessionChangeClearsWebCache(
            configuredServer,
            configuredSession,
            serverUrl,
            sessionToken
        );
        configuredServer = serverUrl;
        configuredSession = sessionToken;
        Activity activity = getActivity();
        if (!clearCache || activity == null) return;
        activity.runOnUiThread(() -> {
            WebView webView = getBridge().getWebView();
            if (webView != null) webView.clearCache(true);
        });
    }
}
