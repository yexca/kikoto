# User State

Accounts, sessions, preferences and per-user library state that survives metadata refresh and source replacement.

Important tables:

- `user_account`
- `user_password_credential`
- `user_session`
- `user_preference`
- `user_work_state`
- `user_work_playback_cursor`
- `user_media_lyrics_preference`
- `user_media_lyrics_offset`
- `favorite_list`
- `favorite_list_item`
- `favorite_list_smart_tag`
- `favorite_list_smart_exclusion`
- `favorite_list_smart_seen`
- `user_tag`
- `user_work_tag`
- `user_listening_session`
- `user_listening_day`
- `user_listening_session_day`
- `user_listening_import`
- `user_listening_generation`
- `audit_log`

A work family's personal state lives on its canonical work: the logical
work's canonical work, else its canonical edition, else the work itself while
the family has neither in the library (`personal.CanonicalWorkIDSQL`).
`user_work_state`, `user_work_tag`, favorite list items with their
smart-list exclusions, `user_work_playback_cursor`, and the listening
history in `user_listening_session`, `user_listening_day`, and
`user_listening_import` are written there also when a request names an
edition. An edition's detail, and the lists, tags, and ratings of lists,
circles, voice actors, and workflow filters, read its family's state. A smart
list's seen marks name each work its rule matched, editions included, and stay
where they are. When metadata sync stores a family, the state an edition still
holds moves to the canonical work: the later listening mark, rating, and
cursor win, unless the later row was never changed after it was created, so a
cleared mark or rating stays cleared; two notes are joined; the work keeps the
personal tags of both; a tag or a list that both held keeps one entry dated by
the earlier; listening days and imported totals are added together; and the
favorite flag follows the moved memberships. A startup repair does the same
for every family whose state lies on an edition, so state written before the
canonical work changed is never split across a family. A family with nothing
to move takes no write transaction.

An account id is never handed out again: `user_account` uses an
`AUTOINCREMENT` key, which started above the highest requester id any
workflow run named when the key was introduced, so those ids are retired for
good as well. A new account therefore never inherits a deleted account's runs
or the client state the browser keeps under its id. Only the id of an account
deleted before the key existed and named by no run could be handed out once
more.

`user_password_credential` holds one Argon2id password hash per account.
`user_session.id` is the hex SHA-256 digest of the bearer token issued to the
client, never the token itself, so the database and its backups cannot be
replayed as a sign-in. The account store hashes every token before a lookup or
delete. `audit_log` records administrative actions, such as account, access
policy, backup and database maintenance changes, with the acting user, target
and a JSON detail.

`user_preference` stores optional account overrides for folder routing rules,
recommendation configuration, recommendation highlight threshold, the personal metadata
language priority (see [Metadata Language](work-metadata.md#metadata-language)), and the
account's IANA time zone. A missing
override uses the `app_setting` default, or the original language for
metadata. A missing time zone follows the device: the client counts listening
in its own zone and names that zone on each listening report request, and a
request that names no usable zone is counted in the zone the server runs in,
its `TZ` when that names a zone and UTC otherwise. New recommendation generations use the effective account
configuration; existing session bindings remain immutable.

Listening history is durable and separate from `recommendation_event`.
Sessions belong to an account and canonical work, accept monotonic cumulative
seconds, and survive recommendation retention cleanup. Imported totals store
positive differences above measured totals without fabricating daily activity.
Clearing history increments an account generation checked on every report,
including an unseen first report, to reject delayed retries; marks, lists and
cursors stay intact. Export/import is a versioned work-code-based personal
document, not a database or media backup.

`user_listening_session.dated_report` marks whether a session reports by
occurrence date; a report in the other form conflicts with the stored session.
A listening day is a calendar day of the account's time zone at the time the
listening is recorded; a later time zone change leaves stored days unchanged.
Undated reports credit only newly reported seconds to the account's current day in
`user_listening_day`. Dated reports keep cumulative per-session date buckets in
`user_listening_session_day`, with a cascading session foreign key; they credit
only each bucket's increase to `user_listening_day`, count a session once on
its first reported date, and keep occurrence time in the session's history
timestamps. A dated report may also split a date by hour of the day:
`user_listening_session_hour` keeps the session's cumulative hour buckets and
`user_listening_hour` the account's listening per date and hour, credited by
each bucket's increase. Hours describe only the listening reported with them,
and clearing history removes them.

Listening reports read these rows per canonical work: a row stored against an
edition is reported as its family's canonical work, the one the Library lists.
A report's ranges, calendar, and current day follow the account's time zone.
The tag, voice, and circle rankings join the canonical work's shared tags,
voice credits, and primary circle; their preference order compares an entry's
share of the range's listening time with its share of the Library's canonical
works.

The taste profile reads the same range. Its tags are the leading entries of
the tag preference order. A work attribute (`duration_seconds`,
`release_date`, `sales_count`) places the listening among the Library's
canonical works: each listened work takes its percentile among the Library's
works that carry the attribute, and the profile reports their mean weighted by
listening time, so 0.5 is a Library-typical account. An attribute with fewer
than three works on either side is omitted. The rating comparison spans every
rated work whatever the range: the mean `user_work_state.rating` against the
mean `rating_average` of the same works. Marks count the listened works whose
`listening_status` is listening, paused, finished, or relisten. Ratings and
marks on an edition count for its canonical work.

Demo stores a simulated listening history for its shared account in the same
tables, so its reports run the ordinary queries. `demo-listening-v1` derives
each calendar day's sessions from the date alone and each work's share from
its unified `primary_code`, over at most 24 admitted local works and the last
400 days through the current hour. Startup and an hourly rebuild replace the
account's sessions, days, hours, and imported totals, and rate the works the
history plays most.

`favorite_list` distinguishes a system `marked` list, ordinary `user` lists,
and `smart` lists. The system list has no stored items: it derives membership
from a non-`none` Quick mark, and the favorite works listing's `marked` status
filter applies the same rule to any list. `favorite_list_item` records the works a user
added by hand to a user or smart list; those works are favorites, and
`user_work_state.favorite` is true exactly when a work has such a row. An
item's `created_at` is when the work joined the list, and a membership that
stays keeps it. It orders the lists a work card and work detail name for a
work: hand additions newest first, then the smart lists that hold the work
only through their rule, in list order.
A user list's `icon` is a short presentation key (lowercase letters, digits,
and hyphens) that clients map to their own icon set; an empty or unknown key
shows the default list icon, and the system list never reports one.

A smart list shows its hand-added works plus the works that match its rule,
minus the rule matches its owner removed (`favorite_list_smart_exclusion`).
Rule matches are computed on read and are not favorites. The rule
(`favorite_list_smart_tag`) sorts shared metadata tags or the owner's personal
tags into three groups: a work matches when it carries every required tag, at
least one tag of the any group when that group has tags, and no excluded tag.
A rule needs at least one required or any tag, and a tag belongs to one group. Conditions keep the tag id without a foreign key: a metadata tag
matches through its current merge target, a hidden or deleted tag matches no
work, and merging a personal tag moves the owner's conditions to the merge
target. A metadata tag matches a work when the work or another edition of its
logical work carries it; a personal tag matches the work itself. Rules never
read remote catalogs, so a list only gathers works the library already has.
`favorite_list_smart_seen` holds the rule matches the owner has seen; saving a
rule or marking the list seen replaces it with the current matches, and a
current match outside it is a new work. Converting a smart list to a user list
stores every work it shows as an item, which makes each one a favorite, and
drops the rule, exclusions, and seen set. Personal data exports leave smart
lists out, and an import skips a backup list whose name a smart list holds.

`user_work_playback_cursor` stores at most one Resume position for each user and
canonical logical work family. It references the active edition's logical media
item and records the last file source/location context; location deletion clears
those foreign keys without turning a raw path into the progress owner. The
per-track `user_media_progress` table is retained in the schema, but no runtime
code reads or writes it.

The cursor's `report_order` and `report_id` provide a total checkpoint order
independent of position. A repeated or older checkpoint is acknowledged without
replacing a later cursor, including a later backward seek. An explicit
personal-progress import establishes a new checkpoint order at import time,
advancing beyond an existing order if necessary. A reserved server marker wins
a tied client order. The backup's historical playback date remains presentation
data, so an older offline report cannot undo the import; a strictly later
checkpoint, including a backward seek, still replaces it.

Lyrics preferences relate an audio media item to a lyrics media item; runtime
location selection remains a file-source concern. A personal preference
overrides the shared `media_lyrics_assignment` for that user only.
