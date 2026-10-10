import Foundation
import WebKit

/// Validates asset requests against the configured server, mirroring the
/// Android `KikotoAssetRequestPolicy`. The destination is always the
/// administrator-configured origin; only fixed asset routes may be reached.
struct KikotoAssetRequestPolicy {
    private static let coverPrefix = "/api/assets/covers/"
    private static let manualPrefix = "/api/assets/manual/"
    private static let mediaPath = try! NSRegularExpression(
        pattern: "^/api/media/[1-9][0-9]*/(?:stream|asset|text|download)$"
    )
    private static let hlsPath = try! NSRegularExpression(
        pattern: "^/api/media/[1-9][0-9]*/hls/(?:index\\.m3u8|segment-[0-9]{6}\\.ts)$"
    )
    private static let hlsSegmentPath = try! NSRegularExpression(
        pattern: "^/api/media/[1-9][0-9]*/hls/segment-[0-9]{6}\\.ts$"
    )
    private static let remoteWorkPath = try! NSRegularExpression(
        pattern: "^/api/remote-sources/[1-9][0-9]*/works/[^/]+/(?:media|text)$"
    )
    private static let remoteImagePath = try! NSRegularExpression(
        pattern: "^/api/remote-sources/[1-9][0-9]*/images/[^/]+$"
    )

    private let server: URLComponents
    private let scheme: String
    private let host: String
    private let port: Int
    private let basePath: String
    private let bearerCredential: String

    init?(serverURL: String, credential: String) {
        guard
            let components = URLComponents(string: serverURL.trimmingCharacters(in: .whitespaces)),
            let scheme = Self.normalizedScheme(components.scheme),
            let host = components.host, !host.isEmpty,
            components.user == nil, components.password == nil,
            components.query == nil, components.fragment == nil,
            !Self.hasUnsafePath(components.path)
        else { return nil }
        let port = Self.effectivePort(components.port, scheme: scheme)
        guard (1...65535).contains(port) else { return nil }
        let token = credential.trimmingCharacters(in: .whitespaces)
        guard !token.contains("\r"), !token.contains("\n") else { return nil }
        var base = components.percentEncodedPath
        while base.hasSuffix("/") { base.removeLast() }
        var server = components
        server.percentEncodedPath = base
        self.server = server
        self.scheme = scheme
        self.host = host.lowercased()
        self.port = port
        self.basePath = components.path == "/" ? "" : components.path.replacingOccurrences(
            of: "/+$", with: "", options: .regularExpression
        )
        self.bearerCredential = token
    }

    var authorizationHeader: String? {
        bearerCredential.isEmpty ? nil : "Bearer \(bearerCredential)"
    }

    /// Maps `kikoto-asset://asset/<route>?<query>` to the same route on the
    /// configured server, or nil when the route is not an allowed asset.
    func target(forAssetURL url: URL, method: String) -> URL? {
        guard
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.host == KikotoAssetSchemeHandler.assetHost,
            components.user == nil, components.password == nil, components.port == nil,
            Self.isReadMethod(method),
            !Self.hasUnsafePath(components.path),
            Self.isAllowedRoute(components.path)
        else { return nil }
        var target = server
        target.percentEncodedPath = server.percentEncodedPath + components.percentEncodedPath
        target.percentEncodedQuery = components.percentEncodedQuery
        target.fragment = nil
        return target.url
    }

    /// Checks a redirect hop on the configured server.
    func allows(_ url: URL, method: String) -> Bool {
        guard
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let requestScheme = Self.normalizedScheme(components.scheme),
            requestScheme == scheme,
            components.host?.lowercased() == host,
            Self.effectivePort(components.port, scheme: requestScheme) == port,
            components.user == nil, components.password == nil, components.fragment == nil,
            Self.isReadMethod(method),
            !Self.hasUnsafePath(components.path),
            let route = routePath(components.path)
        else { return false }
        return Self.isAllowedRoute(route)
    }

    func isHLSSegment(_ url: URL) -> Bool {
        guard let route = routePath(url.path) else { return false }
        return Self.matches(Self.hlsSegmentPath, route)
    }

    private func routePath(_ rawPath: String) -> String? {
        let path = rawPath.isEmpty ? "/" : rawPath
        if basePath.isEmpty { return path }
        guard path.hasPrefix(basePath + "/") else { return nil }
        return String(path.dropFirst(basePath.count))
    }

    private static func isAllowedRoute(_ route: String) -> Bool {
        if route.hasPrefix(coverPrefix), route.count > coverPrefix.count { return true }
        if route.hasPrefix(manualPrefix), route.count > manualPrefix.count {
            return !route.dropFirst(manualPrefix.count).contains("/")
        }
        return matches(mediaPath, route) ||
            matches(hlsPath, route) ||
            matches(remoteWorkPath, route) ||
            matches(remoteImagePath, route)
    }

    private static func matches(_ expression: NSRegularExpression, _ value: String) -> Bool {
        expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    private static func isReadMethod(_ method: String) -> Bool {
        let normalized = method.uppercased()
        return normalized == "GET" || normalized == "HEAD"
    }

    private static func normalizedScheme(_ value: String?) -> String? {
        guard let normalized = value?.lowercased(), normalized == "http" || normalized == "https" else { return nil }
        return normalized
    }

    private static func effectivePort(_ port: Int?, scheme: String) -> Int {
        port ?? (scheme == "https" ? 443 : 80)
    }

    private static func hasUnsafePath(_ path: String) -> Bool {
        if path.contains("\\") || path.contains("\0") { return true }
        return path.split(separator: "/", omittingEmptySubsequences: false).contains { $0 == "." || $0 == ".." }
    }
}

/// Serves `kikoto-asset://asset/...` for media and image elements and remote
/// text fetches, which cannot send the session credential themselves. WKWebView
/// cannot intercept its own http(s) requests, so the frontend rewrites allowed
/// asset URLs to this scheme and this handler streams them from the configured
/// server with the bearer credential. Responses stream to WebKit; nothing is
/// buffered in memory.
final class KikotoAssetSchemeHandler: NSObject, WKURLSchemeHandler, URLSessionDataDelegate {
    static let scheme = "kikoto-asset"
    static let assetHost = "asset"
    static let shared = KikotoAssetSchemeHandler()

    private static let readTimeout: TimeInterval = 30
    private static let hlsSegmentReadTimeout: TimeInterval = 120
    private static let maxRedirects = 3
    private static let blockedRequestHeaders: Set<String> = [
        "accept-encoding", "authorization", "connection", "content-length", "cookie", "host",
        "keep-alive", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
        "x-kikoto-mobile",
    ]
    private static let blockedResponseHeaders: Set<String> = [
        "connection", "keep-alive", "proxy-authenticate", "set-cookie", "set-cookie2", "te",
        "trailer", "transfer-encoding", "upgrade",
    ]

    private final class Load {
        let schemeTask: WKURLSchemeTask
        let task: URLSessionDataTask
        let policy: KikotoAssetRequestPolicy
        let method: String
        let requestedRangeStart: Int64?
        var redirects = 0

        init(
            schemeTask: WKURLSchemeTask,
            task: URLSessionDataTask,
            policy: KikotoAssetRequestPolicy,
            method: String,
            requestedRangeStart: Int64?
        ) {
            self.schemeTask = schemeTask
            self.task = task
            self.policy = policy
            self.method = method
            self.requestedRangeStart = requestedRangeStart
        }
    }

    private let policyLock = NSLock()
    private var policy: KikotoAssetRequestPolicy?
    /// The app page origin, allowed to read responses through fetch and XHR.
    var appOrigin = ""

    // Loads are touched only on the main queue: WebKit calls start and stop on
    // main, and the session delivers its delegate callbacks there. A scheme task
    // must never be messaged after stop, so a stopped load is removed first.
    private var loads: [Int: Load] = [:]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
    }()

    func configure(serverURL: String, credential: String) -> Bool {
        guard let next = KikotoAssetRequestPolicy(serverURL: serverURL, credential: credential) else { return false }
        policyLock.lock()
        policy = next
        policyLock.unlock()
        return true
    }

    func clear() {
        policyLock.lock()
        policy = nil
        policyLock.unlock()
    }

    private func currentPolicy() -> KikotoAssetRequestPolicy? {
        policyLock.lock()
        defer { policyLock.unlock() }
        return policy
    }

    // MARK: WKURLSchemeHandler

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let request = urlSchemeTask.request
        let method = (request.httpMethod ?? "GET").uppercased()
        guard
            let policy = currentPolicy(),
            let url = request.url,
            let target = policy.target(forAssetURL: url, method: method)
        else {
            urlSchemeTask.didFailWithError(URLError(.resourceUnavailable))
            return
        }

        var upstream = URLRequest(
            url: target,
            cachePolicy: .reloadIgnoringLocalCacheData,
            timeoutInterval: policy.isHLSSegment(target) ? Self.hlsSegmentReadTimeout : Self.readTimeout
        )
        upstream.httpMethod = method
        for (name, value) in request.allHTTPHeaderFields ?? [:]
        where !Self.blockedRequestHeaders.contains(name.lowercased()) {
            upstream.setValue(value, forHTTPHeaderField: name)
        }
        Self.applyTransportHeaders(to: &upstream, policy: policy)

        let task = session.dataTask(with: upstream)
        loads[task.taskIdentifier] = Load(
            schemeTask: urlSchemeTask,
            task: task,
            policy: policy,
            method: method,
            requestedRangeStart: Self.requestedRangeStart(request.value(forHTTPHeaderField: "Range"))
        )
        task.resume()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        guard let entry = loads.first(where: { $0.value.schemeTask === urlSchemeTask }) else { return }
        loads.removeValue(forKey: entry.key)
        entry.value.task.cancel()
    }

    // MARK: URLSessionDataDelegate

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard
            let load = loads[task.taskIdentifier],
            load.redirects < Self.maxRedirects,
            let next = request.url,
            load.policy.allows(next, method: load.method)
        else {
            // Declining delivers the 3xx response, which is rejected below.
            completionHandler(nil)
            return
        }
        load.redirects += 1
        var redirected = request
        redirected.httpMethod = load.method
        Self.applyTransportHeaders(to: &redirected, policy: load.policy)
        completionHandler(redirected)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let load = loads[dataTask.taskIdentifier] else {
            completionHandler(.cancel)
            return
        }
        guard
            let http = response as? HTTPURLResponse,
            !(300...399).contains(http.statusCode),
            Self.rangeMatches(http, requestedStart: load.requestedRangeStart),
            let url = load.schemeTask.request.url,
            let forwarded = HTTPURLResponse(
                url: url,
                statusCode: http.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: responseHeaders(http)
            )
        else {
            fail(dataTask.taskIdentifier)
            completionHandler(.cancel)
            return
        }
        load.schemeTask.didReceive(forwarded)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        loads[dataTask.taskIdentifier]?.schemeTask.didReceive(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let load = loads.removeValue(forKey: task.taskIdentifier) else { return }
        if error != nil {
            // Upstream details stay out of the page.
            load.schemeTask.didFailWithError(URLError(.networkConnectionLost))
        } else {
            load.schemeTask.didFinish()
        }
    }

    // MARK: Helpers

    private func fail(_ taskIdentifier: Int) {
        loads.removeValue(forKey: taskIdentifier)?.schemeTask.didFailWithError(URLError(.badServerResponse))
    }

    private func responseHeaders(_ response: HTTPURLResponse) -> [String: String] {
        var headers: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            guard let name = key as? String, let text = value as? String else { continue }
            if Self.blockedResponseHeaders.contains(name.lowercased()) { continue }
            headers[name] = text
        }
        // The page origin differs from this scheme, so fetch and XHR reads of
        // lyrics, text previews, and HLS playlists need an explicit grant.
        if !appOrigin.isEmpty, !headers.keys.contains(where: { $0.lowercased() == "access-control-allow-origin" }) {
            headers["Access-Control-Allow-Origin"] = appOrigin
        }
        return headers
    }

    private static func applyTransportHeaders(to request: inout URLRequest, policy: KikotoAssetRequestPolicy) {
        // Media ranges must describe the bytes exposed by the response stream.
        // Do not let transparent HTTP compression change that byte coordinate.
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        request.setValue("1", forHTTPHeaderField: "X-Kikoto-Mobile")
        request.setValue(policy.authorizationHeader, forHTTPHeaderField: "Authorization")
        request.setValue(nil, forHTTPHeaderField: "Cookie")
    }

    private static func requestedRangeStart(_ value: String?) -> Int64? {
        guard let value, let match = value.range(of: "^bytes\\s*=\\s*(\\d+)-", options: [.regularExpression, .caseInsensitive])
        else { return nil }
        let digits = value[match].filter(\.isNumber)
        return Int64(digits)
    }

    private static func rangeMatches(_ response: HTTPURLResponse, requestedStart: Int64?) -> Bool {
        guard response.statusCode == 206 else { return true }
        guard
            let contentRange = response.value(forHTTPHeaderField: "Content-Range"),
            let match = contentRange.range(of: "^bytes\\s+(\\d+)\\s*-", options: [.regularExpression, .caseInsensitive]),
            let start = Int64(contentRange[match].filter(\.isNumber))
        else { return false }
        return requestedStart == nil || requestedStart == start
    }
}
