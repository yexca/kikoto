package com.yexca.kikoto;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(KikotoMediaPlugin.class);
        registerPlugin(KikotoAssetTransportPlugin.class);
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new KikotoWebViewClient(bridge));
    }
}
