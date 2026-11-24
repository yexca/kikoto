# HTTP Responses

Request and response contracts for playback reports and listening history, static asset caching, compression, the error shape, and request time budgets.

`POST /api/playback-reports` requires `playback:use`, accepts up to 32 resume
checkpoints and 64 dated cumulative listening reports, and bounds JSON to
128 KiB. Strict JSON/envelope errors reject the request before mutation.
Finite nonnegative positions, matching media locations, valid session ids,
bounded cumulative totals and sorted date buckets are validated per item. A
bucket is a calendar date of the account's time zone as the client resolves
it, so it may be one day before the session's first UTC date or one day after
its last.
Dates must sum to the cumulative total; accepted buckets cannot decrease or
disappear. A date may split its listening into ascending hours of the day that
hold no more than the date; an hour reported lower keeps what it holds. Occurrence timestamps cannot be more than five minutes in the future.
All accepted items commit in one transaction; unexpected database errors or
cancellation roll back the entire batch. Expected invalid/missing/conflicting
items return separate statuses. A history-generation rejection therefore does
not undo a valid resume checkpoint. A successful response acknowledges each
submitted id and returns the generation observed by the transaction.

Recorded and stale progress acknowledgements carry an `identity` object: the
unified cursor owner's `workId` and its persisted `editionWorkIds` (including
the owner and played edition). Membership is read in the same transaction,
without discovering or materializing works. Only a recorded checkpoint returns
a `cursor`; stale identity is ownership evidence, not permission to publish the
submitted position. Acknowledgements without a stored cursor omit `identity`.

`PATCH /api/media-items/{id}/progress` and `GET/POST /api/listening-sessions`
serve web and native clients that do not send playback reports; their responses
carry no `identity`. A progress write that a later checkpoint outranks leaves
the cursor as it is and answers `stored: false`. `GET /api/listening-sessions` returns the history
generation with the time zone the account fixed, `null` while it follows the
device, and `hours: true` for a server that takes hour buckets. The listening
statistics, calendar, breakdown, and profile endpoints take the
device's zone as a `timeZone` query parameter and count days in the account's
zone as [User State](../data-model/user-state.md#user-state) defines it; the calendar
response names that zone and whether it follows the device. Their `range` is
`30d`, `12m`, `all`, or a calendar year such as `2026`, which ends on its last
day or, for the current year, today. The calendar shows the year a range
names and the weeks up to today for any other range. Statistics list the years
with dated listening and the range's listening per hour of the day, and add a
year's highlights: its busiest day, the works first heard in it, and the voice
and circle listened to most. Undated sessions
are credited to the receipt date in the account's zone. Dated sessions use the client's occurrence date
buckets and cannot switch to the undated format under the same session id. Resume and history are independent tables and are
never inferred from one another.

When the backend serves the bundled frontend, content-hashed files under
`/assets/` are cached for a year as `immutable`. HTML files including
`index.html` and the SPA fallback, `sw.js`, `theme-bootstrap.js`, and
`manifest.webmanifest` use `no-cache`, and other static files use a one-hour
public lifetime. A missing `/assets/` file returns 404 rather
than the app shell.

A response middleware gzip-compresses JSON, HTML, CSS, JavaScript, SVG, and web
manifest bodies of at least 1 KiB when the client accepts gzip, and adds
`Vary: Accept-Encoding` to those content types. It never compresses Range
requests, 206 responses, responses that already carry `Content-Encoding`,
event streams, or media, cover, and asset routes, and it preserves flushing.
Authentication responses are also excluded because a mobile sign-in response
returns a session token next to the reflected username. Without that exclusion,
compressed response length could leak the token (a BREACH-style attack). No other
response embeds a credential or CSRF token. The split-deployment
`frontend/nginx.conf` applies the same `/assets/` caching, `no-cache` app shell,
and static compression.

Error responses share one shape: `error`, a stable `code`, and `retryable`.
Fields beside them explain a refusal further, such as the permission a request
lacks or the summary of a conflicting plan. A
request the caller got wrong answers with a 4xx, is not retryable, and is not
logged as an error. An addressed work, media location, source, alias, or
tracked source that does not exist is a 404 `not_found`; one of the wrong kind,
or in a state the operation does not apply to, is a 400 or a 409. A 502
`upstream_unavailable` means a remote source failed to answer. A source that
answers that it has no such work is a 404, and that answer leaves the source's
health unchanged. A Fetch the server refuses carries its own code, such as
`download_limit_exceeded`, `insufficient_disk_space`, or `source_not_usable`.
A JSON body with a value of the wrong type names the field in its 400 message.

Every API request must start its response within 60 seconds. When it has not,
its request context is cancelled, so a request waiting for the file
database's writer connection or one of its reader connections (see
[Database concurrency](../../operations/database.md#concurrency)) cannot wait
forever and hold up authentication and every later request. A cancelled
request answers with a retryable 503 `service_unavailable` error. The budget
stops once the handler writes its headers, so event streams and long downloads
are unaffected. Routes that legitimately work longer before their first byte
are registered with `handleSlowFirstResponse`: synchronous media transcodes,
remote-source operations that make several paced upstream requests,
filesystem maintenance that should not stop halfway, and the Kikoeru imports,
which run under their own deadlines.
The server also samples the reader and writer pools every 10 seconds. It logs
an error, naming the pool, when a pool stays fully checked out while new
requests keep queueing, logs the recovery afterwards, and warns when completed
connection waits average a second or more.
