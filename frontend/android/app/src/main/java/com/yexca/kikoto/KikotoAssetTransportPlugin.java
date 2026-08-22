package com.yexca.kikoto;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "KikotoAssetTransport")
public class KikotoAssetTransportPlugin extends Plugin {
    @PluginMethod
    public void configure(PluginCall call) {
        try {
            KikotoAssetTransport.configure(call.getString("serverUrl", ""), call.getString("sessionToken", ""));
            call.resolve();
        } catch (IllegalArgumentException error) {
            call.reject("Invalid mobile server configuration.");
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        KikotoAssetTransport.clear();
        call.resolve();
    }
}
