# Playback Reports

How the client measures listening time, stores and sends playback reports and
the work cursor, and recovers them across reloads, failures, and identity
changes.

## Listening Clock

The player records cumulative listening time under an account/server scope;
history clearing invalidates older reports using a server generation.

`ListeningClock` measures advancing wall time, independently of media position
and playback rate. Pause, waiting, seeking and ended stop its clock. A gap over
60 seconds, or a wall-clock discontinuity inconsistent with the monotonic clock,
is excluded rather than credited as device sleep. It partitions measured time
by the calendar date of the account's time zone, under one stable session id.
The zone arrives with the history generation from `GET /api/listening-sessions`:
a name is the zone the account fixed, `null` is the device's own zone, and a
response that names nothing counts UTC dates. A saved Account time zone
replaces it at once; a zone the runtime does not know counts UTC dates. For a server whose generation lookup
says it counts hours, each date also carries its listening per hour of the day.
A session rolls over after 86,400 measured seconds, 32
distinct dates, 48 distinct hours, or a changed zone. Midnight alone does not add a listen count;
the count belongs to the activation's first listening date.

## Sending

`usePlaybackProgress` retains the applied-start and listener-intent guards for
the canonical work cursor. Events update local checkpoints; `timeupdate` never
sends HTTP. `PlaybackReportScheduler` is the sole sender and batches both models
in `POST /api/playback-reports` every 30 seconds during uninterrupted playback
(about two periodic writes per minute). Pause, end, seek and track change request
one coalesced event checkpoint. Hide/pagehide attempt a bounded keepalive batch.
There is one request in flight per scheduler; a newer event waits for it. Empty
and unchanged reports generate no write request. Navigation keeps this hook and
the media element mounted in the global player.

## Outbox

`playbackReportOutbox` uses atomic IndexedDB transactions keyed by normalized
server identity and account id. It merges session cumulative totals and retains
the latest work cursor. A cursor's order is `max(Date.now(), previousOrder+1)`,
persisted across reloads and shared between tabs, with a stable report id as the
tie-breaker. The server uses this order, including backward seeks, rather than
the largest media position. Across devices it uses occurrence wall clocks;
large clock skew can affect precedence. Legacy cursor writes establish a current
receipt-time order, so an older offline checkpoint cannot undo a later legacy
save. Browser storage contains no credential, title, source URL or file path.

Each scope retains at most 64 sessions and 32 work cursors, within 256 KiB.
Capacity never evicts an unconfirmed record: existing entries can merge, a new
work's cursor takes the place of the oldest quarantined cursor, and other new
distinct entries are refused, with a sanitized console diagnostic. A batch
stays below 48 KiB for fetch keepalive. Accepted/stale acknowledgements remove
only the exact sent cursor or the acknowledged cumulative time; newer pending
data survives an older response.

## Acknowledgements and Failures

Resume-cache events associate acknowledgements by `reportId`, reconcile the
unified owner with the submitted and played work identities, and learn the
whole batch's ownership before comparing confirmations. Recorded and stale
responses include persisted edition membership, so a previously unacknowledged
translation can still be recognized as belonging to the same unified work.
Only a newer, non-quarantined checkpoint of that work prevents an older cursor
event. A newer stale acknowledgement suppresses older recorded candidates for
that owner, regardless of response order. Unknown identities are never assumed
to belong to every work. Responses without the additive identity field still
use cursor and previously learned ownership, without guessing unseen relations.

The server records a checkpoint whose location no longer exists without a
location. A checkpoint that an older server answers `invalid` while it names a
location is kept and sent again without the location; it is quarantined only
when it is refused again without one. Terminal item failures (`invalid`,
`not_found`, `conflict`, or `history_cleared` for progress) remain
quarantined and neither invalidate nor defer other cursor confirmations. A new
cursor observation can replace its quarantined entry. Nonretryable HTTP failures quarantine the affected batch. Network errors,
408, 429, database busy and retryable server errors retain data and use persistent
exponential backoff from five seconds to five minutes, without an attempt-based
discard. Online events request a retry within that backoff.

## Restoration and Loss

Restoration verifies the server's history generation before replaying history.
A cached generation can measure offline, but its data is replayed only after
verification. A changed generation discards old intervals and opens a fresh
session; an in-flight pre-clear acknowledgement cannot establish its generation
again. Progress can still send when generation lookup fails. Identity changes
cancel in-flight transport and prevent staged writes from draining under new
credentials; the old scope remains available when its owner signs in again.

Local measurement and cursor persistence are sampled about once per second,
independent of the 30-second network cadence. With working browser storage,
crash loss is normally the last sample plus any uncommitted IndexedDB write;
unconfirmed earlier checkpoints recover on reload. Browser timer suspension,
storage eviction, a full queue, a first launch without a known generation, or
storage failure can lose more. If IndexedDB cannot open, reports continue in a
volatile queue with a diagnostic and a normal network loss window of up to
30 seconds. Browser keepalive is an attempt, not a delivery acknowledgement.
