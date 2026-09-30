# Personal data

[English](../en/personal-data.md) · [简体中文](../zh-Hans/personal-data.md) · [繁體中文](../zh-Hant/personal-data.md) · [日本語](../ja/personal-data.md) · [한국어](../ko/personal-data.md)

Sign in and open **Settings**: listening history is in the **History &
recommendations** tab, personal tags are in **Tags**, and **Your data** is the
last section of **Account**. The mobile account menu and Quick actions open
each one directly. They show only your account's data.

## Personal tags

Search work, circle, or voice tags, including unused tags. Rename updates all
assignments. Merge moves assignments to an existing tag, removes duplicates,
and deletes the old tag. Delete removes the tag and its assignments, without
deleting works or provider metadata.

New workflow tag defaults omit the date so repeated runs reuse a tag. Existing
saved templates are preserved; remove `{date}` in Workflows if an older schedule
should stop creating dated tags. Explicit date templates remain supported.

## Listening history

The listening report covers the last 30 days, the last 12 months, or all
time. For the chosen range it shows listening time, plays, works, and active
days; a chart by UTC day, month, or year (all time switches to years after
three years) with the average and busiest period; and the most listened works
as cover cards ranked by listening time. Imported totals have no dates, so they
count only in All time. The full history, cover cards ordered by last listening
time, is collapsed below the report and loads when opened.
Time measures actual listening, excluding paused, buffering, and seek time;
speed changes do not multiply it. Concurrent players count independently.
Client interruptions or disconnection may leave some time unreported.

History stays on your server until cleared or its account/work is deleted.
Recommendation event cleanup after 90 days does not remove it. Upgrade preserves
remaining old play events and resume timestamps without inventing durations;
previously deleted events cannot be recovered. Clearing history keeps marks,
playlists and resume progress. An account counter rejects
delayed reports from before the clear.

## Export and import

Version 1 Kikoto personal JSON contains per-work listening marks, personal
ratings/notes, resume information, lifetime listening totals, work tag
assignments, custom tag definitions, and ordered favorite playlists. System
Marked membership is derived from marks. Circle/voice tag definitions are
included; their entity assignments and other state are outside this format.

Media, source settings, endpoints, credentials, provider metadata, raw sessions,
and daily statistics are excluded. Track titles and track/disc numbers identify
resume targets; local paths and source-local ids are not exported.

Choose a source (a JSON file, a Kikoeru account, or a Kikoeru database), then
Preview before Import. Keep existing skips
works with personal state and preserves existing playlists. Overwrite replaces
marks, notes, work tags, matching progress and same-name playlists from the file.
Listening totals merge by maximum so repeated imports cannot double count or
reduce measured listening.

Only existing works and unambiguous known aliases match by primary code.
Missing codes are listed; import never fetches metadata or creates works.
Missing or ambiguous tracks leave existing progress intact. Import commits
atomically. Limits: 10 MiB, 20,000 works, 5,000 tag definitions, 1,000 playlists
and 50,000 playlist items or work tag assignments.

## Kikoeru

A Kikoeru JSON file accepts review arrays, a `reviews` array, or an API `works`
array. Use one account's data and include every desired page. Codes use
`primaryCode` or `source_id`; a numeric `work_id`/`id` is the product number.
Forks that encode the product type in the id (type × 10¹² + digits, with RJ, BJ,
VJ, and CC as types 0–3) are decoded. Ids unrelated to product codes must first
be converted. Personal `userRating`/`user_rating` and `review_text` are
supported; provider ratings are not imported.

**Kikoeru account** reads the data for you. Pick a configured Kikoeru-compatible
source or enter the server's API address, then sign in with nothing (for a
server with sign-in turned off), a token, or a name and password. The server
signs in through `POST /api/auth/me`, pages through `GET /api/review`, and, when
the Kikoeru server offers them, reads the playlists you own, including its liked
and marked lists. A server without playlists imports reviews only. The result
goes through the same preview and import as a file.

**Kikoeru database file** uploads the SQLite database of the open-source
Kikoeru, up to 512 MiB, and reads only the named account's reviews. Copy the
file while Kikoeru is stopped or idle so recent writes are included. That
database has no playlists.

Before a token, password, manual address, or database leaves the browser,
Kikoto explains the risks and asks for confirmation:

- Credentials pass through the Kikoto server. They are used for that request
  only and are never stored or logged, but whoever operates the server could
  capture them.
- The Kikoeru server sees a sign-in from the Kikoto server's network address. A
  third-party site may flag or limit the account.
- A token acts as your account and can stay valid for a long time.
- A Kikoeru database holds every account on that server, including password
  hashes. The upload stays in a temporary file while it is read and is deleted
  right after.

These requests never follow a redirect, so credentials reach only the address
you chose. A manually entered address must be public unless you are an
administrator or an administrator turns on **Settings → Library → Kikoeru
account import → Allow LAN addresses for every account**. That switch lets any
signed-in account make the server connect to devices on its local network.
Rows without a usable product code are skipped and counted, and at most two
account or database reads run at a time.

| Kikoeru progress | Kikoto mark |
| --- | --- |
| `marked` | Want to listen |
| `listening` | Listening |
| `listened` | Finished |
| `replay` | Relisten |
| `postponed` | Paused |
| empty / null | Unmarked |

The mapping follows the upstream [Kikoeru review API](https://github.com/kikoeru-project/kikoeru-express/blob/unstable/routes/review.js).
