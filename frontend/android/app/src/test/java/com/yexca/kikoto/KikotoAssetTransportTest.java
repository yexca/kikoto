package com.yexca.kikoto;

import static org.junit.Assert.assertEquals;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
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
            assertEquals("cde", readBody(response));
        }

        assertEquals("bytes=2-", range.get());
        assertEquals("Bearer synthetic-token", authorization.get());
        assertEquals("1", mobileHeader.get());
        assertEquals(null, serverFailure.get());
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
                if ("x-kikoto-mobile".equals(name)) mobileHeader.set(value);
                if ("range".equals(name)) range.set(value);
            }
            byte[] body = "cde".getBytes(StandardCharsets.UTF_8);
            byte[] response = (
                "HTTP/1.1 206 Partial Content\r\n" +
                "Content-Type: audio/mpeg\r\n" +
                "Accept-Ranges: bytes\r\n" +
                "Content-Range: bytes 2-4/5\r\n" +
                "Content-Length: " + body.length + "\r\n" +
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
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16];
        int count;
        while ((count = response.body().read(buffer)) >= 0) {
            if (count > 0) output.write(buffer, 0, count);
        }
        return new String(output.toByteArray(), StandardCharsets.UTF_8);
    }
}
