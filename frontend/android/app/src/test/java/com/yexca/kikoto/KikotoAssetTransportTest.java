package com.yexca.kikoto;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class KikotoAssetTransportTest {
    private ServerSocket server;
    private Thread serverThread;
    private String serverUrl;
    private final AtomicReference<String> authorization = new AtomicReference<>();
    private final AtomicReference<String> mobileHeader = new AtomicReference<>();
    private final AtomicReference<String> range = new AtomicReference<>();
    private final AtomicReference<String> acceptEncoding = new AtomicReference<>();
    private final AtomicReference<String> responseContentRange = new AtomicReference<>("bytes 2-4/5");
    private final AtomicReference<Integer> responseContentLength = new AtomicReference<>(3);
    private final AtomicReference<Throwable> serverFailure = new AtomicReference<>();

    @Before
    public void startServer() throws Exception {
        server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        serverUrl = "http://127.0.0.1:" + server.getLocalPort() + "/kikoto";
        serverThread = new Thread(this::serveRange, "kikoto-asset-transport-test");
        serverThread.start();
        KikotoAssetTransport.configure(serverUrl, "synthetic-token");
    }

    @After
    public void stopServer() {
        KikotoAssetTransport.clear();
        if (server != null) {
            try {
                server.close();
            } catch (IOException ignored) {
            }
        }
        if (serverThread != null) {
            try {
                serverThread.join(1_000L);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
        }
    }

    @Test
    public void preservesRangeStreamingAndOverridesCallerCredentials() throws Exception {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Range", "bytes=2-");
        headers.put("Authorization", "Bearer untrusted-token");
        headers.put("Cookie", "untrusted-cookie=1");

        try (KikotoAssetTransport.Response response = KikotoAssetTransport.open(
            serverUrl + "/api/media/7/stream",
            "GET",
            headers
        )) {
            assertEquals(206, response.status());
            assertEquals("bytes 2-4/5", header(response.headers(), "Content-Range"));
            assertEquals("", header(response.headers(), "Content-Length"));
            assertEquals(5, response.body().available());
            assertEquals(2, response.body().skip(2));
            assertEquals("cde", readBody(response));
        }

        assertEquals("bytes=2-", range.get());
        assertEquals("identity", acceptEncoding.get());
        assertEquals("Bearer synthetic-token", authorization.get());
        assertEquals("1", mobileHeader.get());
        assertEquals(null, serverFailure.get());
    }

    @Test
    public void exposesPartialResponseOffsetAsVirtualPrefix() throws Exception {
        try (InputStream input = new KikotoAssetTransport.WebViewRangeInputStream(
            new ZeroAvailableInputStream("cde".getBytes(StandardCharsets.UTF_8)),
            2,
            3,
            5
        )) {
            assertEquals(5, input.available());
            assertEquals(2, input.skip(2));
            assertEquals(5, input.available());
            assertEquals("cde", readBody(input));
        }
    }

    @Test
    public void capsAvailableBytesForLargeRangeOffsets() throws Exception {
        try (InputStream input = new KikotoAssetTransport.WebViewRangeInputStream(
            new ByteArrayInputStream(new byte[] { 1 }),
            Long.MAX_VALUE,
            1,
            Long.MAX_VALUE
        )) {
            assertEquals(Integer.MAX_VALUE, input.available());
        }
    }

    @Test
    public void boundsReadsToTheDeclaredRangeBody() throws Exception {
        try (InputStream input = new KikotoAssetTransport.WebViewRangeInputStream(
            new ByteArrayInputStream("cdef".getBytes(StandardCharsets.UTF_8)),
            2,
            2,
            10
        )) {
            assertEquals(10, input.available());
            assertEquals("cd", readBody(input));
            assertEquals(-1, input.read());
        }
    }

    @Test
    public void trustsContentRangeWhenProxyLengthIsInconsistent() throws Exception {
        responseContentLength.set(2);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Range", "bytes=2-");

        try (KikotoAssetTransport.Response response = KikotoAssetTransport.open(
            serverUrl + "/api/media/7/stream", "GET", headers
        )) {
            assertEquals(206, response.status());
            assertEquals("cde", readBody(response));
        }
    }

    @Test
    public void infersLogicalLengthWhenPartialResponseOmitsTotal() throws Exception {
        responseContentRange.set("bytes 2-4/*");
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Range", "bytes=2-");

        try (KikotoAssetTransport.Response response = KikotoAssetTransport.open(
            serverUrl + "/api/media/7/stream", "GET", headers
        )) {
            assertEquals(5, response.body().available());
            assertEquals("cde", readBody(response));
        }
    }

    @Test
    public void leavesLogicalLengthUnknownForBoundedRangeWithoutTotal() throws Exception {
        responseContentRange.set("bytes 2-4/*");
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Range", "bytes=2-4");

        try (KikotoAssetTransport.Response response = KikotoAssetTransport.open(
            serverUrl + "/api/media/7/stream", "GET", headers
        )) {
            assertEquals(0, response.body().available());
            assertEquals("cde", readBody(response));
        }
    }

    @Test
    public void rejectsPartialResponseForAnotherRange() {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Range", "bytes=1-");

        assertThrows(
            IOException.class,
            () -> KikotoAssetTransport.open(serverUrl + "/api/media/7/stream", "GET", headers)
        );
    }

    @Test
    public void validatesContentRangeBeforeMappingItsOffset() {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("content-range", "bytes 1867776-1898556/1898557");
        assertEquals(1_867_776L, KikotoAssetTransport.contentRangeStart(headers));

        headers.put("content-range", "bytes */1898557");
        assertEquals(0L, KikotoAssetTransport.contentRangeStart(headers));

        headers.put("content-range", "bytes 9-2/10");
        assertEquals(0L, KikotoAssetTransport.contentRangeStart(headers));

        headers.put("content-range", "bytes 2-10/10");
        assertEquals(0L, KikotoAssetTransport.contentRangeStart(headers));

        headers.put("content-range", "bytes 2 - 4 / *");
        assertEquals(2L, KikotoAssetTransport.contentRangeStart(headers));
    }

    private void serveRange() {
        try (
            Socket socket = server.accept();
            BufferedReader reader = new BufferedReader(
                new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII)
            )
        ) {
            reader.readLine();
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                int separator = line.indexOf(':');
                if (separator <= 0) continue;
                String name = line.substring(0, separator).trim().toLowerCase(Locale.ROOT);
                String value = line.substring(separator + 1).trim();
                if ("authorization".equals(name)) authorization.set(value);
                if ("accept-encoding".equals(name)) acceptEncoding.set(value);
                if ("x-kikoto-mobile".equals(name)) mobileHeader.set(value);
                if ("range".equals(name)) range.set(value);
            }
            byte[] body = "cde".getBytes(StandardCharsets.UTF_8);
            byte[] response = (
                "HTTP/1.1 206 Partial Content\r\n" +
                "Content-Type: audio/mpeg\r\n" +
                "Accept-Ranges: bytes\r\n" +
                "Content-Range: " + responseContentRange.get() + "\r\n" +
                "Content-Length: " + responseContentLength.get() + "\r\n" +
                "Connection: close\r\n\r\n"
            ).getBytes(StandardCharsets.US_ASCII);
            OutputStream output = socket.getOutputStream();
            output.write(response);
            output.write(body);
            output.flush();
        } catch (IOException error) {
            if (!server.isClosed()) serverFailure.set(error);
        }
    }

    private static String header(Map<String, String> headers, String name) {
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (name.toLowerCase(Locale.ROOT).equals(entry.getKey().toLowerCase(Locale.ROOT))) return entry.getValue();
        }
        return "";
    }

    private static String readBody(KikotoAssetTransport.Response response) throws IOException {
        return readBody(response.body());
    }

    private static String readBody(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16];
        int count;
        while ((count = input.read(buffer)) >= 0) {
            if (count > 0) output.write(buffer, 0, count);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }

    private static final class ZeroAvailableInputStream extends ByteArrayInputStream {
        ZeroAvailableInputStream(byte[] data) {
            super(data);
        }

        @Override
        public int available() {
            return 0;
        }
    }
}
