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

History lists works by last listening time, with lifetime listening time and
playback session counts. Statistics include top works and the last 30 UTC days.
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

Choose a JSON file and format, then Preview before Import. Keep existing skips
works with personal state and preserves existing playlists. Overwrite replaces
marks, notes, work tags, matching progress and same-name playlists from the file.
Listening totals merge by maximum so repeated imports cannot double count or
reduce measured listening.

Only existing works and unambiguous known aliases match by primary code.
Missing codes are listed; import never fetches metadata or creates works.
Missing or ambiguous tracks leave existing progress intact. Import commits
atomically. Limits: 10 MiB, 20,000 works, 5,000 tag definitions, 1,000 playlists
and 50,000 playlist items or work tag assignments.

Kikoeru accepts review arrays, a `reviews` array, or an API `works` array. Use one
account's data and include every desired page. Codes use `primaryCode` or
`source_id`; legacy numeric `work_id`/`id` means the RJ product number. A fork's
unrelated database ids must first be converted to product codes. Personal
`userRating`/`user_rating` and `review_text` are supported; provider ratings are
not imported.

| Kikoeru progress | Kikoto mark |
| --- | --- |
| `marked` | Want to listen |
| `listening` | Listening |
| `listened` | Finished |
| `replay` | Relisten |
| `postponed` | Paused |
| empty / null | Unmarked |

The mapping follows the upstream [Kikoeru review API](https://github.com/kikoeru-project/kikoeru-express/blob/unstable/routes/review.js).
