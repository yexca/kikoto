# Subscriptions
[English](../en/subscriptions.md) · [简体中文](../zh-Hans/subscriptions.md) · [繁體中文](../zh-Hant/subscriptions.md) · [日本語](../ja/subscriptions.md) · [한국어](../ko/subscriptions.md)

Subscriptions collects new works from the circles, series, and voice actors you
subscribe to, and works that Availability Watch finds on a remote source. Its
**Rankings** view follows popular rankings and shows how they change. The
switch at the top chooses **New releases** or **Rankings**; a dot on
**Rankings** means a ranking changed since you last looked at it.

## Subscribing

- Circle and voice actor pages have a bell beside **Favorite**; a series has
  one beside its DLsite link.
  Subscribing is separate from Favorite: a favorite records a preference, a
  subscription adds new works to the Subscriptions feed. Subscriptions are
  personal.
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
- The cards follow the Library. **Display options** hold the **Cards** choice
  of **Full**, **Compact**, or **Mini**, which the Library and the other work
  collections share, the cards per row, and how many days a page holds: 5, 10
  (the default), or 15. Days without new works are skipped, so a page holds
  that many days that have works. A day starts at midnight in the time zone
  chosen in **Settings → Account → Time zone**, or the device's when that is
  **Automatic**.
- A card shows the work once metadata knows it, or the catalog's title,
  circle, and code until then. Open it to go to the work, add it to a favorite
  list, or open DLsite. Accounts that can run workflows and sync metadata can
  also add it to Availability Watch.
- Cards added since you last opened the feed are marked with a dot. The
  navigation shows how many there are, and opening the feed clears the count.
  A refresh that adds entries to your feed also sends one notification.
- A work released more than 30 days before your subscription started is not
  shown, so pulling an old part of a catalog later adds nothing to the feed.

## Rankings

- **Rankings** follows DLsite voice rankings and the popular lists of
  compatible remote sources. Each shown ranking is a chip above the list, in a
  fixed order: **24 hours**, **7 days**, **30 days**, **Annual**, and **All
  time**, then each remote source's **Popular** list in the sources' order. A
  dot on a chip means the order it shows changed since you last opened it. The
  annual rankings share one **DLsite · Annual** chip with a **Year** choice.
  Every account sees the same rankings.
- **Popularity** and **Sales** choose how a DLsite ranking is ordered, and
  **Released within 30 days**, on the 24-hour, 7-day, and 30-day rankings,
  keeps only works released within the last 30 days. Each choice is a ranking
  of its own, with its own updates, history, and seen state. The address keeps
  the choice, so a link opens the same order and Back returns to the previous
  choice; each chip opens in the choice you last made on it on this device.
- A ranking shows when it was last updated and lists its works in rank order.
  Beside each rank, **New** marks a work that was not in the ranking before,
  **Back** a work that returns after leaving it, and an arrow how many places a
  work moved. Above each card are the days the work has stayed in the ranking
  and its best rank. **Dropped out** at the end lists the works that left,
  with their former rank.
- Changes are measured against your last visit. **Compare with** chooses the
  previous update or **Another time** instead. Opening the latest update
  records it as seen.
- **All**, **New**, **Moved**, and **Not in library** narrow the list.
  **Not in library** keeps works with no entry in your library.
- A work in your library shows its card as in the Library. Any other work
  shows the title and circle the ranking lists, and the cover when Kikoto
  already has it. Rankings never add works to the library, sync their
  metadata, or tag them; open a work to look it up, open DLsite, or add it to
  Availability Watch. A work from a remote source's list opens on that source.
- When the latest update failed or a remote source is unavailable, the
  ranking keeps showing its last successful update and says so.
- A finished year of the annual ranking shows its final order: ranks without
  New, Back, or movement, the days in the ranking, or best ranks, with **All**
  and **Not in library**.

### History

- **History** shows a ranking as it was at an earlier time. Choose a **Date**,
  then one of that day's updates, or step with **Previous update** and **Next
  update**; **Latest** returns to the current order. The address keeps the
  time, so a link opens the same view.
- A past order is compared with the update before it, and the days in the
  ranking and best ranks are hidden. Looking at history does not mark a
  ranking as seen.
- Times and days follow the time zone chosen in **Settings → Account → Time
  zone**, or the device's when that is **Automatic**, as in New releases. The
  page shows when the order was pulled and last confirmed. When no pull ran
  between that confirmation and the chosen time, it says so.
- For dates before the full history, only the order at the end of each day is
  kept, and the page says so.

## Subscription Settings

The settings icon at the top right, **Subscription settings**, opens the
settings with three tabs: **Subscriptions**, **Availability Watch**, and
**Rankings**. On a wide screen they open in a panel beside the feed or the
rankings, which narrow to make room and stay usable; on a narrower screen they
open in a drawer from the right edge, or a sheet on a phone. They open on
**Rankings** from the Rankings view. Close them with the `×` or Escape; the
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

- The **Availability Watch** tab of the settings holds the shared watch pool and its configuration:
  the remote source, the action when a work becomes available, and optional
  Fetch extension exclusions; see [Workflows](workflows.md) for how a watch
  run checks a work's family. It is shown to accounts that can open Workflows.
- The subscription refresh runs the watch on its schedule; **Run** checks the
  pool now. Workflows keeps the watch's run history and links here.

## Ranking Settings

The **Rankings** tab lists every ranking Kikoto can follow. Accounts that may
sync metadata change them; others can only read them.

- **DLsite voice rankings** has, in the order of the chips, a row for 24
  hours, 7 days, and 30 days, the **DLsite annual ranking** of each year, and
  **All time**. A pull of a DLsite ranking pulls each of its orders.
  **Remote source popular lists** has a row for each enabled compatible remote
  source.
- Each row has **Show**, **Auto** with its pull interval, how many places to
  keep (**Top 10** to **Top 100**), and when it was last and will next be
  pulled. Showing a ranking for the first time starts it and queues its first
  pull. The remove button deletes a ranking with its history.
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
- **DLsite annual ranking** has a row for the year in progress. From 3 January
  in Japan, its final order is pulled once, by popularity and by sales, and
  kept. With **Continue with the next year**, on by default, the next year's
  ranking then starts with the same settings. **Add years** adds earlier
  years, which are pulled once and kept as their final order.
- **Refresh all now** pulls every shown ranking now. **View the latest DLsite
  pull** and **View the latest remote source pull** open those runs in
  Activity.
- **History** keeps every change for **Keep every change for** (30 days by
  default), then the order at the end of each day in Japan for **Then keep
  each day's order for** (1 year by default, or **Forever**). Finished annual
  rankings, the latest order, and the update each account last viewed are
  always kept. Older updates are removed by the
  [Database records](settings.md) cleanup.

## Demo

Demo shows a sample feed, subscription list, and sample rankings with a
short history and obviously fictional names and codes. Nothing can be
subscribed, refreshed, or opened.
