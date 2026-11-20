# Outbound Requests

The outbound transport policy, proxy routing, per-origin request lanes, and the caches for remote responses and covers.

An administrator-configured source endpoint may intentionally be on a private
LAN. Source-returned media, cover, and redirect destinations remain untrusted
input. New or changed clients must define their permitted origin boundary,
revalidate allowed redirects, prevent DNS-rebinding time-of-check/time-of-use
gaps, remove credentials on origin changes, and bound time, response size,
stream size, concurrency, and retries.

The shared outbound transport accepts only HTTP(S) URLs without embedded
credentials, validates the initial request and every redirect hop, strips
credentials on allowed origin changes, validates the complete DNS answer, and
dials one of those same validated numeric addresses. Built-in public metadata
destinations reject private and reserved addresses; a NAT64 well-known-prefix
address (`64:ff9b::/96`) is judged by the IPv4 address it embeds, so DNS64
networks keep working. Administrator-configured
source origins may explicitly reach private LAN addresses.

Requests to a compatible remote source send `Accept-Language`: on behalf of a
signed-in user with a preferred metadata language, that user's languages
first, then the source's configured fallback language last, with decreasing
weights. The original language has no request language, so a viewer without a
preference, anonymous browsing, and results stored for everyone (crawls,
catalog refreshes, remote metadata fallback, downloads) send the fallback
language alone. The short-lived remote work snapshot
cache is keyed by the viewer's languages, so one viewer's response never serves
another language. The header changes no destination or transport policy.

Compatible remote sources default to public-host compatibility mode so a
source may move media, cover, or text storage to another public origin without
a Kikoto configuration change. The configured API, public-site, and fallback
origins retain their explicit private-address exception; every other origin
must resolve only to public addresses. An administrator can instead restrict a
source to those configured origins plus exact public hostnames or leading
wildcards such as `*.media.example.invalid`. A wildcard matches subdomains, not
the parent hostname, and additional hosts never inherit the private-address
exception.

The hardened transport never inherits ambient HTTP proxy variables. A policy
may instead name one operator-configured forward proxy, optionally with
credentials; it then dials only that proxy endpoint, with the configured
private-address exception, while URL, origin, and redirect checks still apply
to each request. Destination DNS is validated locally, and HTTP(S) CONNECT or
SOCKS tunnels target the same validated numeric address. Original Host and TLS
certificate checks are preserved; a configured proxy does not expand a
destination's private-address permission. The
`outbound_proxy_config` setting holds an ordered proxy list, routes for the
DLsite, remote-source, LLM and ASR, and other scopes, with per-source overrides,
and a bypass list; a stored configuration without the bypass list uses
`proxyconfig.DefaultBypass`. `internal/proxyconfig` validates it and resolves
a scope to proxies. A proxied policy dials a destination the bypass list
matches by hostname or by validated address directly, under the same address
rules. Each
request path builds one policy transport per resolved proxy behind a priority
failover transport; the opt-in direct fallback adds a direct policy transport
that the failover always tries last. The DLsite transport and the pooled remote-source
transports rebuild when their resolved proxies or bypass list change and close the previous
idle connections. A legacy `metadata_proxy_url` value is read as a DLsite route
until the proxy configuration is first saved. Connection, response-header, response-read idle,
buffered-body, streamed-file, concurrency, and retry bounds are specific to
the request class. See
[Secure development](../../development/security.md) and
[Runtime security](../../operations/security.md) before extending an outbound
request path.

Configured-source clients reuse a bounded pool of transports, keyed by source
identity and its complete outbound policy. Policy changes replace the transport
and close its idle connections; pooled requests retain URL checks and pinned
connections. Each origin has separate interactive, crawl, download, and playback
lanes. The first three serialize response bodies; playback permits four active
streams. Each lane admits at most 32 waiting requests, and queued cancellation
does not wait for the active response to finish.

## Remote Query Cache and Covers

Remote queries requiring local filtering retain only upstream pages for up to
30 seconds, with at most 32 pages and 16 MiB of serialized data per server.
Pages larger than 2 MiB bypass the cache. Keys distinguish the viewer, complete
source configuration and invalidation generation, language, query and filter
plan, ordering, recommendation seed, and upstream page. Every request reads
current personal tags, marks and local availability again. Source configuration
is checked before and after a cached read or upstream request. Cache misses
use the existing outbound transport and request lanes; discovery never creates
new work identities. Upstream metadata may lag by the cache lifetime.

Remote covers accept JPEG, PNG, and WebP file signatures rather than trusting
upstream MIME headers or filename extensions. Publication retains the bounded
atomic download writer. Cover serving checks legacy cached content too and
sets an explicit raster MIME type, `nosniff`, and a sandboxed content policy.
It does not decompress or re-encode the image. Cover URLs carry a revision token
derived from the cached file; a request whose token matches the current file is
privately cacheable as immutable, while an unversioned or stale request is
revalidated.
