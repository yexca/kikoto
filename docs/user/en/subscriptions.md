# Subscriptions
[English](../en/subscriptions.md) · [简体中文](../zh-Hans/subscriptions.md) · [繁體中文](../zh-Hant/subscriptions.md) · [日本語](../ja/subscriptions.md) · [한국어](../ko/subscriptions.md)

Subscriptions collects new works from the circles, series, and voice actors you
subscribe to, and works that Availability Watch finds on a remote source.

## Subscribing

- Circle, series, and voice actor pages have a bell beside **Favorite**.
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
- The cards follow the Library. **Display options** hold the cards per row and
  the **Cards** choice of **Full**, **Compact**, or **Mini**, which the Library
  and the other work collections share, and how many days a page holds: 5, 10
  (the default), or 15. Days without new works are skipped, so a page holds
  that many days that have works. A day starts at midnight in the time zone
  chosen in **Settings → Account → Time zone**, or the device's when that is
  **Automatic**.
- A card shows the work once metadata knows it, or the catalog's title,
  circle, and code until then. Open it to go to the work, add it to a favorite
  list, open DLsite, or add it to Availability Watch.
- Cards added since you last opened the feed are marked with a dot. The
  navigation shows how many there are, and opening the feed clears the count.
  A refresh that adds entries to your feed also sends one notification.
- A work released more than 30 days before your subscription started is not
  shown, so pulling an old part of a catalog later adds nothing to the feed.

## Subscription Settings

The settings icon at the top right, **Subscription settings**, opens a drawer
from the right edge, or a sheet on a phone, with two tabs: **Subscriptions** and
**Availability Watch**. Close it with the `×`, Escape, or by selecting outside
it.

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

- The **Availability Watch** tab of the settings drawer holds the shared watch pool and its configuration:
  the remote source, the action when a work becomes available, and optional
  Fetch extension exclusions; see [Workflows](workflows.md) for how a watch
  run checks a work's family. It is shown to accounts that can open Workflows.
- The subscription refresh runs the watch on its schedule; **Run** checks the
  pool now. Workflows keeps the watch's run history and links here.

## Demo

Demo shows a sample feed and subscription list with obviously fictional names
and codes. Nothing can be subscribed, refreshed, or opened.
