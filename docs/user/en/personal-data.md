# Personal data

[English](../en/personal-data.md) · [简体中文](../zh-Hans/personal-data.md) · [繁體中文](../zh-Hant/personal-data.md) · [日本語](../ja/personal-data.md) · [한국어](../ko/personal-data.md)

Sign in and open **Insights** in the sidebar for your listening calendar,
report, and history. Personal tags are in **Settings → Tags**, and **Your
data** is the last section of **Settings → Account**. Quick actions opens
each one directly, and the account menu behind your avatar opens Insights and
Tags. They show only your account's data.

## Personal tags

Search work, circle, or voice tags, including unused tags. Rename updates all
assignments. Merge moves assignments to an existing tag, removes duplicates,
and deletes the old tag. Delete removes the tag and its assignments, without
deleting works or provider metadata.

A workflow tag template without `{date}` reuses one tag across runs; a template
with `{date}` creates one tag per day.

## Insights

The switcher at the top of **Insights** chooses what the page covers: the last
30 days, the last 12 months, all time, or one calendar year. **Year**, the last entry, opens the years with
dated listening and names the chosen one.

The **listening calendar** shows a year as one cell per day in week columns,
shaded by listening time, with its listening days, listening time, and
streaks: the chosen calendar year, or the past year for the other ranges.
Point at or tap a day for its total.

A calendar year opens with its **highlights**: the year's listening time,
works, and listening days, the work, voice, and circle listened to most, the
busiest day with its leading work, the longest run of listening days, the
works first heard that year, and the busiest hour of the day.

For the chosen range the listening report shows:

- Listening time, plays, works, and active days, with the time per active day,
  the time per play, the top work's share of the time, and the share of days in
  the range with listening.
- A chart by day, month, or year (a calendar year by month; all time switches
  to years after three years) with the average and busiest period.
- The five most listened works, expandable to ten, each with its time and its
  share of the range's listening.
- Rhythm: the average listening per day from Monday to Friday and per weekend
  day, then the average per weekday. A 12-month or all-time report reads the
  calendar's days for this, so an all-time report describes the past year.
  **By hour of day** adds the listening per hour, midnight first, with the
  busiest hour. It counts only listening recorded with its hour.
- **Taste profile**: what you listen to, compared with the Library. The radar
  draws up to eight tags by how far each one's share of your listening time
  exceeds its share of the Library's works. A marker places your works among
  the Library's by release year, sales, and work length when enough of them
  carry that figure: the middle of the track is the Library, and works you
  listened to longer weigh more. **Your ratings** compares every rating you
  gave with the public rating of the same works. A few sentences above the
  markers say what stands out, with how many of the works you marked as
  started are finished or marked to relisten.
- **Tags, voices, and circles**: the leading five of each, expandable to ten,
  and each opens its Library search, voice page, or circle page. **Preference**
  ranks them by how far their share of your listening time exceeds their share
  of the Library's works, and lists only those that exceed it: the bar is the
  share of listening time and the mark on it is the share of the Library.
  **Listening time** ranks them by the listening time of their works. A work
  counts in full toward each of its tags and voices.

Works are the ones the Library lists: listening to any edition of a work counts
toward that work.

A day starts at midnight in your time zone. **Automatic**, the initial
setting, follows each device: listening counts toward the current day of the
device that plays it, and a report ends on the current day of the device that
shows it. Choose a zone in **Settings → Account → Time zone** to use one zone
on every device. The foot of the page names the zone in use and links to that
setting. Listening is credited to a day when it is recorded, so changing the
time zone applies to later listening and leaves recorded days as they are.

Imported totals have no dates, so they count only in All time. The full
history, ordered by last listening time with each work's time, plays, and last
listening date, is collapsed at the bottom of the page and loads when opened.
**Clear history** and the way to **Your data** are beside it.
Time measures actual listening, excluding paused, buffering, and seek time;
speed changes do not multiply it. Concurrent players count independently.
Client interruptions or disconnection may leave some time unreported.

History stays on your server until cleared or its account/work is deleted.
Recommendation event cleanup after 90 days does not remove it. Clearing history keeps marks,
playlists and resume progress. An account counter rejects
delayed reports from before the clear.

## Export and import

Version 1 Kikoto personal JSON contains per-work listening marks, personal
ratings/notes, resume information, lifetime listening totals, work tag
assignments, custom tag definitions, and ordered favorite playlists with their
icons. Smart lists are not included. System
Marked membership is derived from marks. Circle/voice tag definitions are
included; their entity assignments and other state are outside this format.

Media, source settings, endpoints, credentials, provider metadata, raw sessions,
and daily statistics are excluded. Track titles and track/disc numbers identify
resume targets; local paths and source-local ids are not exported.

Choose a source (a Kikoto export file, a Kikoeru JSON file, a Kikoeru account,
or a Kikoeru database file), then
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
Kikoeru, up to 512 MiB, and reads only the named account's reviews. The upload
may take up to 15 minutes. Copy the
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
| `marked` | Want |
| `listening` | Listening |
| `listened` | Finished |
| `replay` | Relisten |
| `postponed` | Shelved |
| empty / null | Unmarked |

The mapping follows the upstream [Kikoeru review API](https://github.com/kikoeru-project/kikoeru-express/blob/unstable/routes/review.js).
