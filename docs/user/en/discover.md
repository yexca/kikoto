# Discover
[English](../en/discover.md) · [简体中文](../zh-Hans/discover.md) · [繁體中文](../zh-Hant/discover.md) · [日本語](../ja/discover.md) · [한국어](../ko/discover.md)

Discover is where you find what to listen to next. **For you** draws a few
works from your own library: ones you may like, ones unlike what you usually
hear, and ones worth hearing again. **New releases** collects new works from
the circles, series, and voice actors you subscribe to, and works that
Availability Watch finds on a remote source; **Rankings** follows popular
rankings and shows how they change; and **Watch** holds the works
Availability Watch waits for. The switch at the top chooses the view, and
`/discover` opens **New releases**; a dot on **Rankings** means a ranking
changed since you last looked at it. **Watch** is shown to accounts that can
open Workflows. Links to `/subscriptions` open Discover.

## Cards and Display Options

The four views show works the same way.

- A line above each card says why the work is there: why For you drew it,
  what happened in New releases and through which subscription, how long a
  work has stayed in a ranking and its best rank, or a watched work's state.
  Green marks a work that is available, amber a check that failed, and a dot
  a new release you have not seen yet.
- **Display options**, at the top right, hold the **Cards** choice and the
  cards per row for all four views. Discover keeps its own choice, apart from
  the Library's, and starts with **Compact**: a small cover beside the facts,
  in up to three columns. **Full** shows the Library's large cards, and
  **Mini** only the cover and title. Two phone columns of **Compact** cards
  show short tiles.
- The bottom of a card holds its actions, always in this order: DLsite, then
  **Watch**, your favorite lists, your rating, and **Quick mark**. Each
  appears only where it applies: **Watch** for a work your library has no
  files for (no local or cached files, and not tracked from a remote source),
  and the personal buttons for a work Kikoto knows.
- A work Kikoto has no metadata for shows its code on the cover, the title
  and circle the ranking or catalog gives, and no rating line.
- The top right always shows **Actions**, **Display options**, and
  **Subscription settings** in the same places. **Actions** works on New
  releases and Rankings and is unavailable on For you and Watch.
- Each group of cards, such as a day of New releases, a For you column, or
  the available works in Watch, starts with a heading that counts its works.

## For You

**For you** answers what to play next with small, changing sets of local
works, where the Library's **Recommended** order is a stable way to browse
all of them. Both read the same taste profile: your ratings, favorites, and
marks, as described in [Library](library.md). For you only reads it; nothing
you do in For you changes what the Library recommends.

- Three columns hold about ten works each: **Maybe like**, works you have not
  played yet that are close to what you like; **Try new**, works you have not
  played whose circles, voices, and tags you rarely hear, leaving out works
  like the ones you rated low or shelved; and **Listen again**, works you have
  played, the more likely the more you liked them (your rating, favorite,
  Relisten, and listening time) and the longer ago you played them. A work you are listening to now, or
  stopped in the last two weeks, is left to **Continue listening** in the
  Library. Works you rated one or two stars are never offered.
- A work appears in one column only. Every column holds works with local
  files; works only on a remote source or only in a catalog are not drawn.
- Above each card is why it was drawn, such as **A circle you like: …**,
  **A tag you rarely hear: …**, or **4 months since last played, rated 5**.
- With **Compact** cards on a wide screen, the three columns stand side by
  side. **Full** and **Mini** cards are too wide or too small for a third of
  the page, so the columns follow one another, each in the card grid.
- **Safe**, **Balanced**, and **Adventurous** set how far the draws stray.
  **Safe** keeps to the best matches, **Try new** stays near what you know,
  and **Listen again** offers only finished works you liked or heard more
  than once. **Adventurous** draws from every candidate, **Try new** goes as
  far from your usual listening as the library allows, and **Listen again**
  adds works you heard once or left half-finished. **Balanced**, the default,
  sits between them. The choice is saved for your account.
- **Draw again** draws its column anew from your current ratings and marks,
  leaving out what the other columns show. Each draw is random, and works
  shown recently that you neither opened nor played are drawn less often for
  three days, so the columns rotate.
- Before you have rated, favorited, or marked anything, **Maybe like** follows
  the DLsite rating and sales, and **Listen again** waits for works you play.
- On a narrow window or a phone, the switch under the temperature chooses the
  column to show.
- For you is not available in the demo.

## Subscribing

- Circle and voice actor pages have a bell beside **Favorite**; a series has
  one beside its DLsite link.
  Subscribing is separate from Favorite: a favorite records a preference, a
  subscription adds new works to **New releases** in Discover. Subscriptions
  are personal.
- A subscription starts with the catalog as it is: works already in the
  catalog are never counted as new. When the catalog was pulled recently, the
  subscription starts at once. Otherwise subscribing asks first: an account
  that may sync metadata can pull the catalog now, and the subscription starts
  when that pull succeeds; anyone else, or **Pull at next refresh**, waits for
  the next scheduled refresh. Until then the bell reads **Subscribed; waiting
  for the first catalog pull**.
- A circle subscription includes the circle's series. The bell on a series of
  a circle you subscribe to is unavailable, and subscribing to a circle lists
  the series subscriptions it replaces before it removes them.
- A voice actor's catalog comes from remote sources, so subscribing to a voice
  actor needs an enabled compatible remote source.
- Select the bell again to turn **Watch availability** on or off, open
  **Manage subscriptions**, or **Unsubscribe**. With **Watch availability** on,
  new works from that subscription are also added to Availability Watch when
  your account may edit its pool.

## New Releases

- **New releases** groups works by the day they reached your feed, newest day
  first, with one card per work family. Each day starts a new row, and its
  heading shows the date and how many works it has. Above each card are what
  happened and through which subscription. The events are:
  - **New release**: a new work appeared in a subscribed catalog.
  - **New edition**: a new language edition of a work released long before,
    such as a translation.
  - **Now available**: Availability Watch found the work on a remote source.
    Every account that can open Workflows receives these.
  A family with several events keeps one card, on the day of its newest event.
- **Display options** also choose how many days a page holds: 5, 10 (the
  default), or 15. Days without new works are skipped, so a page holds that
  many days that have works. A day starts at midnight in the time zone chosen
  in **Settings → Account → Time zone**, or the device's when that is
  **Automatic**.
- A card shows the work once metadata knows it, or the catalog's title,
  circle, and code until then. Accounts that can run workflows and sync
  metadata can select **Watch** to add a work the library does not have to
  Availability Watch; a work already in the watch pool shows **Watching**
  instead.
- **Actions** syncs the metadata of the works on the page or checks their
  sources; see
  [Syncing and checking shown works](#syncing-and-checking-shown-works).
- Cards added since you last opened the feed are marked with a dot. The
  navigation shows how many there are, and opening the feed clears the count.
  A refresh that adds entries to your feed also sends one notification.
- A work released more than 30 days before your subscription started is not
  shown, so pulling an old part of a catalog later adds nothing to the feed.

## Rankings

- **Rankings** follows DLsite voice rankings and the popular lists of
  compatible remote sources. Every account sees the same rankings. The toolbar
  above the list stays in reach while you scroll, so you can switch ranking,
  order, or filter from anywhere in the list.
- The toolbar's first row chooses the ranking, grouped by where it comes from:
  **DLsite** with **24 hours**, **7 days**, **30 days**, **Annual**, and **All
  time**, then each remote source with its **Popular** list, in the sources'
  order. A dot on a ranking means the order it shows changed since you last
  opened it. The annual rankings share **Annual**, with a **Year** choice
  beside it. On a phone, the row scrolls sideways.
- **Popularity** and **Sales** choose how a DLsite ranking is ordered, and
  **Released within 30 days**, on the 24-hour, 7-day, and 30-day rankings,
  keeps only works released within the last 30 days. Each choice is a ranking
  of its own, with its own updates, history, and seen state. The address keeps
  the choice, so a link opens the same order and Back returns to the previous
  choice; each ranking opens in the choice you last made on it on this device.
- **All**, **New**, **Moved**, **Not in library**, and **On a source**, beside
  the order, narrow the list and show how many works each keeps. **Not in
  library** keeps works your library has no files for: no local or cached
  files, and not tracked from a remote source. **On a source** keeps works a
  remote source is known to have. On a phone, the order and the filters share
  one row that scrolls sideways.
- The status at the end of the toolbar, such as **Updated 12:31 PM · vs your
  last visit**, says when the ranking was last updated and what it is compared
  with. Select it for the full times and **Compare with**: your last visit,
  the **Previous update**, or **Another time**. Opening the latest update
  records it as seen. Accounts that may sync metadata can pull the shown
  ranking again with the refresh button.
- Each work's card sits beside its rank. Under the rank, **New** marks a work
  that was not in the ranking before, **Back** a work that returns after
  leaving it, and an arrow how many places a work moved; a work that did not
  move shows nothing there. The line above the card states only what is worth
  knowing: how many days a work has stayed in the ranking when that is more
  than one, and its best rank when it once ranked higher. The cover's source
  marks show whether your library has the work. **Dropped out** at the end
  opens the works that left, with their former rank.
- A work Kikoto knows shows its title, cover, rating, and tags and opens as in
  the Library. Any other work shows the title and circle the ranking lists,
  and the cover when Kikoto already has it. Open a work to look it up, or
  select **Watch** to add a work that is not in the library to Availability
  Watch; **Watching** marks a work already in the watch pool. A work from a
  remote source's list opens on that source.
- Updating a ranking only records its order: it never adds works, syncs their
  metadata, checks sources, or tags them. **Actions**, at the top right of
  Discover, does that for the order shown when you ask; see
  [Syncing and checking shown works](#syncing-and-checking-shown-works).
  **On a source** then keeps the works a source has.
- When the latest update failed or a remote source is unavailable, the
  ranking keeps showing its last successful update and says so.
- A finished year of the annual ranking shows its final order: ranks without
  New, Back, or movement, the days in the ranking, or best ranks, with **All**,
  **Not in library**, and **On a source**. The toolbar says when the final
  order was recorded.

### History

- **History**, the clock beside the refresh button, shows a ranking as it was
  at an earlier time. Choose a **Date**, then one of that day's updates, or
  step with **Previous update** and **Next update**. While an earlier time is
  shown, a banner under the toolbar says so, and **Back to latest** returns to
  the current order. The address keeps the time, so a link opens the same
  view.
- A past order is compared with the update before it, and the days in the
  ranking and best ranks are hidden. Looking at history does not mark a
  ranking as seen.
- Times and days follow the time zone chosen in **Settings → Account → Time
  zone**, or the device's when that is **Automatic**, as in New releases.
  History shows when the order was pulled and last confirmed. When no pull ran
  between that confirmation and the chosen time, it says so.
- For dates before the full history, only the order at the end of each day is
  kept, and History says so.

## Watch

- **Watch** shows the Availability Watch pool, which every account that can
  open Workflows shares. At the top are how many works it watches, how many
  are available, not available, or failed their last check, and when it last
  checked one. To watch more works, paste one or more codes into the field
  beside them and select **Add**; codes already watched and text that is not
  a work code are reported and left out.
- **Available** comes first and lists every work a remote source offers.
  **Not available** lists the works still waiting for a source, those whose
  last check failed first. When there are many, it shows their first two
  rows of cards, or more rows on a narrow screen, and **Show all**.
- A watched work need not be in the library, so its card shows the code and
  the title and cover Kikoto knows for its family. The line above it shows
  its state, then the remote source for an available work, with the edition
  found when it is another edition of the family, when it was last checked
  for a waiting work, or why the last check failed.
- Select a card to open the work's family: every known edition, which one a
  remote source offers, and **Open**, **Track**, and **Remove from watch**.
- The `×` at the end of the line above a card removes the work from the pool
  after a second press. **Clear completed**, beside **Available**, removes
  after a second press every work whose Track or Fetch has started.
- Adding and removing works needs the permissions of the action the watch is
  configured with; see [Availability Watch](#availability-watch).

## Syncing and checking shown works

**Actions**, at the top right of Discover, works on the works New releases or
Rankings shows, only when you ask. Each action takes only the works that still need it, at
most 100 at a time, and says so when none does.

- **Sync metadata**, for accounts that may sync metadata, syncs DLsite metadata
  for the works without it and those synced more than a day ago. Works Kikoto
  does not know yet are added with their title, cover, rating, and tags, but
  without files, so a ranking still shows them as **Not in library**.
- **Check sources**, for accounts that may track remote works, asks each
  enabled compatible remote source which works it has. It skips works with
  files, works already known to be on a source, and works checked in the last
  day. A source that has a work shows on its card. For a work Kikoto knows,
  the answer is kept as its source; for the others, it lasts until you leave
  the page.

Both run in the background. A line above the works shows the run with **View
run**, and the page reloads when it ends.

## Subscription Settings

The settings icon at the top right, **Subscription settings**, opens the
settings with three tabs: **Subscriptions**, **Rankings**, and **Availability
Watch**. On a wide screen they open in a panel beside the view, which narrows
to make room and stays usable; on a narrower screen they open in a drawer from
the right edge, or a sheet on a phone. They open on the tab of the view:
**Subscriptions** from New releases, **Rankings** from Rankings, and
**Availability Watch** from Watch. Close them with the `×` or Escape; the
settings icon also closes the panel, and selecting outside closes a drawer or
sheet.

- **Subscriptions** lists your circle, series, and voice actor subscriptions
  with their state (**Active** or **Waiting for first pull**), when the catalog
  was last pulled, and their **Watch availability** option.
- **Refresh schedule** is shared by every account. One refresh pulls each
  subscribed catalog once, syncs the metadata of new works, adds them to the
  subscribers' feeds, and then checks Availability Watch. A catalog pulled in
  the last six hours, for example by a detail page refresh, is not pulled
  again, and one refresh syncs at most 60 new works; the rest wait for the
  next refresh.
- Accounts that may sync metadata can turn **Refresh automatically** on or off,
  choose **Refresh every** (1 hour to 7 days; 24 hours by default), choose
  whether each refresh checks Availability Watch, and **Refresh now**. **View
  the latest run** opens the refresh in Activity.

## Availability Watch

- The **Availability Watch** tab of the settings holds the watch's
  configuration: the remote source, the action when a work becomes
  available, and optional Fetch extension exclusions; see
  [Workflows](workflows.md) for how a watch run checks a work's family. The
  works it watches are in the [Watch](#watch) view. The tab is shown to
  accounts that can open Workflows.
- The subscription refresh runs the watch on its schedule; **Run** checks the
  pool now. Workflows keeps the watch's run history and links here.
- A notification about newly available works opens **Watch** at its
  **Available** works.

## Ranking Settings

The **Rankings** tab lists every ranking Kikoto can follow. Accounts that may
sync metadata change them; others can only read them.

- The top line says that rankings are shared by every account and when one was
  last pulled. **Refresh all** pulls every shown ranking now. **Latest DLsite
  pull** and **Latest remote source pull** open those runs in Activity.
- **DLsite voice rankings** has, in the order of the Rankings toolbar, a row
  for 24 hours, 7 days, and 30 days, **Annual** for the year in progress,
  **Earlier years**, and **All time**. A pull of a DLsite ranking pulls each
  of its orders. **Remote source popular lists** has a row for each enabled
  compatible remote source.
- Each row starts with its **Show** switch, followed by when the ranking was
  pulled and is next pulled, such as **Pulled 12 min. ago · next in 48 min.**,
  and a warning when the last pull failed or the source is unavailable.
  Showing a ranking for the first time starts it and queues its first pull. A
  ranking that is not shown is dimmed and keeps only its switch.
- The summary at the end of a shown row, such as **Every hour · Top 100**,
  opens the row in place: **Pull automatically** with its interval, how many
  places to keep (**Top 10** to **Top 100**), **Pull now** for this ranking
  alone, and **Delete with history…**, which asks before it deletes the
  ranking and every update recorded for it.
- A refresh requested during a pull is queued for the next run. Cancelling a
  pull stops that run; automatic pulls continue on their schedule.
- Each ranking is pulled on its own schedule:

  | Ranking | Default | Choices |
  | --- | --- | --- |
  | 24 hours | 1 hour | 20 minutes to 24 hours |
  | 7 days | 6 hours | 1 hour to 7 days |
  | 30 days | 24 hours | 6 hours to 7 days |
  | Annual, year in progress | 7 days | 24 hours to 30 days |
  | All time | 7 days | 24 hours to 30 days |
  | Remote source popular list | 24 hours | 1 hour to 7 days |

  DLsite updates its 24-hour ranking every 20 minutes, its 7-day ranking
  hourly, and its 30-day ranking daily. A failed pull, or one in which some
  orders failed, is tried again after an hour, then two, and so on, never
  later than the ranking's interval; an order that failed keeps showing its
  last update. An order that did not change adds no new update.
- From 3 January in Japan, the final order of the annual ranking of the year
  in progress is pulled once, by popularity and by sales, and kept. With
  **Continue with the next year**, in its opened row and on by default, the
  next year's ranking then starts with the same settings.
- **Earlier years** lists the years already added on one line and opens their
  rows. **Add years** adds earlier years, which are pulled once and kept as
  their final order.
- **History** states how long history is kept, such as **Every change for 30
  days, then daily for 1 year**. Select it to choose **Keep every change for**
  (30 days by default) and **Then keep each day's order for** (1 year by
  default, or **Forever**). The daily order is the one at the end of each day
  in Japan. Finished annual rankings, the latest order, and the update each
  account last viewed are always kept. Older updates are removed by the
  [Database records](settings.md) cleanup.

## Demo

Demo shows a sample feed, subscription list, and sample rankings with a
short history and obviously fictional names and codes. Nothing can be
subscribed, refreshed, or opened.
