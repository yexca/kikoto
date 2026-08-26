package com.yexca.kikoto;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.net.URI;

import org.junit.Test;

public class KikotoAssetRequestPolicyTest {
    private final KikotoAssetRequestPolicy policy = new KikotoAssetRequestPolicy(
        "https://server.example.invalid:8443/kikoto",
        "synthetic-token"
    );

    @Test
    public void allowsOnlyDeclaredResourceRoutesAndReadMethods() {
        assertTrue(policy.allows("https://server.example.invalid:8443/kikoto/api/assets/covers/example.jpg?v=1", "GET"));
        assertTrue(policy.allows("https://server.example.invalid:8443/kikoto/api/assets/manual/example.png", "HEAD"));
        assertTrue(policy.allows("https://server.example.invalid:8443/kikoto/api/media/7/stream", "GET"));
        assertTrue(policy.allows("https://server.example.invalid:8443/kikoto/api/media/7/asset?v=1", "GET"));
        assertTrue(policy.allows("https://server.example.invalid:8443/kikoto/api/media/7/text", "GET"));
        assertTrue(policy.allows("https://server.example.invalid:8443/kikoto/api/media/7/download", "GET"));
        assertTrue(policy.allows("https://server.example.invalid:8443/kikoto/api/media/7/hls/index.m3u8?v=revision", "GET"));
        assertTrue(policy.allows("https://server.example.invalid:8443/kikoto/api/media/7/hls/segment-000042.ts?v=revision", "GET"));

        assertFalse(policy.allows("https://server.example.invalid:8443/kikoto/api/works", "GET"));
        assertFalse(policy.allows("https://server.example.invalid:8443/kikoto/api/media/7/stream", "POST"));
        assertFalse(policy.allows("https://server.example.invalid:8443/kikoto/api/media/0/stream", "GET"));
        assertFalse(policy.allows("https://server.example.invalid:8443/kikoto/api/media/7/stream/extra", "GET"));
        assertFalse(policy.allows("https://server.example.invalid:8443/kikoto/api/media/7/hls/segment-42.ts", "GET"));
        assertFalse(policy.allows("https://server.example.invalid:8443/kikoto/api/media/7/hls/other.ts", "GET"));
        assertFalse(policy.allows("https://server.example.invalid:8443/kikoto/api/assets/manual/nested/example.png", "GET"));
    }

    @Test
    public void identifiesOnlyTranscodingSegmentRequests() throws Exception {
        assertTrue(policy.isHLSSegment(new URI("https://server.example.invalid:8443/kikoto/api/media/7/hls/segment-000042.ts?v=revision")));
        assertFalse(policy.isHLSSegment(new URI("https://server.example.invalid:8443/kikoto/api/media/7/hls/index.m3u8?v=revision")));
        assertFalse(policy.isHLSSegment(new URI("https://server.example.invalid:8443/kikoto/api/media/7/stream")));
    }

    @Test
    public void requiresTheExactConfiguredOriginAndBasePath() throws Exception {
        assertFalse(policy.allows("http://server.example.invalid:8443/kikoto/api/media/7/stream", "GET"));
        assertFalse(policy.allows("https://server.example.invalid/kikoto/api/media/7/stream", "GET"));
        assertFalse(policy.allows("https://other.example.invalid:8443/kikoto/api/media/7/stream", "GET"));
        assertFalse(policy.allows("https://server.example.invalid:8443/kikoto-other/api/media/7/stream", "GET"));
        assertFalse(policy.allows(urlWithUserInfo(8443, "/kikoto/api/media/7/stream"), "GET"));
    }

    @Test
    public void rejectsDecodedTraversalAndEncodedRouteEscapes() {
        assertFalse(policy.allows("https://server.example.invalid:8443/kikoto/api/assets/covers/../manual/example.png", "GET"));
        assertFalse(policy.allows("https://server.example.invalid:8443/kikoto/api/assets/manual/example%2Fnested.png", "GET"));
        assertFalse(policy.allows("https://server.example.invalid:8443/kikoto/api/assets/covers/%2e%2e/example.png", "GET"));
    }

    @Test
    public void permitsOnlySameBoundaryRedirects() throws Exception {
        URI current = new URI("https://server.example.invalid:8443/kikoto/api/media/7/stream");
        assertEquals(
            new URI("https://server.example.invalid:8443/kikoto/api/media/8/stream"),
            policy.resolveRedirect(current, "/kikoto/api/media/8/stream", "GET")
        );
        assertNull(policy.resolveRedirect(current, "https://other.example.invalid/api/media/8/stream", "GET"));
        assertNull(policy.resolveRedirect(current, "/kikoto/api/works", "GET"));
    }

    @Test
    public void rejectsInvalidConfigurationAndFormatsTheBearerCredential() {
        assertEquals("Bearer synthetic-token", policy.authorizationHeader());
        assertEquals("", new KikotoAssetRequestPolicy("http://server.example.invalid", "").authorizationHeader());
        assertThrows(
            IllegalArgumentException.class,
            () -> new KikotoAssetRequestPolicy("ftp://server.example.invalid", "synthetic-token")
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> new KikotoAssetRequestPolicy(urlWithUserInfo(-1, ""), "synthetic-token")
        );
    }

    private static String urlWithUserInfo(int port, String path) throws Exception {
        return new URI("https", "user", "server.example.invalid", port, path, null, null).toString();
    }
}
