package com.yexca.kikoto;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLConnection;
import java.util.Collections;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class KikotoAssetTransport {
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final int MAX_REDIRECTS = 3;
    private static final Pattern CONTENT_RANGE_PATTERN = Pattern.compile(
        "^bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)$",
        Pattern.CASE_INSENSITIVE
    );
    private static final AtomicReference<KikotoAssetRequestPolicy> POLICY = new AtomicReference<>();
    private static final Set<String> BLOCKED_REQUEST_HEADERS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "authorization",
        "connection",
        "content-length",
        "cookie",
        "host",
        "keep-alive",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "x-kikoto-mobile"
    )));
    private static final Set<String> BLOCKED_RESPONSE_HEADERS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "set-cookie",
        "set-cookie2",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade"
    )));

    private KikotoAssetTransport() {}

    static void configure(String serverUrl, String sessionToken) {
        POLICY.set(new KikotoAssetRequestPolicy(serverUrl, sessionToken));
    }

    static void clear() {
        POLICY.set(null);
    }

    static boolean canHandle(String url, String method) {
        KikotoAssetRequestPolicy policy = POLICY.get();
        return policy != null && policy.allows(url, method);
    }

    static Response open(String url, String method, Map<String, String> requestHeaders) throws IOException {
        KikotoAssetRequestPolicy policy = POLICY.get();
        if (policy == null) throw new IOException("Mobile asset transport is not configured.");
        String requestMethod = method == null ? "" : method.toUpperCase(Locale.ROOT);
        URI current;
        try {
            current = URI.create(url);
        } catch (IllegalArgumentException error) {
            throw new IOException("Invalid mobile asset URL.", error);
        }
        if (!policy.allows(current, requestMethod)) throw new IOException("Mobile asset URL is outside the configured server.");

        int redirects = 0;
        while (true) {
            HttpURLConnection connection = openConnection(current, requestMethod, requestHeaders, policy);
            try {
                int status = connection.getResponseCode();
                String location = connection.getHeaderField("Location");
                if (isRedirect(status) && location != null) {
                    if (redirects >= MAX_REDIRECTS) throw new IOException("Too many mobile asset redirects.");
                    URI next = policy.resolveRedirect(current, location, requestMethod);
                    if (next == null) throw new IOException("Mobile asset redirect left the configured server.");
                    redirects++;
                    connection.disconnect();
                    current = next;
                    continue;
                }
                return response(connection, requestMethod, status);
            } catch (IOException | RuntimeException error) {
                connection.disconnect();
                throw error;
            }
        }
    }

    private static HttpURLConnection openConnection(
        URI uri,
        String method,
        Map<String, String> requestHeaders,
        KikotoAssetRequestPolicy policy
    ) throws IOException {
        URLConnection rawConnection = uri.toURL().openConnection();
        if (!(rawConnection instanceof HttpURLConnection)) throw new IOException("Unsupported mobile asset protocol.");
        HttpURLConnection connection = (HttpURLConnection) rawConnection;
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod(method);
        if (requestHeaders != null) {
            for (Map.Entry<String, String> entry : requestHeaders.entrySet()) {
                String name = entry.getKey();
                String value = entry.getValue();
                if (name == null || value == null || BLOCKED_REQUEST_HEADERS.contains(name.toLowerCase(Locale.ROOT))) {
                    continue;
                }
                connection.setRequestProperty(name, value);
            }
        }
        connection.setRequestProperty("X-Kikoto-Mobile", "1");
        String authorization = policy.authorizationHeader();
        if (!authorization.isEmpty()) connection.setRequestProperty("Authorization", authorization);
        return connection;
    }

    private static Response response(HttpURLConnection connection, String method, int status) throws IOException {
        Map<String, String> headers = responseHeaders(connection);
        String reason = "HTTP " + status;
        if ("HEAD".equals(method) || status == HttpURLConnection.HTTP_NO_CONTENT || status == HttpURLConnection.HTTP_NOT_MODIFIED) {
            connection.disconnect();
            return new Response(status, reason, headers, new ByteArrayInputStream(new byte[0]));
        }
        InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        if (input == null) {
            connection.disconnect();
            return new Response(status, reason, headers, new ByteArrayInputStream(new byte[0]));
        }
        long virtualRangePrefix = status == HttpURLConnection.HTTP_PARTIAL ? contentRangeStart(headers) : 0;
        InputStream responseBody = new WebViewRangeInputStream(input, virtualRangePrefix);
        return new Response(status, reason, headers, new DisconnectingInputStream(responseBody, connection));
    }

    private static Map<String, String> responseHeaders(HttpURLConnection connection) {
        Map<String, String> result = new LinkedHashMap<>();
        for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
            String name = entry.getKey();
            List<String> values = entry.getValue();
            if (
                name == null ||
                values == null ||
                values.isEmpty() ||
                BLOCKED_RESPONSE_HEADERS.contains(name.toLowerCase(Locale.ROOT))
            ) {
                continue;
            }
            result.put(name, joinHeaderValues(values));
        }
        return Collections.unmodifiableMap(result);
    }

    static long contentRangeStart(Map<String, String> headers) {
        if (headers == null) return 0;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey() == null || entry.getValue() == null || !"content-range".equalsIgnoreCase(entry.getKey())) {
                continue;
            }
            Matcher match = CONTENT_RANGE_PATTERN.matcher(entry.getValue().trim());
            if (!match.matches()) return 0;
            try {
                long start = Long.parseLong(match.group(1));
                long end = Long.parseLong(match.group(2));
                if (start > end) return 0;
                if (!"*".equals(match.group(3)) && end >= Long.parseLong(match.group(3))) return 0;
                return start;
            } catch (NumberFormatException ignored) {
                return 0;
            }
        }
        return 0;
    }

    private static String joinHeaderValues(List<String> values) {
        StringBuilder result = new StringBuilder();
        for (String value : values) {
            if (value == null) continue;
            if (result.length() > 0) result.append(", ");
            result.append(value);
        }
        return result.toString();
    }

    private static boolean isRedirect(int status) {
        return status == HttpURLConnection.HTTP_MOVED_PERM ||
            status == HttpURLConnection.HTTP_MOVED_TEMP ||
            status == HttpURLConnection.HTTP_SEE_OTHER ||
            status == 307 ||
            status == 308;
    }

    static final class Response implements AutoCloseable {
        private final int status;
        private final String reason;
        private final Map<String, String> headers;
        private final InputStream body;

        Response(int status, String reason, Map<String, String> headers, InputStream body) {
            this.status = status;
            this.reason = reason;
            this.headers = headers;
            this.body = body;
        }

        int status() {
            return status;
        }

        String reason() {
            return reason;
        }

        Map<String, String> headers() {
            return headers;
        }

        InputStream body() {
            return body;
        }

        @Override
        public void close() throws IOException {
            body.close();
        }
    }

    static final class WebViewRangeInputStream extends FilterInputStream {
        private long virtualPrefixRemaining;

        WebViewRangeInputStream(InputStream input, long virtualPrefixLength) {
            super(input);
            this.virtualPrefixRemaining = Math.max(0, virtualPrefixLength);
        }

        @Override
        public int available() throws IOException {
            int upstreamAvailable = super.available();
            if (virtualPrefixRemaining >= Integer.MAX_VALUE - upstreamAvailable) return Integer.MAX_VALUE;
            return (int) virtualPrefixRemaining + upstreamAvailable;
        }

        @Override
        public long skip(long count) throws IOException {
            if (count <= 0) return 0;

            // WebView seeks the Range offset inside WebResourceResponse even though
            // the upstream 206 body already starts at that offset.
            long virtualSkipped = Math.min(count, virtualPrefixRemaining);
            virtualPrefixRemaining -= virtualSkipped;
            if (virtualSkipped == count) return virtualSkipped;
            return virtualSkipped + super.skip(count - virtualSkipped);
        }
    }

    private static final class DisconnectingInputStream extends FilterInputStream {
        private final HttpURLConnection connection;
        private boolean closed;

        DisconnectingInputStream(InputStream input, HttpURLConnection connection) {
            super(input);
            this.connection = connection;
        }

        @Override
        public int read() throws IOException {
            try {
                int value = super.read();
                if (value < 0) close();
                return value;
            } catch (IOException error) {
                closeAfterFailure();
                throw error;
            }
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            try {
                int count = super.read(buffer, offset, length);
                if (count < 0) close();
                return count;
            } catch (IOException error) {
                closeAfterFailure();
                throw error;
            }
        }

        @Override
        public void close() throws IOException {
            if (closed) return;
            closed = true;
            try {
                super.close();
            } finally {
                connection.disconnect();
            }
        }

        private void closeAfterFailure() {
            try {
                close();
            } catch (IOException ignored) {
            }
        }
    }
}
