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
    private static final int HLS_SEGMENT_READ_TIMEOUT_MS = 120_000;
    private static final int MAX_REDIRECTS = 3;
    private static final long UNKNOWN_LENGTH = -1L;
    private static final Pattern CONTENT_RANGE_PATTERN = Pattern.compile(
        "^bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)$",
        Pattern.CASE_INSENSITIVE
    );
    private static final Pattern REQUESTED_RANGE_START_PATTERN = Pattern.compile(
        "^bytes\\s*=\\s*(\\d+)-.*$",
        Pattern.CASE_INSENSITIVE
    );
    private static final AtomicReference<KikotoAssetRequestPolicy> POLICY = new AtomicReference<>();
    private static final Set<String> BLOCKED_REQUEST_HEADERS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "accept-encoding",
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
        "content-length",
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
                return response(connection, requestMethod, status, requestHeaders);
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
        connection.setReadTimeout(policy.isHLSSegment(uri) ? HLS_SEGMENT_READ_TIMEOUT_MS : READ_TIMEOUT_MS);
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
        // Media ranges must describe the bytes exposed by the response stream.
        // Do not let transparent HTTP compression change that byte coordinate.
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("X-Kikoto-Mobile", "1");
        String authorization = policy.authorizationHeader();
        if (!authorization.isEmpty()) connection.setRequestProperty("Authorization", authorization);
        return connection;
    }

    private static Response response(
        HttpURLConnection connection,
        String method,
        int status,
        Map<String, String> requestHeaders
    ) throws IOException {
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
        ContentRange contentRange = status == HttpURLConnection.HTTP_PARTIAL ? parseContentRange(headers) : null;
        if (status == HttpURLConnection.HTTP_PARTIAL && contentRange == null) {
            throw new IOException("Mobile asset response has an invalid Content-Range.");
        }
        Long requestedRangeStart = requestedRangeStart(requestHeaders);
        if (contentRange != null && requestedRangeStart != null && contentRange.start != requestedRangeStart) {
            throw new IOException("Mobile asset response does not match the requested range.");
        }
        long declaredLength = connection.getContentLengthLong();
        long bodyLength = declaredLength;
        long logicalLength = declaredLength;
        long virtualRangePrefix = 0;
        if (contentRange != null) {
            bodyLength = contentRange.length();
            if (declaredLength >= 0 && declaredLength != bodyLength) {
                throw new IOException("Mobile asset response has inconsistent range length.");
            }
            virtualRangePrefix = contentRange.start;
            if (contentRange.total < 0) {
                throw new IOException("Mobile asset response has an unknown range length.");
            }
            logicalLength = contentRange.total;
        }
        InputStream responseBody = new WebViewRangeInputStream(
            input,
            virtualRangePrefix,
            bodyLength,
            logicalLength
        );
        return new Response(status, reason, headers, new DisconnectingInputStream(responseBody, connection));
    }

    private static Map<String, String> responseHeaders(HttpURLConnection connection) {
        Map<String, String> result = new LinkedHashMap<>();
        Map<String, List<String>> fields = connection.getHeaderFields();
        if (fields == null) return Collections.unmodifiableMap(result);
        for (Map.Entry<String, List<String>> entry : fields.entrySet()) {
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
        ContentRange range = parseContentRange(headers);
        return range == null ? 0 : range.start;
    }

    private static ContentRange parseContentRange(Map<String, String> headers) {
        String value = headerValue(headers, "content-range");
        if (value == null) return null;
        Matcher match = CONTENT_RANGE_PATTERN.matcher(value.trim());
        if (!match.matches()) return null;
        try {
            long start = Long.parseLong(match.group(1));
            long end = Long.parseLong(match.group(2));
            if (start > end || end - start == Long.MAX_VALUE) return null;
            long total = "*".equals(match.group(3)) ? UNKNOWN_LENGTH : Long.parseLong(match.group(3));
            if (total == 0 || (total >= 0 && end >= total)) return null;
            return new ContentRange(start, end, total);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static String headerValue(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey() != null && name.equalsIgnoreCase(entry.getKey())) return entry.getValue();
        }
        return null;
    }

    private static Long requestedRangeStart(Map<String, String> headers) {
        String value = headerValue(headers, "range");
        if (value == null) return null;
        Matcher match = REQUESTED_RANGE_START_PATTERN.matcher(value.trim());
        if (!match.matches()) return null;
        try {
            return Long.parseLong(match.group(1));
        } catch (NumberFormatException ignored) {
            return null;
        }
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

    private static final class ContentRange {
        private final long start;
        private final long end;
        private final long total;

        ContentRange(long start, long end, long total) {
            this.start = start;
            this.end = end;
            this.total = total;
        }

        long length() {
            return end - start + 1;
        }
    }

    static final class WebViewRangeInputStream extends FilterInputStream {
        private long virtualPrefixRemaining;
        private long bodyRemaining;
        private final long logicalLength;

        WebViewRangeInputStream(
            InputStream input,
            long virtualPrefixLength,
            long bodyLength,
            long logicalLength
        ) {
            super(input);
            this.virtualPrefixRemaining = Math.max(0, virtualPrefixLength);
            this.bodyRemaining = bodyLength < 0 ? UNKNOWN_LENGTH : bodyLength;
            this.logicalLength = logicalLength < 0 ? UNKNOWN_LENGTH : logicalLength;
        }

        @Override
        public int available() throws IOException {
            // Chromium's Android stream loader uses available() as the logical
            // resource size while it verifies a requested Range. A regular
            // network InputStream only reports immediately readable bytes, so
            // use the HTTP-declared size whenever it is known.
            if (logicalLength >= 0) return asAvailable(logicalLength);
            // Returning the underlying network stream's value would make
            // Chromium treat the currently buffered bytes as the file size.
            return 0;
        }

        @Override
        public int read() throws IOException {
            if (bodyRemaining == 0) return -1;
            int value = super.read();
            if (value < 0) {
                bodyRemaining = 0;
                return -1;
            }
            decrementBody(1);
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (length == 0) return 0;
            if (bodyRemaining == 0) return -1;
            int requested = length;
            if (bodyRemaining > 0) requested = (int) Math.min((long) length, bodyRemaining);
            int count = super.read(buffer, offset, requested);
            if (count < 0) {
                bodyRemaining = 0;
                return -1;
            }
            decrementBody(count);
            return count;
        }

        @Override
        public long skip(long count) throws IOException {
            if (count <= 0) return 0;

            // WebView seeks the Range offset inside WebResourceResponse even though
            // the upstream 206 body already starts at that offset.
            long virtualSkipped = Math.min(count, virtualPrefixRemaining);
            virtualPrefixRemaining -= virtualSkipped;
            if (virtualSkipped == count) return virtualSkipped;
            long remaining = count - virtualSkipped;
            if (bodyRemaining == 0) return virtualSkipped;
            if (bodyRemaining > 0) remaining = Math.min(remaining, bodyRemaining);
            long skipped = super.skip(remaining);
            if (skipped == 0 && remaining > 0) {
                int value = super.read();
                if (value >= 0) skipped = 1;
                else bodyRemaining = 0;
            }
            decrementBody(skipped);
            return virtualSkipped + skipped;
        }

        private void decrementBody(long count) {
            if (bodyRemaining > 0) bodyRemaining = Math.max(0, bodyRemaining - count);
        }

        private static int asAvailable(long length) {
            return length >= Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) length;
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
