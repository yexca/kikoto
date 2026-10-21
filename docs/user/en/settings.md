# Settings
[English](../en/settings.md) · [简体中文](../zh-Hans/settings.md) · [繁體中文](../zh-Hant/settings.md) · [日本語](../ja/settings.md) · [한국어](../ko/settings.md)

Settings holds account controls, personal playback, recommendation, and tag preferences, and, for administrators, instance administration. Appearance is in the header appearance menu; UI language and the preferred metadata language are in the account menu behind your avatar, or behind **Sign in**.

## Tabs

Settings uses Account, Playback, Recommendations, and Tags tabs, shown as icons: hover or focus an icon for its name, and phones also name the active tab. Administrators, and Demo, also see the administration tabs (Library, Cache & Fetch, Proxy, LLM & ASR, Cleanup, and Users) after a divider, so the elevated scope stays separate. Wide screens show the tabs in a column beside the settings, with every tab named; phones show them as one row that scrolls sideways. Below the column, **Hide tab names** collapses it to icons and **Show tab names** expands it again. **Show tabs above** moves the tabs into one row above the settings. The row names every tab when there is room; otherwise it names the group holding the open tab (the personal or the administration tabs) and shows the other group as icons, and on the narrowest wide screens it names only the open tab. If even that does not fit, the row wraps onto a second line. The icon at the end of that row, **Show tabs beside**, returns them to the column. Settings remembers both choices on that device.

`/maintenance`, `/users`, `/cleanup`, `/tags`, and `/user-data` links open the matching Settings tab. `/history` and `/settings?tab=history` open [Insights](personal-data.md#insights).

## Account

- Update the authenticated user's display name.
- Change an account-managed user's password after verifying the current
  password and confirming the replacement.
- Username and role are visible but read-only.
- **Time zone** decides where a day starts in your listening report and the
  Subscriptions feed. **Automatic** follows the device you are using; choosing
  a zone uses it on every device. See [Insights](personal-data.md#insights).
- **Your data** at the end of Account exports and imports personal data; see
  [Personal data](personal-data.md).

Changing a password preserves the current session and revokes the user's other
sessions. An administrator password reset from Settings -> Users revokes every
session for the target user. Role, enabled state, username, and user lifecycle
management are not self-service account settings.

Every account, including the initial administrator, changes its own password
here. The exception is the root account in environment root account mode,
whose password comes from `KIKOTO_ROOT_PASSWORD`. A forgotten administrator
password is reset from the server host; see
[Administrator setup and recovery](../../operations/security.md#administrator-setup-and-recovery).

## Playback And Recommendations

- **Playback** contains the backward and forward seek intervals, **Loudness
  normalization**, **Playback sources**, and **Folder preference**. Seek
  intervals default to 10 and 30 seconds and accept whole-second values from 1
  through 300. The Android and
  iOS apps also show **Privacy on this device**, described in
  [Sleep and headphone privacy](playback.md#sleep-and-headphone-privacy).
- **Loudness normalization** is off by default. **Turn loud tracks down**
  lowers loud tracks, and **Turn loud tracks down and quiet tracks up** also
  raises quiet ones; see [Playback](playback.md#current-behavior). The choice
  is stored per server and user in the browser and applies from the next
  measured track.
- **Playback sources**: **Quick source switching** makes the Now Playing
  source label a menu for choosing another location of the current track, and
  **Switch sources on failure** lets a failed location continue from the
  track's next available location. Both are off by default and apply
  immediately.
- **Folder preference** holds ordered folder matching and exclusion rules.
  Saving updates subsequent directory selection without stopping the player.
- **Recommendations** starts with the **Your recommendation activity** report
  of the signed-in user's own last 30 days (how impressions turned into opens
  and plays, the marks and reshuffles given, and the affinity score
  distribution), followed by recommendation presets, a live preview, ordering
  variety, and advanced scoring. The live preview scores an adjustable example
  work on a gauge beside the highlight threshold and shows its composition;
  ordering variety shows how variation and discovery boost can move that
  example's ranking. Advanced scoring shows the mix slots as one proportional
  bar, the possible score range, and each tag, voice, and circle weight as a
  meter of per-match steps up to its cap. Saving creates a new
  recommendation session for the current tab; other open tabs keep their
  snapshots until a new session is created.

Folder preferences, recommendation settings, and a chosen time zone are stored per
authenticated account on the server and shared across devices; changing them never changes
another account. Accounts without their own values, and anonymous browsing,
use the instance defaults. Failed saves keep the draft and the persisted
values.

## Language And Appearance

Appearance is available only from the header menu, and the UI language from the header account menu. The globe option follows the browser or device language; its tooltip and accessible name identify automatic selection. Every signed-in user also sees **Preferred metadata language** directly below the UI language. It is a personal choice: it decides which title edition, introduction and tag names that user sees, orders title sorting by those titles, and is asked first when Kikoto queries a remote source for that user. The options are **Origin**, Japanese, English, Simplified Chinese, Traditional Chinese, and Korean. Without a choice it shows **Origin**, each work's original language, and choosing **Origin** clears the preference; an edition without the chosen language falls back to `Origin`. Shared tag names use manual names and the learned dictionary in the same language priority, independently of whether that language has an edition. Every language shows the same tags: they come from the original edition. Anonymous visitors see the original language. Everything stored or shared, such as stored titles and tag names, background syncs, creator catalog refreshes, remote metadata fallback, and Activity text, always uses each work's original language, so one user's choice never changes what others see.

### Multilingual titles

Kikoto uses the first preferred metadata language that has its own manual title or DLsite edition. Its language-specific manual title wins, then the all-language manual title, then that edition’s title. An all-language title replaces only the text: the default edition, introduction, and tags stay the same as without it. `Origin` uses the original edition’s declared language; an unknown language is not guessed. If nothing matches, the original title is used. Circle, series, and voice-actor overrides are shared across languages. An undeclared original language stays unknown everywhere, regardless of the metadata request locale; its language label shows only **Original**. A language-specific manual title takes effect for that declared language or when that manual language is explicitly preferred or selected. The language menu includes only existing editions and languages with their own manual title; an all-language title applies to existing options without adding a language.

## Demo Mode

Demo mode keeps account-backed Settings read-only. The administration tabs, the
Recommendations and Tags tabs, and the Your data section of Account
stay visible for inspection even though the Demo identity is not an
administrator, and every change in them is disabled. Appearance and playback
controls remain available because theme mode, style, color, seek intervals, and
playback source options are browser-local preferences and do not modify Demo
server data. The UI language and the preferred metadata language also remain
available: every Demo visitor shares one account, so Demo keeps both choices in
that browser, and one visitor's choice never changes what another sees.
Playback preferences are isolated by server identity and
authenticated user, or by the anonymous principal when anonymous access is
enabled.

## Administration

### Library

Library opens with **Libraries**, every library the server reads: the local
library with its storage mode and whether its storage is online, then each
configured remote source. The settings follow below it: remote source
addresses, library storage, local scan settings, lyrics files, creator
catalogs, Kikoeru account import, and read-only storage paths. Selecting the local library jumps
to **Library storage**.

- **Remote source addresses** holds **Hide addresses from accounts that do not
  manage sources**, on by default and saved with its own button. While it is
  on, accounts without `sources:write` and signed-out readers never receive a
  source's API, public site, or fallback address, a work's page on the source
  site, the upstream file URLs of a track tree or a remote location, a Fetch
  plan's source URLs, or an address inside a workflow run's summary, steps,
  events, candidates, trigger errors, or notifications. Source names, codes,
  and types stay visible. Covers, image previews, playback, and text previews
  go through this server, and **Open origin** is not offered. Turning it off
  restores the addresses for every account.

- **Library storage** shows the library mode (Standard or Storage pools), each
  pool with an Online or Offline badge, and the Fetch pool. Pools can be added
  or, while they hold no works, removed; the mode itself is fixed once the
  library holds local works. **Reconnect** marks an existing folder again
  after an operator confirmed the right disk is mounted there.
- **Scan depth** cannot be set below the level where Fetch saves works;
  scans always reach at least that level, so Fetched works are never reported
  missing because a scan stopped above them.
- **Lyrics files** holds **Lyrics of the work folder**, saved with its own
  **Save lyrics settings** button: whether
  [Lyrics files](work-detail.md#current-behavior) copies
  the lyrics a work folder already holds into the `lyrics_kikoto` folder, which
  leaves the work's own files where they are, or moves them there. Copying is
  the default. It is the starting choice of every lyrics edit, which can still
  choose the other.
- **Creator catalogs** holds **Catalog freshness days** (1 to 365, default 30),
  saved with its own **Save catalog settings** button. A circle or voice actor
  catalog is marked Attention once its last refresh is older than that.
- Each remote source in **Libraries** shows its health, host, a health-check
  action, and an enable switch that saves immediately. Health-check results are persisted
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
  only. It defaults to Japanese. The upstream may still ignore the request or
  return mixed-language metadata.
- Remote sources default to compatible public storage hosts. Source
  configuration can enable **Restrict outbound hosts** to allow only the API,
  Public site, Fallback, and an editable list of exact or `*.example.invalid`
  public host patterns.
- Storage paths are collapsed by default, read-only, and show the resolved data
  root, cache root, default cache/save previews, and per-source save previews.
  Remote source configuration shows the same resolved example instead of a
  path-template editor.

There is no instance metadata language: each user's own choice is in the
header account menu, and a remote source's fallback language is in its source
settings.

### Cache & Fetch

Cache & Fetch contains configuration only: playback cache policy, transfer
safety, and collapsed download pacing, with one save action that is enabled
after a change. Cache contents are managed in the Cleanup tab.

- The per-file remote media limit defaults to 100 GB, and unpublished staging
  from failed or cancelled Fetch runs is kept for seven days by default.
- The transcode cache limit is independent, from 1 to 4096 GB, and defaults to
  5 GB. This rebuildable cache lives under `/cache/transcodes` and does not
  change the managed remote-media cache limit.

### Proxy

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
  downloads), **LLM & ASR** ([LLM providers](#llm-providers) and [speech
  recognition services](#asr-services) at another address; one on this
  server's machine always connects directly), and **Other** (update checks;
  personal Kikoeru account imports always connect directly). **All** switches
  the four together. Each scope uses every proxy by priority or one
  chosen proxy. Every remote source can follow the remote-source scope, connect
  directly, or use its own proxy choice.
- **Direct connection fallback** is off by default. When off, a request whose
  proxies all fail to connect fails rather than connecting directly. When on,
  that request is retried once without a proxy, after every proxy was tried.
- **Bypass proxy** lists destinations that connect directly in every scope,
  including a remote source set to use a proxy, since a proxy elsewhere cannot
  reach them. An entry is a hostname, `*.domain` for every subdomain of a
  domain, an IP address, or a network such as `192.168.0.0/16`. Kikoto
  resolves hostnames itself, so a network also matches a hostname that
  resolves into it: `nas` resolving to an address in `192.168.0.0/16` connects
  directly. The list starts with this machine, the container host,
  private networks, and local domain names: `localhost`, `127.0.0.0/8`, `::1`, `host.docker.internal`, `gateway.docker.internal`, `host.containers.internal`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `fc00::/7`, `fe80::/10`, `*.local`, `*.lan`, `*.internal`, `*.home.arpa`. Edit it as chips,
  then **Save bypass list**; **Restore defaults** brings the default list back
  for saving. Bypassing the proxy never lets a request reach an address it
  could not reach directly.

### LLM & ASR

The tab lists LLM providers and ASR services above and the content safety policy that governs both below. `/settings?tab=asr` opens this tab. Demo lists example providers and services at addresses no request reaches: selecting one opens its dialog with every field visible, and every change is unavailable.

Until the notice is accepted, the tab stays behind it: sending content to an external service can violate its terms of use, the content safety checks are advisory and can be wrong, and Kikoto is not responsible for suspended or banned accounts. Configuration is available after an administrator ticks the agreement and selects **Accept and continue**; the acceptance applies to every administrator of the server.

#### LLM providers

The tab lists the configured providers. **Add provider** opens a dialog that lists the built-in services and compatible protocols on the left, with the chosen one's form on the right for the service origin, its models and server-side API key; selecting a provider in the list opens the same dialog to edit it. While a provider's switch in the list is on, each of its models is offered for translation, its default first. Deleting a provider asks for confirmation. Kikoto adds protocol paths automatically and supports native Anthropic. A built-in service uses its own origin when the field is blank. Same-machine Ollama uses a server-derived address; another-machine Ollama accepts an origin. **Kikoto Helper** translates with the model installed in a Kikoto Helper: on **This server's machine** it is reached through the server's host gateway, so only its port is entered (17657 by default); **Another machine** takes an origin. It requires the API token the helper's web interface shows, and **Fetch models** offers the one translation model the helper runs, or asks you to install one in the helper first. The helper formats the prompts for its model and keeps one entry per tag or lyrics line. **Fetch models** also records the translation directions the model supports; translation offers only those target languages and refuses another direction before it starts. Changing the origin, preset, location or port clears the old key and model list. **Clear stored API key** deletes a credential explicitly. **Models** lists the models a provider offers: add a model ID, or a discovered model suggested after **Fetch models**, and choose the default. IDs can be entered manually when discovery is empty or fails. **Fetch models** saves the current connection draft before discovery, so a provider still being added exists from then on. **Request timeout** bounds one translation request, 1 to 60 minutes and 10 minutes by default, so a slow local model can finish. An Ollama provider also offers **Context length**, the model's context window in tokens (blank keeps the model default), and **Turn off thinking**, on for a new Ollama provider, which asks a reasoning model to answer directly. Kikoto constrains Ollama's output to the supplied fields with one entry per tag or lyrics line.

#### ASR services

The tab lists the ASR (speech recognition) services that can transcribe local tracks into timed lyrics. **Add service** lists OpenAI, a **Local deployment**, **Kikoto Helper** and a **Custom OpenAI-compatible** service on the left, with the chosen one's form on the right; every one is reached through the OpenAI-compatible transcription endpoint, and Kikoto adds its path automatically. A local deployment or Kikoto Helper on **This server's machine** is reached through the server's host gateway, the same address the Local machine proxy uses, so only its port is entered and a container never mistakes its own loopback address for the host; Kikoto Helper suggests its speech recognition port, 17656. **Another machine** and the custom service take an origin; OpenAI uses its own origin when the field is blank. The API key is optional for a service that needs none; Kikoto Helper requires the API token its web interface shows. Changing the location, port or origin clears the stored key and discovered models.

Add the models the service offers under **Models** and choose the default. Each must return segment timestamps, such as `whisper-1` on OpenAI. **Fetch models** saves the connection first and suggests the discovered models, only Whisper models for OpenAI and the installed models for Kikoto Helper, which asks you to install one in the helper first when it has none. Kikoto Helper also says which of its models translate and the one language each writes from which speech; fetch its models again after installing such a model, so Transcribe offers it for that lyrics language. While a service's switch is on, each of its models is offered for transcription. The data boundary and **Maximum content level** work as for LLM providers; the shared [content safety policy](#content-safety-policy) decides whose audio may be sent. See [Transcribe](work-detail.md#transcribe) for starting and reviewing transcriptions.

#### Content safety policy

Each service declares a data boundary and an independent **Maximum content level**: **General only**, **Sensitive and below**, or **High sensitivity and below**. New services default to General only; a private boundary does not grant content permission. Blocked content is never sent, even to a service that accepts High sensitivity. The highest matching restriction wins. Invalid or excessive rules reject the whole save.

By default, LLM translation and ASR assess work metadata: known all-ages content without a matching rule is General, restricted age ratings including R15 and adult content start at Sensitive, and unknown age ratings are refused. Original and manual title/description evidence and retained tags participate even when they are not selected for translation; a manual age rating fills in a missing rating and otherwise counts only when it is stricter than the provider's ([Editing metadata](work-detail.md#editing-metadata)). Tag rules select shared tags by stable ID and assign Sensitive, High sensitivity or Blocked. Keyword rules assign the same actions to selected text fields. High-sensitivity and blocking rules apply to every age rating; the all-ages option controls only additional sensitive keyword checks. ASR always uses this metadata assessment without inspecting audio.

**LLM translation checks selected text only** is off by default. When enabled, LLM translation checks only the complete selected source text for titles, descriptions, tag names and lyrics, before chunking or reusing per-user tag candidates. Work age ratings, metadata tag ID rules and unselected text do not participate. All applicable keyword levels are checked regardless of the all-ages option. An unknown work age does not prevent text assessment. No match is General, including when no keyword rules apply. Check results show the mode, checked fields and a notice when no rules apply. Service receive maxima still apply, and Blocked is always refused. Prechecks, execution, send-time checks and preview acceptance use the same scope.

Text-only mode matches literal keywords; it does not interpret meaning, translate keywords or detect equivalent expressions in other languages. Configure keywords and levels for every language present in the source, including mixed-language text. No match does not guarantee that content is not sensitive. The policy does not guarantee provider compliance or account safety. Remote lyrics translation is off by default. See [translation, review and background workflows](work-detail.md#llm-translation).

### Cleanup

**Cleanup** (`/settings?tab=cleanup`) needs `downloads:manage` for cache
sections and `sources:write` for database sections.

- **Transcode cache** shows usage against its limit and offers a confirmed clear
  action.
- **Managed media cache** reports on-disk, referenced, eligible, and protected
  files, and cleans orphan or per-work cache grouped by source. Cleanup is a
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

### Users

Users manages accounts. Administrators and super administrators can create
and edit User, Contributor, and Admin accounts; only a super administrator can
grant Super admin or change a super administrator. Super administrators in
production and development also see **Instance access** here.

Each role has a fixed set of permissions:

| Role | Permissions | What it adds |
| --- | --- | --- |
| User | `library:read`, `playback:use`, `favorites:write`, `tags:write` | Browse and play the Library and remote sources, and manage personal data: marks, lists, personal tags, progress, and history. |
| Contributor | User's, plus `remote:track`, `remote:fetch`, `workflows:run` | Track, Fork, and untrack remote works; check a work's sources now; cache remote files; follow workflows. Fetch workflows also require `metadata:sync`. |
| Admin | Contributor's, plus `library:write`, `sources:write`, `metadata:sync`, `downloads:manage`, `users:manage` | Metadata editing and sync, source and instance settings, local scans, local file deletion and cleanup, lyrics download, and accounts. |
| Super admin | Admin's, plus `system:admin` | Every permission, every workflow run, and instance access. |

- `remote:track` puts a remote work into the shared Library, where every
  account sees it: Track, Fork, a mark or list on a remote work that is not
  in the Library yet, removing a tracked source, and an on-demand source
  check. Reading a work's recorded source availability needs no permission.
- `remote:fetch` makes the server download remote files: caching one file or a
  work's file, and caching while playing a remote stream. Fetch into the
  library is a composite operation and also requires `metadata:sync` because
  it may refresh the DLsite family before publication.
- Without these permissions the same actions stay visible and explain that
  the account lacks permission when chosen, before any dialog opens. A mark or
  list on a work that is already in the Library, including one another account
  tracked, works for every account. Playing a remote work that is not in the
  Library creates no work, so its progress and listening history are not
  saved. Caching while playing is skipped without a message.
 Anonymous Library browsing and playback
default to disabled; changing the switch applies to the production access
boundary and creates an audit entry. Development authenticates every request
as root, so the setting is visible and editable there without creating an
anonymous development session.

## Metadata

Metadata uses `/metadata`; `/work-management` links redirect there with their filters or settings context.

The **Metadata** icon rail groups **Works** (All, Needs attention, Metadata issues, No available source, Custom works, Translation) and **Entries** (Tags, Circles, Voice actors). Custom works appear only in **Custom works** and **Translation**; the other work views list only works with a provider catalog code, such as a DLsite code. Wide screens name the groups and views by default, and **Hide tab names** below the rail keeps only icons; phones show a scrollable icon row. Work tables provide search, pagination, selection and manual refresh, and the pencil opens the same editor as work detail. Admin and super_admin receive `library:write` for metadata, covers, metadata links, shared tag edits, and circle identity edits.

**Tags** (`/metadata?view=tags`) lists shared concepts by their shared tag **ID**, ordered by ID so the list never depends on a language setting. The ID cell shows the DLsite genre id below the tag ID when there is one, and **Hidden** or **Merged** below that only for a hidden or merged tag; an active tag shows no status. The columns are ID, Japanese, Simplified Chinese, Traditional Chinese, English, Korean, **Other names**, Works, and Manage. Each language column shows the name that language displays: its own manual name, then the all-language manual name (shown muted), then the DLsite dictionary name, then a remote source's name, or "—" when there is none. **Other names** lists every other known name once: names a manual name replaced, with their language, names without a language, and a stored name without name records. Search matches names, including remote-source names, and a numeric query also matches the tag ID or DLsite genre id. On narrow screens the table scrolls sideways inside its own box while the Manage button stays pinned to its right edge. Manage opens manual names for all languages or a locale, global hiding, merge-target selection, and undo of the merge mapping. **Circles** (`?view=circles`) lists circles by their DLsite maker id (RG code), ordered by code; maker ids a merge brought along appear below the primary one, and circles known only from a remote source follow, shown by their Kikoto id. The columns are Code, Name (beside the latest known work's cover), Known names, Works, and Manage, and search also matches maker ids. Manage supports a manual name that survives provider refresh, confirmed aliases, and reviewed merges that move works, maker ids, catalogs, snapshots, series, and personal circle data. Undo processes the latest merge first and refuses to replace later edits to affected records. **Voice actors** (`/metadata?view=aliases`, with `&voice=<id>` to open one person) lists people by Kikoto id, ordered by id, with the columns ID, Name (beside the latest work's cover), Aliases, Works, Status (catalog sync), and Manage; alias and duplicate management requires `metadata:sync`. Demo allows inspection while changes remain disabled.

**Custom works** (`/metadata?reason=custom`) lists the custom works, one row per work, with the same search, editing, and status as the other work tables. A custom work whose folder is missing shows **No available source**, and its local information can be deleted here after confirmation; it offers no metadata retry or source check. The first time an administrator opens the view, a notice describing the folder rename covers it; an administrator accepts it once for the server before custom works can be created. **Add** in its header opens **Add custom work**, which chooses a library folder whose name carries no work code, within the scan depth in online storage pools, in one of three ways. **Found folders** lists such folders after **Scan library folders**, which reads every folder within the scan depth; search matches the folder path, and the list shows at most 200 folders. **Browse** shows the library as a folder tree that leaves out work folders and the folders inside them; a folder that holds a work folder is marked **Holds works** and cannot be chosen, but opens to show the folders beside its works. **Enter path** checks a path relative to the library folder; a full path that starts with the library folder also works. **Next** asks for a title, which defaults to the folder name, and shows the new folder name. Creating a custom work renames its folder: Kikoto assigns a code from `KT00000001` upward and appends it in brackets, such as `Example Work [KT00000001]`, so every scan finds the work. Kikoto refuses a Fetch folder and a folder a running Fetch or **Edit files** writes into, marked **Used by Fetch**, and asks you to try again while another job changes library folders. A scan then adds the folder's files, and the metadata editor sets the work's title, description, and other fields; a custom work has no DLsite page, provider metadata, or remote source, so its [detail page](work-detail.md#custom-works) offers only its local folders and manual metadata. **Add** requires both `library:write` and `downloads:manage` and is not shown in Demo; `/metadata?view=custom` opens **Add custom work** over the custom works list.

**Translation** (`/metadata?view=translation`, with `&language=` and `&missing=`) shows how far every work, catalog and custom alike, is available in one target language. **Target language** starts as the interface language. **Show** lists the works missing anything, which it starts on, or missing their title, description, tag names, file names, or lyrics, the complete works, or every work. **Title** and **Description** name where the language's text comes from: **Original** when it is the language of the work's original edition, **Edition** for a language edition of the work, **Manual** for a manual title in that language, **LLM** for an accepted [LLM translation](work-detail.md#llm-translation), or **Missing**. **Tags** counts the work's shared tags that have a name in the language, **File names** its local files that have a display name in it, and **Lyrics** its local tracks with lyrics assigned in it; a dash means the work has none to count, and file names read **Original** in the work's original language. A check marks what is complete; missing parts take the attention color. A row also shows your own translations into the language that are running or waiting for review. Wide screens give each part its own column; narrower screens list them under the title. Select works and press the translate button in the header to queue a background LLM translation of their title, description, and tag names into the language, one per work, with a chosen provider and model; the fields start on the parts some selected work lacks. Each result waits for review in the work's metadata editor as any [background translation](work-detail.md#llm-translation) does. Lyrics are translated from each work's [Manage lyrics → Translate](work-detail.md#translate). The view requires `metadata:sync` or `library:write`, and queuing translations requires both.

Entry lists follow access to the Metadata page: sign in with at least one of `library:write`, `metadata:sync`, `sources:write`, or `system:admin`. Anonymous read access does not include these management lists. Demo shows only tags and circles related to demo works, counts only those works, and does not expose circle merge history.

Tag visibility follows the final merge target. Hiding an already merged tag stores its hidden setting for after undo; merging into a hidden target hides the resulting tag. Original names remain searchable while merged, and undo restores the original identities and search names.

Cover layout migration and tag backfill run independently in the background after core startup workflows. A failed cover file does not stop other files. Repair failures are logged and retried next startup.

The header keeps the categories, search, and list controls on one row. On wide screens the search field sits beside the categories; on narrower screens it collapses to a search icon at the right that opens the field below the row. Refresh, rows per page, **Retry metadata**, **Check sources**, and the **Metadata settings** gear follow. Pagination above and below the list matches the Library. Metadata settings open in a popover; hover or focus an info icon for a setting's explanation, and closing it preserves the current list and filters. Start metadata sync from Workflows.

Select families and choose **Retry metadata**; its count includes only eligible selections. You can also retry an affected edition from its details, including products reported unavailable. Failed retries preserve existing metadata and manual overrides. **Check sources** applies to selected families without a source. Confirmed deletion of local information is available only in the **No available source** view and, for custom works, in **Custom works**; the server rechecks availability and retains media files.

**Open metadata issues** in Activity opens Metadata filtered to that run's unresolved metadata issues; **Show all pending works** removes the run filter. First-sync failures and pending metadata results open Metadata issues; operators without workflow permission see the unscoped issue list. Run diagnostics are in Workflows Activity. Recovery never changes another user's Activity review. Metadata recovery requires `metadata:sync`, while source checks, deletion, and source/language settings require `sources:write`. The **Metadata settings** popover contains settings only; this page does not duplicate the sync workflow's configuration or run controls.

Metadata settings have a **DLsite proxy** shortcut: the same switch and proxy
choice as the DLsite scope under `Settings -> Proxy -> Proxy scope`, saved
immediately. **Manage proxies** opens that section to add or reorder proxies.
Below it, **Catalog freshness** opens `Settings -> Library`, and **Remote
metadata fallback** opens the Metadata sync workflow, whose **Configure** holds
that setting.

Shared tag names try each preferred language in order: that language’s manual name, the all-language manual name, then the provider name. Detail language switching follows the same precedence.

Hide, merge and undo save their state immediately. Related works update continuously in the background; the tag manager shows the remaining instance-wide work count, including works waiting for retry. Refresh the list to check progress. A failed work retries automatically without delaying others, and updates resume after restart.

### Tag names in preferred languages

DLsite names genres in the requested language even for Japanese-only works. When any user's preferred metadata language is not Japanese, the **Learn tag names** workflow fills missing tag names in the background: for each language it asks DLsite once for the work that covers the most unnamed tags, so the number of requests depends on missing tags, not on the size of the library. It runs after startup, metadata syncs, and language changes, uses the same request pacing and DLsite proxy as metadata sync, and resumes after a restart. Progress, results, and failures appear in Activity. It stores only tag names, never titles or introductions, and does not ask again for a tag DLsite did not name.

### Remote metadata fallback

**Remote metadata fallback** is an option for each DLsite metadata sync run and its interval triggers, off by default. Enable it and choose up to 16 enabled sources that provide work metadata, in request order. Only an explicit DLsite not-found result triggers fallback; timeouts and temporary failures do not. Requests describe existing works only and use the shared bounded transport. Filled metadata remains after the run. These choices do not change the instance-wide ordering of stored remote values or manual/DLsite precedence.

### Purchase bonuses

**Link purchase bonuses to their work** is a DLsite Run option, on by default, also saved in triggers. It controls automatic detection for that run. Detection checks stored works first, then at most 10 circle pages and 5 candidate products. Existing links continue to apply when detection is off; see [purchase bonuses](work-detail.md#purchase-bonuses).

## Related Docs

- [Configuration](../../operations/configuration.md)
- [Security](../../operations/security.md)
- [Sources](sources.md)
