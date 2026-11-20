# App Shell

How the shell groups navigation, lays out the header and its panels, insets
sheets and pages from the system bars, and starts.

## Navigation Groups

The shell separates listening from managing. Each navigation destination
declares a group in `app/navigation`: `browse` pages (Library, Favorites,
Circles, Voice Actors) are the listening collections, `explore` pages (Record,
For you, Discover) are the listening destinations beyond them, `personal`
pages belong to the signed-in account, `manage` pages are administration, and
`app` pages (About) describe Kikoto itself. The desktop sidebar
(`app/AppSidebar`) lists the browse pages, then below a hairline the explore
pages; below another hairline, the collapsible groups that `navigationGroups` declares:
**Personal**, holding Insights, Tags, and Settings, and **Manage**, holding
Workflows, Metadata, Translation, Cleanup, and System; and below another
hairline the `app` pages. The sidebar renders a group from its declaration and the pages that
name it, so a new page joins a group by declaring it. Each group is collapsed
by default, remembers its expanded state in browser storage, and opens while
one of its pages is current; collapsed, it still marks the current page. An
account that can open none of a group's pages does not see the group. The icon
rail that the sidebar collapses to keeps the same structure.

## Header and Panels

On phones, the app header holds Notifications (when authenticated) and the
account avatar, or Sign in for anonymous visitors; Appearance opens as a view
of the account panel there (`HeaderActions` passes the controls in). Wider
screens group Quick actions, Notifications, and Appearance in one header tray
before the avatar, which shows the display name on extra-wide screens but
never the role. Quick actions is always an icon button, never a search field,
so it is not confused with library search; its tooltip names the keyboard
shortcut. It opens the searchable Command Palette, a bottom sheet on phones
and a centered surface on desktop; Notifications, Appearance, and the account
panel are anchored popovers. Appearance (`app/ThemeTrigger`) is one palette
icon whose tooltip states the current mode, style, and color; its popover owns
only those three choices. Quick actions lists every destination the viewer can
open, in every group.

The account panel (`app/header/AccountPanel`) opens from the avatar, or from
Sign in for anonymous visitors, on every screen size. A compact profile leads
it, naming the handle only where it differs from the display name. Where the
sidebar is shown, three shortcut tiles under the profile open Discover,
Insights, and Tags (`accountShortcutIds` in `app/navigation`); the sidebar
keeps these pages in their own groups, so the tiles repeat them. Below the
sidebar breakpoint a three-column grid of the same tiles holds the pages the
bottom navigation does not carry, such as Record, For you, Discover, Insights,
and Tags, and on phones Quick actions; the wide tiles do not appear there, so
no destination is listed twice. One list follows: Settings, which concerns
the account and so stays a list entry; one **Manage** entry that opens the
Manage pages as a view of the panel and names the current page while it is
one of them; **Appearance** on phones; **Language**; and in the native shell
one server entry with a status dot that opens the connection details and
recovery actions as a view. Appearance, Language, and the server each open a
view of their own and show their current value on the entry. About and
Sign out share the closing row; a Dev or Demo session shows its note in place
of Sign out. While a page or a tile is current, its entry and the account
trigger carry the selected state. A signed-in user also chooses the personal preferred metadata language
in the Language view:
**Origin** is shown when the user has no preference and choosing it clears the
stored preference, and a saved change refreshes the routed page through the
user preference event. Demo keeps the choice in browser storage scoped to the
server and Demo user, and the API client sends it with authenticated requests
(see [Metadata Language](../data-model/work-metadata.md#metadata-language)).

The notification panel (`app/header/NotificationCenter`) splits personal workflow
notifications (**Updates**) from the global **Needs attention** runs for
workflow operators, shows the newest running job above both, and ends in an
**Open Workflows** button. Its badge counts unread notifications plus runs needing attention,
and a dot marks running work. It polls every 30 seconds, every 5 seconds while
open over a running job, and skips hidden documents.

The header owns the desktop page title and carries no description, so page
content owns any additional context it needs. Mobile browsing destinations use
the bottom navigation as their location cue and show a compact Kikoto mark
instead; other destinations retain a single-line title.

## Sheets and Safe Areas

`MobileSheet` is the shared bottom-sheet primitive. It animates in from the
bottom and out toward the bottom, supports Escape and outside dismissal, and
accepts a downward drag on its handle to close. A sheet's height stops below
the top safe-area inset with a strip of page left above it, so its handle stays
reachable and an outside tap can always dismiss it. Its default layer is
transparent so sheet content does not add a backdrop mask. The shared
`MobileSheetHeader` and `MobileSheetBody` keep command and catalog-options
sheets on the same bordered header and compact scrolling body treatment. Mobile
command and catalog-options sheets rely on sheet dismissal rather than an
in-content close icon; desktop command surfaces may retain an explicit close
action. Centered dialogs pad their backdrop by the safe-area insets and cap
their height to the space between them, so a tall dialog's header and close
action never sit under the status bar or notch.

The page alone pads for the system bars. Both native shells draw the WebView
under the status bar, and the `--safe-area-*` tokens give each surface the
inset to clear. The Android shell (`KikotoSystemInsets`) lays every Android
version out edge to edge, adds no native padding for a bar, and publishes the
bar sizes as `--native-safe-area-*` variables; each token takes the larger of
that variable and `env(safe-area-inset-*)`, so a WebView that reports the
insets itself still gets them once. With the keyboard open, the shell ends the
WebView above the keyboard and reports no bottom inset.

## Startup and Server Connection

At startup, the authentication provider loads current-user and public runtime
settings before mounting the application shell or global player. A production
client without a user sees the full-page sign-in surface when anonymous access
is disabled; when it is enabled, the same client enters the read-only-capable
Library shell. Stored theme mode, style, and color are applied before React
renders, including on the sign-in and Demo surfaces.

Native server health checks omit both bearer credentials and cookies and reject
redirects. Switching the normalized server URL, including its base path, clears
the old credential in browser storage and native preferences before publishing
the new server configuration. Re-selecting the same server retains its session.
