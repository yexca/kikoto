# Unreleased

- Settings -> Playback -> **Privacy on this device** collects device-wide
  privacy choices. Every client can hide track details from the lock screen,
  Control Center, media notifications, and screen lyrics. The iOS app blurs
  itself in the app switcher and under system screens such as Control Center,
  hides itself and closes screen lyrics while the screen is recorded or
  mirrored, and asks before starting playback through the device speaker; all
  three are on by default. The iOS app also pauses when headphones or another
  external audio output disconnect, and keeps its session in the Keychain with
  this-device-only access instead of app preferences and WebView storage; an
  existing session moves to the Keychain on the next launch.

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
- Recommendation heuristic v5 strengthens repeated positive evidence, reduces
  common-tag weight, favors weaker evidence in exploration, and mildly spreads
  creators within each listening lane. Affinity badges stay separate from
  ranking adjustments. Migration 060 preserves frozen affinity, diversity,
  and remote name matching per session.

- Narrow work cards, such as two mobile columns or six or more desktop
  columns, use tighter type and spacing. Personal tags lead a single tag row
  shared with DLsite tags, and the remaining tags open from the overflow
  control. The cover names only the first file source and counts the rest,
  and the rating and Sales row uses smaller type. A two-column phone card is
  about a fifth shorter, so a second row of works fits on screen. Wider cards
  keep their layout.

- The **Check source health** workflow in Workflows -> Remote checks every
  enabled remote source with an API endpoint and records whether it is healthy
  or unavailable, as **Check health** does in source settings. It runs
  manually or from Startup and interval triggers.
