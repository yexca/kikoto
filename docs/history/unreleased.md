# Unreleased

- Settings → History becomes a listening dashboard: totals with derived
  figures (time per active day and per play, the top work's share, and the
  share of active days), the activity chart, a ranked bar list of the most
  listened works with their share of the time, and a Rhythm panel with the
  current and longest listening streaks and the average per weekday. The full
  history lists works as compact rows with plays and the last listening date.
  The page no longer scrolls far past its content.

- Settings → Library opens with a Libraries list of the local library (storage
  mode and online state) and the remote sources, followed by the library
  settings.

- The add-to-list menu on every work card can create a list in place, as on
  work detail. Work detail can hide the folder column beside the directory
  and remembers the choice on the device.

- Availability Watch treats a watched code as a work family. Before checking
  a code, a run refreshes its DLsite family metadata (at most once a day), and
  the work becomes available when a remote source offers any of its language
  editions; Track, Fetch, and Open use the edition that was found. The
  configuration is edited in place and stored with `Save` beside `Run`. The
  Monitoring and Ready pools become one watch pool with a summary, quick
  entry of pasted codes, Not available and Available sides, two-step removal,
  and a view of each work's family. Migration 065 records the found edition
  and the family refresh time on each watch target.

- Recommendation badges show every scored work's score in the Library and on
  remote sources. The badge threshold setting becomes the highlight threshold:
  scores at or above it keep the emphasized badge, and lower scores appear
  muted. The score explanation shows the score on a gauge with the threshold
  marked, the score composition as one stacked bar, and ranking adjustments on
  a centered scale, and suggests favoriting or marking Relisten when no
  preference evidence exists yet. Recommendation settings preview an
  adjustable example work's score live, show how ordering variety can move
  it, and replace the advanced number fields with a proportional mix bar, a
  possible score range, and per-match step meters with sliders.

- Demo visitors can choose the preferred metadata language in the account
  menu. The choice stays in that browser, so one visitor's choice never changes
  what another visitor sees.

- Settings on wide screens can show its tabs as a row above the content
  instead of the side column, and the Settings and Metadata rails name their
  tabs by default; a choice saved earlier on the device is kept. On phones the
  Settings and Metadata tab rows no longer scroll vertically by a few pixels.

- The Android and iOS apps add **Privacy on this device** in Settings →
  Playback, stored for the device across every server and account. Recent
  apps and the iOS app switcher show a cover instead of the current page, the
  system media controls hide the cover (on Android while the device is
  locked), and playback through the device speaker waits for a confirmation
  when no headphones are connected. All three are on by default; the media
  controls can also show everything or only the app name. An opt-in choice
  blocks screenshots, recording, and casting of the Android app and its
  floating lyrics; on iOS it covers the app and closes screen lyrics while the
  screen is recorded or mirrored. Android also offers an opt-in app lock that
  unlocks with a biometric or the device screen lock after a chosen time in
  the background. Disconnecting headphones closes the Android floating lyrics,
  and signing out or switching servers clears the Android app's web cache.

- The iOS app pauses when headphones or another external audio output
  disconnect, and keeps its session in the Keychain with this-device-only
  access instead of app preferences and WebView storage; an existing session
  moves to the Keychain on the next launch.

- The release workflow builds an unsigned iOS IPA on a macOS runner alongside
  the signed APK and attaches it to the GitHub Release as
  `kikoto-<version>-unsigned.ipa`. The draft is published only after the image,
  APK, and IPA all succeed. Sideloading tools re-sign the IPA at install time.

- Explicit personal-progress imports protect their cursor from earlier offline
  reports, while later playback and backward seeks remain writable. Resume-cache
  updates reject superseded confirmations across original and translated editions.

- Playback progress and listening history share a 30-second periodic report.
  A bounded server/account-scoped IndexedDB outbox restores unconfirmed reports
  after reload, preserves backward-seek ordering, and retries temporary failures
  without inflating cumulative time or counts. Offline listening uses its actual
  UTC dates. Migration 062 preserves existing personal records and adds ordered
  cursors and cumulative session dates; legacy report APIs remain available.

- Remote recommendation badges score both known and transient works from the
  displayed page in one batch and appear progressively. Toggling badges does
  not reload the remote source; a scoring failure keeps the cards available and
  offers a retry.
- Recommendation heuristic v6 retains the affinity rules while using a shared
  versioned feature catalog, frozen sparse user profiles, bounded recall and
  candidate ranking. Each listening lane shows candidates first, followed by
  every remaining matching work in stable exploration order; totals and exact
  search priority remain complete. Ordinary-page badges and detail explanations
  compute real affinity without per-user full-library score snapshots.
- Migration 063 queues shared catalog backfill without rebuilding the database
  or deleting user feedback and listening history. Until the first complete
  epoch publishes, ordinary browsing and playback work and recommendation
  preparation offers Retry. Later updates serve the last published epoch.
  Algorithm-version binding renews old recommendation sessions, and bounded
  background cleanup removes obsolete derived score caches and unreferenced
  versions while protecting active generations. Back up the database before
  upgrading as described in [Database](../operations/database.md).

- Narrow work cards, such as two mobile columns or six or more desktop
  columns, use tighter type and spacing. Personal tags lead a single tag row
  shared with DLsite tags, and the remaining tags open from the overflow
  control. The cover names only the first file source and counts the rest,
  and the rating and Sales row uses smaller type. A two-column phone card is
  about a fifth shorter, so a second row of works fits on screen. Wider cards
  keep their layout.

- The **Check works on a source** workflow in Workflows -> Remote asks one
  remote source whether library works exist there and records the result on
  each work. It checks local library works or all works in the database, by
  default only those without an available remote source, up to a chosen number
  of works per run, starting with works the source has never checked. It first checks the
  source's health and records nothing for works when the source is
  unavailable. It runs manually or from Startup and interval triggers. It
  replaces the non-runnable **Check source health** entry; **Check health** in
  source settings is unchanged.
