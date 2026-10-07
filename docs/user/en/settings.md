# Settings
[English](../en/settings.md) · [简体中文](../zh-Hans/settings.md) · [繁體中文](../zh-Hant/settings.md) · [日本語](../ja/settings.md) · [한국어](../ko/settings.md)

Settings exposes account controls, playback preferences, and recommendation preferences. Appearance is available from the header appearance menu; UI language and the preferred metadata language are in the account menu behind your avatar, or behind **Sign in**. Instance and user administration remain in Maintenance.

## Multilingual titles

Kikoto uses the first preferred metadata language that has its own manual title or DLsite edition. Its language-specific manual title wins, then the all-language manual title, then that edition’s title. An all-language title replaces only the text: the default edition, introduction, and tags stay the same as without it. `Origin` uses the original edition’s declared language; an unknown language is not guessed. If nothing matches, the original title is used. Circle, series, and voice-actor overrides remain shared across languages. An undeclared original language stays unknown everywhere, regardless of the metadata request locale; its language label shows only **Original**. A language-specific manual title takes effect for that declared language or when that manual language is explicitly preferred or selected. The language menu includes only existing editions and languages with their own manual title; an all-language title applies to existing options without adding a language.

## Current Settings

- Update the authenticated user's display name.
- Change an account-managed user's password after verifying the current
  password and confirming the replacement.
- Keep username and role visible but read-only.
- Account-backed folder preferences and recommendation tuning, shared across devices.
- Backward and forward seek intervals. They default to 10 and 30 seconds,
  respectively, and accept whole-second values from 1 through 300.
- **Playback sources**: **Quick source switching** makes the Now Playing
  source label a menu for choosing another location of the current track, and
  **Switch sources on failure** lets a failed location continue from the
  track's next available location. Both are off by default and apply
  immediately.

## Account Boundaries

Changing a password preserves the current session and revokes the user's other
sessions. An administrator password reset from Maintenance revokes every
session for the target user. Role, enabled state, username, and user lifecycle
management are not self-service account settings.

Every account, including the initial administrator, changes its own password
here. The exception is the root account in environment root account mode,
whose password comes from `KIKOTO_ROOT_PASSWORD`. A forgotten administrator
password is reset from the server host; see
[Administrator setup and recovery](../../operations/security.md#administrator-setup-and-recovery).

Demo mode keeps account-backed Settings read-only. The administration tabs
(Library, Cache & Fetch, Proxy, Cleanup, and Users), the personal History &
recommendations and Tags tabs, and the Your data section of Account stay visible for inspection even though the Demo identity is
not an administrator, and every change in them is disabled. Appearance and playback controls remain available because theme mode, style, color, seek intervals, and playback source options
are browser-local preferences and do not modify Demo server data. Playback
preferences are isolated by server identity and authenticated user, or by the
anonymous principal when anonymous access is enabled.

## Personal Playback And Recommendations

Settings uses Account, Playback, History, Recommendations, and Tags tabs, shown as icons: hover or focus an icon for its name, and phones also name the active tab. Account ends with the **Your data** export and import section; see [Personal data](personal-data.md) for listening history, tags, and data transfer. Administrators, and Demo, also see the administration tabs (Library, Cache & Fetch, Proxy, Cleanup, and Users) after a divider, so the elevated scope stays separate. Wide screens show the icons in a column beside the settings; phones show them as one row that scrolls sideways. The **Show tab names** button below the column expands it to name every tab, and Settings remembers the choice. Playback contains local seek intervals, **Playback sources**, and **Folder preference**: ordered folder matching and exclusion rules. History shows the listening report (30 days, 12 months, or all time) and a collapsed full listening history. Recommendations starts with the **Your recommendation activity** report of the signed-in user's own last 30 days (how impressions turned into opens and plays, the marks and reshuffles given, and the affinity score distribution), followed by recommendation presets, badge threshold, variation, discovery boost, and advanced scoring. These two migrated preferences are stored per authenticated account on the server; changing them never changes another account. An account without overrides and anonymous browsing retain the existing instance defaults. Old Maintenance Routing and Recommendation links open the corresponding Settings tab, and older `?tab=data` Settings links open the Your data section of Account.

Saving recommendation settings creates a new recommendation session for the current tab. Other open tabs keep their existing snapshots until a new session is created. Saving folder preferences updates subsequent directory selection without stopping the player. Failed saves retain the draft and the previous persisted values. Demo mode keeps these server-backed preferences read-only.

Appearance is available only from the header menu, and the UI language from the header account menu. The globe option follows the browser or device language; its tooltip and accessible name identify automatic selection. Every signed-in user also sees **Preferred metadata language** directly below the UI language. It is a personal choice: it decides which title edition, introduction and tag names that user sees, orders title sorting by those titles, and is asked first when Kikoto queries a remote source for that user. The options are **Origin**, Japanese, English, Simplified Chinese, Traditional Chinese, and Korean. Without a choice it shows **Origin**, each work's original language, and choosing **Origin** clears the preference; an edition without the chosen language falls back to `Origin`. Shared tag names use manual names and the learned dictionary in the same language priority, independently of whether that language has an edition. Every language shows the same tags: they come from the original edition. Anonymous visitors see the original language. Everything stored or shared, such as stored titles and tag names, background syncs, creator catalog refreshes, remote metadata fallback, and Activity text, always uses each work's original language, so one user's choice never changes what others see.

## Maintenance Organization

Maintenance uses one horizontal row of tabs, scrolling horizontally on narrow screens. Overview is removed; Library is the default for source administrators, and Users is the default for user-only administrators. Old Paths and Access links open Library and Users respectively.

- Maintenance opens with a concise administration description instead of
  repeating editable configuration values as summary statistics. Detail tabs
  retain only operational metrics such as source health, recommendation
  and quick enable state.
- Library combines library storage, local scan settings, configured remote sources, and read-only storage paths.
  **Library storage** shows the library mode (Standard or Storage pools), each
  pool with an Online or Offline badge, and the Fetch pool. Pools can be added
  or, while they hold no works, removed; the mode itself is fixed once the
  library holds local works. **Reconnect** marks an existing folder again
  after an operator confirmed the right disk is mounted there.
  **Scan depth** cannot be set below the level where Fetch saves works;
  scans always reach at least that level, so Fetched works are never reported
  missing because a scan stopped above them.
- Instance access settings appear under Users for super administrators in production and development.
  Anonymous Library browsing and playback default to disabled; changing the
  switch applies to the production access boundary and creates an audit entry.
  Development still authenticates every request as root, so the setting remains
  visible and editable there without creating an anonymous development session.
- Remote sources are a compact list: health, host, a health-check action, and an
  enable switch that saves immediately. Health-check results are persisted
  through the same source health state used by automatic probes.
- **Add source** starts from one address. Kikoto probes the address as entered,
  its origin, and the conventional `api.` sibling for a Kikoeru-compatible works
  API, then fills the API URL, public site, and name. When nothing is detected,
  **Connection details** opens for manual entry. Endpoint fields, priority, and
  network/storage options stay in collapsed groups.
- **Fallback language** is asked last, after the viewer's preferred metadata
  language, because a source may not describe works in every language. A
  viewer who keeps **Origin**, anonymous visitors, and background jobs such as
  crawls, downloads, and remote metadata fallback ask in the fallback language
  only. It defaults to Japanese. The upstream may still ignore the request or return
  mixed-language metadata.
- Remote sources default to compatible public storage hosts. Source
  configuration can enable **Restrict outbound hosts** to allow only the API,
  Public site, Fallback, and an editable list of exact or `*.example.invalid`
  public host patterns.
- Maintenance contains Library, Cache & Fetch, Proxy, Cleanup, and Users.
- **Creator catalogs** in Library holds **Catalog freshness days** (1 to 365,
  default 30), saved with its own **Save catalog settings** button. A circle
  or voice actor catalog is marked Attention once its last refresh is older
  than that. Older `/settings?tab=metadata` links open Library. There is no
  instance metadata language: each user's own choice is in the header
  account menu, and a remote source's fallback language is in its source
  settings.
- Cache & Fetch contains configuration only: playback cache policy, transfer
  safety, and collapsed download pacing, with one save action that is enabled
  after a change. Cache contents are managed in the Cleanup tab.
- Cache & Fetch includes the per-file remote media limit and the retention age
  for unpublished staging from failed or cancelled Fetch runs. The defaults are
  100 GB per media file and seven days of staging retention.
- Cache & Fetch exposes an independent transcode cache limit from 1 to
  4096 GB. It defaults to 5 GB. This rebuildable cache lives under
  `/cache/transcodes` and does not change the managed remote-media cache limit.
- The **Proxy** tab lists outbound proxies in priority order. Requests try them from
  the top and use the first one that connects. **Add proxy** chooses **Local
  machine** or **Other address**. A local-machine proxy runs where Kikoto is
  hosted: the dialog shows the address the server reaches it at (for example
  `host.docker.internal` in a container) but does not let you edit it, so only
  the protocol, port, and optional username and password are set. Other
  proxies also take an address. Protocols are HTTP, HTTPS, SOCKS5, and
  SOCKS5h. Saved passwords are never shown again; leave the field empty to keep
  one. Every change saves immediately.
- **Proxy scope** chooses where proxies apply: **DLsite** (metadata, covers,
  and creator catalogs), **Remote sources** (browsing, playback, and
  downloads), and **Other** (update checks; personal Kikoeru account imports
  always connect directly). **All**
  switches the three together. Each scope uses every proxy by priority or one
  chosen proxy. Every remote source can follow the remote-source scope, connect
  directly, or use its own proxy choice.
- **Direct connection fallback** is off by default. When off, a request whose
  proxies all fail to connect fails rather than connecting directly. When on,
  that request is retried once without a proxy, after every proxy was tried.
- Storage paths in Library are collapsed by default, read-only, and show the resolved data root, cache root, default
  cache/save previews, and per-source save previews. Remote Source configuration
  shows the same resolved example instead of exposing a path-template editor.

## Cleanup

**Cleanup** is an administrator tab in Settings, after Proxy
(`/settings?tab=cleanup`). Cache sections need `downloads:manage` and database
sections need `sources:write`.

- **Transcode cache** shows usage against its limit and offers a confirmed clear
  action.
- **Managed media cache** reports on-disk, referenced, eligible, and protected
  files, and cleans orphan or per-work cache grouped by source. Cleanup remains a
  two-step destructive action queued as a workflow run.
- **Database records** lists record types that can be removed, each with a
  current count: missing work folders and local files confirmed absent on disk
  (with the empty track entries and local availability they leave behind),
  orphaned metadata snapshots, unused source tags, expired sessions, dismissed
  notifications, finished workflow runs older than 90 days, recommendation
  signals older than 90 days, and unused recommendation snapshots. Personal
  tags, runs with reviews, Fetch records, or metadata issues, and the latest run
  of each workflow are kept. Selected tasks are removed after confirmation and
  recorded in the audit log; media files are never deleted. Expired sessions
  and eligible old workflow runs are also removed automatically once a day
  with the same rules.
- Path checks pause when the data folder is missing or empty, so an unmounted
  library is never treated as deleted.
- **Works without any source** links to Metadata's **No available source** view
  for review and deletion.
- **Compact database** rewrites the SQLite file to return free pages to disk.
  It runs in the background as a workflow run shown in Activity, and only one
  compaction can be queued or running at a time.

## Metadata

The **Metadata** icon rail groups **Works** (All, Needs attention, Metadata issues, No available source) and **Entries** (Tags, Circles, Voice actors). Wide screens can expand group and view names; phones show a scrollable icon row. Work tables retain search, pagination, selection and manual refresh, and the pencil opens the same editor as work detail. Admin and super_admin receive `library:write` for metadata, covers, metadata links, source untracking, shared tag edits, and circle identity edits.

**Tags** (`/metadata?view=tags`) lists shared concepts by their shared tag **ID**, ordered by ID so the list never depends on a language setting. The ID cell shows the DLsite genre id below the tag ID when there is one, and **Hidden** or **Merged** below that only for a hidden or merged tag; an active tag shows no status. The columns are ID, Japanese, Simplified Chinese, Traditional Chinese, English, Korean, **Other names**, Works, and Manage. Each language column shows the name that language displays: its own manual name, then the all-language manual name (shown muted), then the DLsite dictionary name, then a remote source's name, or "—" when there is none. **Other names** lists every other known name once: names a manual name replaced, with their language, names without a language, and a stored name without name records. Search matches names, including remote-source names, and a numeric query also matches the tag ID or DLsite genre id. On narrow screens the table scrolls sideways inside its own box while the Manage button stays pinned to its right edge. Manage opens manual names for all languages or a locale, global hiding, merge-target selection, and undo of the merge mapping. **Circles** (`?view=circles`) lists circles by their DLsite maker id (RG code), ordered by code; maker ids a merge brought along appear below the primary one, and circles known only from a remote source follow, shown by their Kikoto id. The columns are Code, Name (beside the latest known work's cover), Known names, Works, and Manage, and search also matches maker ids. Manage supports a manual name that survives provider refresh, confirmed aliases, and reviewed merges that move works, maker ids, catalogs, snapshots, series, and personal circle data. Undo processes the latest merge first and refuses to replace later edits to affected records. **Voice actors** lists people by Kikoto id, ordered by id, with the columns ID, Name (beside the latest work's cover), Aliases, Works, Status (catalog sync), and Manage; it retains `metadata:sync` for alias and duplicate management and the existing `/metadata?view=aliases&voice=<id>` deep link. Demo allows inspection while changes remain disabled.

Entry lists follow access to the Metadata page: sign in with at least one of `library:write`, `metadata:sync`, `sources:write`, or `system:admin`. Anonymous read access does not include these management lists. Demo shows only tags and circles related to demo works, counts only those works, and does not expose circle merge history.

Tag visibility follows the final merge target. Hiding an already merged tag stores its hidden setting for after undo; merging into a hidden target hides the resulting tag. Original names remain searchable while merged, and undo restores the original identities and search names.

Legacy cover migration and tag backfill run independently in the background after core startup workflows. A failed cover file does not stop other files. Repair failures are logged and retried next startup.

The header keeps the categories, search, and list controls on one row. On wide screens the search field sits beside the categories; on narrower screens it collapses to a search icon at the right that opens the field below the row. Refresh, rows per page, **Retry metadata**, **Check sources**, and the **Metadata settings** gear follow. Pagination above and below the list matches the Library. Metadata settings open in a popover; hover or focus an info icon for a setting's explanation, and closing it preserves the current list and filters. Start metadata sync from Workflows.

Select families and choose **Retry metadata**; its count includes only eligible selections. You can also retry an affected edition from its details, including products previously reported unavailable. Failed retries preserve existing metadata and manual overrides. **Check sources** applies to selected families without a source. Confirmed deletion of local information is available only in the **No available source** view; the server rechecks availability and retains media files.

**Open metadata issues** in Activity opens Metadata filtered to that run's unresolved metadata issues; **Show all pending works** removes the run filter. Recovery never changes another user's Activity review. Metadata recovery requires `metadata:sync`, while source checks, deletion, and source/language settings require `sources:write`. The **Metadata settings** popover contains settings only; this page does not duplicate the sync workflow's configuration or run controls. Old Maintenance links redirect here.

Metadata settings have a **DLsite proxy** shortcut: the same switch and proxy
  choice as the DLsite scope under `Settings -> Proxy -> Proxy scope`, saved
  immediately. **Manage proxies** opens that section to add or reorder proxies.
  Below it, **Catalog freshness** opens `Settings -> Library`, and
  **Remote metadata fallback** opens the Metadata
  sync workflow, whose **Configure** holds that setting.

Shared tag names try each preferred language in order: that language’s manual name, the all-language manual name, then the provider name. Detail language switching follows the same precedence.

Hide, merge and undo save their state immediately. Related works update continuously in the background; the tag manager shows the remaining instance-wide work count, including works waiting for retry. Refresh the list to check progress. A failed work retries automatically without delaying others, and updates resume after restart.

### Tag names in preferred languages

DLsite names genres in the requested language even for Japanese-only works. When any user's preferred metadata language is not Japanese, the **Learn tag names** workflow fills missing tag names in the background: for each language it asks DLsite once for the work that covers the most unnamed tags, so the number of requests depends on missing tags, not on the size of the library. It runs after startup, metadata syncs, and language changes, uses the same request pacing and DLsite proxy as metadata sync, and resumes after a restart. Progress, results, and failures appear in Activity. It stores only tag names, never titles or introductions, and does not ask again for a tag DLsite did not name.

### Remote metadata fallback

**Remote metadata fallback** is set from **Configure** on the Metadata sync workflow (`Workflows -> Metadata sync`), which administrators with `sources:write` see beside **Run**, and is off by default. When it is on, refreshing a work's metadata asks the selected remote sources, in the listed order, after DLsite explicitly reports the work as not found; timeouts and other temporary DLsite errors never trigger it. Only sources whose settings have **Provides work metadata** turned on are listed. Each source is asked once, and the first that describes the work fills its title, release date, circle, tags, and cover (a cover only when the work has none). The fallback never creates works and never fills a language DLsite lacks. While it is on, the tags of works without DLsite data join shared tags, and a remote tag matching a known tag reuses it. DLsite data always replaces remote values once available.

The listed order also decides which source wins when several remote sources describe the same work, even with the switch off. Turning the switch off stops new lookups and removes remote tags from shared tags again; titles, dates, circles, and covers already filled stay until DLsite or a manual value replaces them. Metadata issues name the source that filled a work DLsite does not have.

### Purchase bonuses

**Link purchase bonuses to their work** is set from the same **Configure** on the Metadata sync workflow and is on by default. A purchase bonus, such as an early purchase bonus (`【早期購入特典】`), is a free DLsite product that does not say which work it belongs to. When metadata sync stores such a product, it looks for the parent among the circle's works already in the library, then on the circle's DLsite page, reading at most 10 pages and checking the 5 work codes nearest the bonus. A parent is linked only when exactly one work shares the bonus's title reading, or its release date and the title quoted in the bonus marker. Bonuses already in the library are checked by the next metadata sync. When no parent is found, refreshing that work's metadata from its detail page checks again. Turning the switch off stops new detection and keeps existing links; see [purchase bonuses](work-detail.md#purchase-bonuses) for what a link changes.

## Related Docs

- [Configuration](../../operations/configuration.md)
- [Security](../../operations/security.md)
- [Sources](sources.md)

Metadata uses `/metadata`. Old `/work-management` links still work and retain their filters or settings context. First-sync failures and pending metadata results open Metadata issues; operators without workflow permission see the unscoped issue list. Run diagnostics remain in Workflows Activity.
