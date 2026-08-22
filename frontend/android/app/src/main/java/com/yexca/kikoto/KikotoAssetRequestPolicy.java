package com.yexca.kikoto;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.regex.Pattern;

final class KikotoAssetRequestPolicy {
    private static final String COVER_PREFIX = "/api/assets/covers/";
    private static final String MANUAL_PREFIX = "/api/assets/manual/";
    private static final Pattern MEDIA_PATH = Pattern.compile(
        "^/api/media/[1-9][0-9]*/(?:stream|asset|text|download)$"
    );

    private final String scheme;
    private final String host;
    private final int port;
    private final String basePath;
    private final String bearerCredential;

    KikotoAssetRequestPolicy(String serverUrl, String credential) {
        URI server = parse(serverUrl);
        String nextScheme = normalizedScheme(server);
        if (
            nextScheme == null ||
            server.getHost() == null ||
            server.getRawUserInfo() != null ||
            server.getRawQuery() != null ||
            server.getRawFragment() != null
        ) {
            throw new IllegalArgumentException("Invalid mobile server URL.");
        }
        String nextPath = server.getPath();
        if (hasUnsafePath(nextPath)) throw new IllegalArgumentException("Invalid mobile server URL.");
        this.scheme = nextScheme;
        this.host = server.getHost().toLowerCase(Locale.ROOT);
        this.port = effectivePort(server, nextScheme);
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Invalid mobile server URL.");
        this.basePath = normalizeBasePath(nextPath);
        String credentialValue = credential == null ? "" : credential.trim();
        if (credentialValue.indexOf('\r') >= 0 || credentialValue.indexOf('\n') >= 0) {
            throw new IllegalArgumentException("Invalid mobile session token.");
        }
        this.bearerCredential = credentialValue;
    }

    boolean allows(String url, String method) {
        try {
            return allows(new URI(url), method);
        } catch (URISyntaxException | IllegalArgumentException ignored) {
            return false;
        }
    }

    boolean allows(URI uri, String method) {
        String requestScheme = normalizedScheme(uri);
        if (
            requestScheme == null ||
            !scheme.equals(requestScheme) ||
            uri.getHost() == null ||
            !host.equals(uri.getHost().toLowerCase(Locale.ROOT)) ||
            port != effectivePort(uri, requestScheme) ||
            uri.getRawUserInfo() != null ||
            uri.getRawFragment() != null ||
            hasUnsafePath(uri.getPath())
        ) {
            return false;
        }
        String normalizedMethod = method == null ? "" : method.toUpperCase(Locale.ROOT);
        if (!"GET".equals(normalizedMethod) && !"HEAD".equals(normalizedMethod)) return false;
        String route = routePath(uri.getPath());
        return route != null && isAllowedRoute(route);
    }

    URI resolveRedirect(URI current, String location, String method) {
        if (location == null || location.trim().isEmpty()) return null;
        try {
            URI next = current.resolve(new URI(location));
            return allows(next, method) ? next : null;
        } catch (URISyntaxException | IllegalArgumentException ignored) {
            return null;
        }
    }

    String authorizationHeader() {
        return bearerCredential.isEmpty() ? "" : "Bearer " + bearerCredential;
    }

    private String routePath(String rawPath) {
        String path = rawPath == null || rawPath.isEmpty() ? "/" : rawPath;
        if (basePath.isEmpty()) return path;
        if (!path.startsWith(basePath + "/")) return null;
        return path.substring(basePath.length());
    }

    private static boolean isAllowedRoute(String route) {
        if (route.startsWith(COVER_PREFIX) && route.length() > COVER_PREFIX.length()) return true;
        if (route.startsWith(MANUAL_PREFIX) && route.length() > MANUAL_PREFIX.length()) {
            return route.indexOf('/', MANUAL_PREFIX.length()) < 0;
        }
        return MEDIA_PATH.matcher(route).matches();
    }

    private static URI parse(String value) {
        try {
            return new URI(value == null ? "" : value.trim());
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("Invalid mobile server URL.", error);
        }
    }

    private static String normalizedScheme(URI uri) {
        String value = uri.getScheme();
        if (value == null) return null;
        String normalized = value.toLowerCase(Locale.ROOT);
        return "http".equals(normalized) || "https".equals(normalized) ? normalized : null;
    }

    private static int effectivePort(URI uri, String normalizedScheme) {
        if (uri.getPort() >= 0) return uri.getPort();
        return "https".equals(normalizedScheme) ? 443 : 80;
    }

    private static String normalizeBasePath(String rawPath) {
        if (rawPath == null || rawPath.isEmpty() || "/".equals(rawPath)) return "";
        String value = rawPath;
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }

    private static boolean hasUnsafePath(String path) {
        if (path == null) return false;
        if (path.indexOf('\\') >= 0 || path.indexOf('\0') >= 0) return true;
        for (String segment : path.split("/", -1)) {
            if (".".equals(segment) || "..".equals(segment)) return true;
        }
        return false;
    }
}
