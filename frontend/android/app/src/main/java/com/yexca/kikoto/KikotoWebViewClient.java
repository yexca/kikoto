package com.yexca.kikoto;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Collections;
import java.util.Locale;
import java.util.Map;

final class KikotoWebViewClient extends BridgeWebViewClient {
    KikotoWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        String url = request.getUrl().toString();
        String method = request.getMethod();
        if (!KikotoAssetTransport.canHandle(url, method)) return super.shouldInterceptRequest(view, request);
        KikotoAssetTransport.Response response = null;
        try {
            response = KikotoAssetTransport.open(url, method, request.getRequestHeaders());
            ContentType contentType = contentType(response.headers());
            return new WebResourceResponse(
                contentType.mimeType,
                contentType.encoding,
                response.status(),
                response.reason(),
                response.headers(),
                response.body()
            );
        } catch (IOException | RuntimeException ignored) {
            if (response != null) {
                try {
                    response.close();
                } catch (IOException closeError) {
                    // The original request failure is the useful result for the WebView.
                }
            }
            return new WebResourceResponse(
                "text/plain",
                "UTF-8",
                502,
                "Bad Gateway",
                Collections.emptyMap(),
                new ByteArrayInputStream(new byte[0])
            );
        }
    }

    private static ContentType contentType(Map<String, String> headers) {
        String value = "";
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if ("content-type".equals(entry.getKey().toLowerCase(Locale.ROOT))) {
                value = entry.getValue();
                break;
            }
        }
        String[] parts = value.split(";");
        String mimeType = parts.length > 0 && !parts[0].trim().isEmpty()
            ? parts[0].trim()
            : "application/octet-stream";
        String encoding = null;
        for (int index = 1; index < parts.length; index++) {
            String part = parts[index].trim();
            if (!part.toLowerCase(Locale.ROOT).startsWith("charset=")) continue;
            encoding = part.substring("charset=".length()).trim().replace("\"", "");
            break;
        }
        return new ContentType(mimeType, encoding);
    }

    private static final class ContentType {
        private final String mimeType;
        private final String encoding;

        ContentType(String mimeType, String encoding) {
            this.mimeType = mimeType;
            this.encoding = encoding;
        }
    }
}
