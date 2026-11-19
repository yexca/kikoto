# Settings
[English](../en/settings.md) · [简体中文](../zh-Hans/settings.md) · [繁體中文](../zh-Hant/settings.md) · [日本語](../ja/settings.md) · [한국어](../ko/settings.md)

Settings holds the signed-in account's controls and its playback preferences on one page. Recommendation tuning is in the settings of [For you](for-you.md#settings). Instance settings are the **System** page and cleaning up works, caches, and the database is the **Cleanup** page; administrators and Demo see both. On a wide screen Settings is in the **Personal** group of the sidebar and System and Cleanup in its **Manage** group; on a phone both open from the account menu behind your avatar. **Appearance** is the palette button in the header, and **Language** is in the account menu, which anonymous visitors open with **Sign in**.

## Layout

Settings is one page of sections: **Account**, **Time zone**, **Playback** and the playback preferences after it, and **Your data**. `/settings?tab=time-zone`, `/settings?tab=playback`, and `/settings?tab=data` open the page at that section. System shows its tabs along the top, each with an icon and a name: Library, Cache & Fetch, Proxy, ASR & LLM, and Users; Cleanup shows Works, Cache, and Database the same way. Where the screen is too narrow to name every tab, the row shows icons and names only the open tab; focus an icon for its name. Each section is a heading over a thin line followed by its settings, one per row.

## Saving

A switch or a choice saves as soon as it changes. A typed number or name saves
when you leave the field or press Enter. The section heading then shows
**Saving** and **Saved**. A failed save returns the field to its saved value
and reports the error. Forms whose fields only make sense together keep a
button of their own: the password change, library storage, folder
preferences, recommendation tuning, the content safety policy, the proxy
bypass list, and every dialog.

`/maintenance` and `/users` links, and `/settings` links that name a System tab, open the matching System tab; `/settings?tab=cleanup` and `/system?tab=cleanup` open [Cleanup](#cleanup). `/user-data` opens **Your data**, `/settings?tab=recommendation` opens the tuning in [For you](for-you.md#settings), and `/settings?tab=tags` opens [Tags](personal-data.md#personal-tags). `/history` and `/settings?tab=history` open [Insights](personal-data.md#insights).

## Account

- Select the edit icon beside your name and username to open the account dialog,
  update your display name, or change an account-managed user's password after
  verifying the current password and confirming the replacement.
- Username and role are visible but read-only.
- **Time zone** decides where a day starts in your listening report and in
  **New releases** on Discover. **Automatic** follows the device you are using; choosing
  a zone uses it on every device. See [Insights](personal-data.md#insights).
- **Your data** at the end of Settings opens **Export** and **Import** dialogs
  for personal data; see [Personal data](personal-data.md).

Changing a password preserves the current session and revokes the user's other
sessions. An administrator password reset from System -> Users revokes every
session for the target user. Role, enabled state, username, and user lifecycle
management are not self-service account settings.

Every account, including the initial administrator, changes its own password
here. The exception is the root account in environment root account mode,
whose password comes from `KIKOTO_ROOT_PASSWORD`. A forgotten administrator
password is reset from the server host; see
[Administrator setup and recovery](../../operations/security.md#administrator-setup-and-recovery).

## Playback

- **Playback** holds the backward and forward seek intervals and is followed
  by **Loudness normalization**, **Playback sources**, and **Folder
  preference**. Seek
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

Folder preferences, recommendation tuning, and a chosen time zone are stored per
authenticated account on the server and shared across devices; changing them never changes
another account. Accounts without their own values, and anonymous browsing,
use the instance defaults. Failed saves keep the draft and the persisted
values.

## Language And Appearance

Appearance opens from the palette button in the header and holds mode, style, and color. The UI language is in the **Language** view of the header account menu. The globe option follows the browser or device language; its tooltip and accessible name identify automatic selection. Every signed-in user also sees **Preferred metadata language** directly below the UI language. It is a personal choice: it decides which title edition, introduction and tag names that user sees, orders title sorting by those titles, and is asked first when Kikoto queries a remote source for that user. The options are **Origin**, Japanese, English, Simplified Chinese, Traditional Chinese, and Korean. Without a choice it shows **Origin**, each work's original language, and choosing **Origin** clears the preference; an edition without the chosen language falls back to `Origin`. Shared tag names use manual names and the learned dictionary in the same language priority, independently of whether that language has an edition. Every language shows the same tags: they come from the original edition. Anonymous visitors see the original language. Everything stored or shared, such as stored titles and tag names, background syncs, creator catalog refreshes, remote metadata fallback, and workflow run text, always uses each work's original language, so one user's choice never changes what others see.

### Multilingual titles

Kikoto uses the first preferred metadata language that has its own manual title or description, or DLsite edition. Its language-specific manual title wins, then the all-language manual title, then that edition’s title. An all-language title replaces only the text: the default edition, introduction, and tags stay the same as without it. `Origin` uses the original edition’s declared language; an unknown language is not guessed. If nothing matches, the original title is used. Circle, series, and voice-actor overrides are shared across languages. An undeclared original language stays unknown everywhere, regardless of the metadata request locale; its language label shows only **Original**. A language-specific manual title takes effect for that declared language or when that manual language is explicitly preferred or selected. The language menu includes only existing editions and languages with their own manual title or description; an all-language title or description applies to existing options without adding a language.

## Demo Mode

Demo mode keeps account-backed Settings read-only. The System and Cleanup
pages, the settings of For you, the Tags page, and the Your data section of Settings
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

## System

The **System** page (`/system`) holds the instance settings. Administrators see it, and Demo sees it read-only.

### Library

Library opens with **Libraries**, a card list of every library the server reads:
the local storage first (a single card in Standard mode, or one card per pool
in Storage pools mode with Online/Offline and Fetch pool badges plus
**Reconnect** when an unmounted folder can be re-marked), followed by each
configured remote source. **Library storage** or selecting any local card opens
the storage configuration dialog. The settings follow below it: **Local
library**, **Record**, **Creator catalogs**, **Network and privacy**, and
read-only storage paths.

- **Hide addresses from accounts that do not manage sources**, under
  **Network and privacy**, is on by default. While it is
  on, accounts without `sources:write` and signed-out readers never receive a
  source's API, public site, or fallback address, a work's page on the source
  site, the upstream file URLs of a track tree or a remote location, a Fetch
  plan's source URLs, or an address inside a workflow run's summary, steps,
  events, candidates, trigger errors, or notifications. Source names, codes,
  and types stay visible. Covers, image previews, playback, and text previews
  go through this server, and **Open origin** is not offered. Turning it off
  restores the addresses for every account.
- **Allow LAN addresses for every account**, also under **Network and
  privacy**, is off by default. Administrators can always enter a LAN or
  private address for a Kikoeru account import; turning this on, after a
  confirmation, lets every account do so.

- **Library storage** (opened from **Libraries**) configures the library mode
  (Standard or Storage pools), which pools are active, and the Fetch pool.
  Pools can be added or, while they hold no works, removed; the mode itself is
  fixed once the library holds local works. **Reconnect** marks an existing
  folder again after an operator confirmed the right disk is mounted there.
- **Local library** holds **Scan depth** and **Lyrics of the work folder**.
  Scan depth cannot be set below the level where Fetch saves works;
  scans always reach at least that level, so Fetched works are never reported
  missing because a scan stopped above them.
- **Lyrics of the work folder** decides whether
  [Lyrics files](work-detail.md#current-behavior) copies
  the lyrics a work folder already holds into the `lyrics_kikoto` folder, which
  leaves the work's own files where they are, or moves them there. Copying is
  the default. It is the starting choice of every lyrics edit, which can still
  choose the other.
- **Record** turns the [Record](record-library.md) library on or off for the
  instance; it is off by default. While it is on, the section shows the record
  root's state and, until the root is initialized, **Initialize root**.
- **Creator catalogs** holds **Catalog freshness days** (1 to 365, default 30).
  A circle or voice actor
  catalog is marked Attention once its last refresh is older than that.
- Each remote source in **Libraries** shows its health, host, a health-check
  action, and an enable switch that saves immediately. Health-check results are persisted
  through the same source health state used by automatic probes.
- For an account that can run workflows, a source that answers work checks
  also shows its latest library work check, such as **Works checked 2 days ago
  · 12 available**, with the next scheduled check, and opens that run in
  Workflows. **Check library works…** opens the check: the works it asks about
  (**Local library**, the default, or **All works in database**), a filter
  (**No remote source**, the default, for works that no remote source
  currently provides, or **All**), and **Works per run** (50 to 1000, default
  100). **Run** queues a check with these options. **Automatic checks** turn on
  a check **At startup** and **On a schedule** of 1, 6, or 12 hours, 1 day, or
  7 days; they use the same options and save as soon as they change. A source
  that is switched off cannot be checked, and switching it off pauses its
  automatic checks until they are turned on again. Deleting a source deletes
  its automatic checks. See
  [Check works on a source](workflows.md#current-behavior).
- Adding a source that is on, switching a source on, or changing its API URL
  queues one check with the default options, which Workflows shows with the
  trigger **Source change**. Renaming or reordering a source checks nothing.
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
safety, collapsed download pacing, and video conversion. Turning on the
playback cache is confirmed first. Cache contents are managed in the Cache tab
of [Cleanup](#cleanup).

- The per-file remote media limit defaults to 100 GB, and unpublished staging
  from failed or cancelled Fetch runs is kept for seven days by default.
- The transcode cache limit is independent, from 1 to 4096 GB, and defaults to
  5 GB. This rebuildable cache lives under `/cache/transcodes` and does not
  change the managed remote-media cache limit.
- **Simultaneous conversions** under video conversion sets how many video and
  audio playback conversions run at once across the server, from 1 to 5, and
  defaults to 2. A conversion beyond it waits briefly, then reports the server
  as busy. A lower number applies as running conversions finish.
- **Hardware encoder** under video conversion chooses how converted video is
  encoded: **Off (CPU)**, the default, **Intel VA-API**, or **Intel Quick Sync
  Video**, on the render device inside the container, `/dev/dri/renderD128`
  by default. Saving another encoder or device runs a short test encode and
  shows its result, updating while the test runs: **Ready**,
  or **Unavailable** with the reason, such as a device that is not passed to
  the container. Converted video uses the GPU only while the status is
  **Ready**, and uses the CPU encoder for a file whose GPU encode failed. See
  [Hardware video encoding](../../operations/docker.md#hardware-video-encoding)
  for passing the GPU to the container.

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
  downloads), **ASR & LLM** ([speech recognition services](#asr-services) and
  [LLM providers](#llm-providers) at another address; one on this
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

### ASR & LLM

The tab lists ASR services and LLM providers, in the order lyrics use them, transcribed first and then translated, then the content safety policy that governs both and the AI lyrics setting. `/settings?tab=asr` opens this tab. Demo lists example providers and services at addresses no request reaches: selecting one opens its dialog with every field visible, and every change is unavailable.

Until the notice is accepted, the tab stays behind it: sending content to an external service can violate its terms of use, the content safety checks are advisory and can be wrong, and Kikoto is not responsible for suspended or banned accounts. Configuration is available after an administrator ticks the agreement and selects **Accept and continue**; the acceptance applies to every administrator of the server.

#### ASR services

The tab lists the ASR (speech recognition) services that can transcribe local tracks into timed lyrics. **Add service** lists OpenAI, a **Local deployment**, **Kikoto Helper** and a **Custom OpenAI-compatible** service on the left, with the chosen one's form on the right; every one is reached through the OpenAI-compatible transcription endpoint, and Kikoto adds its path automatically. A local deployment or Kikoto Helper on **This server's machine** is reached through the server's host gateway, the same address the Local machine proxy uses, so only its port is entered and a container never mistakes its own loopback address for the host; Kikoto Helper suggests its speech recognition port, 17656. **Another machine** and the custom service take an origin; OpenAI uses its own origin when the field is blank. The API key is optional for a service that needs none; Kikoto Helper requires the API token its web interface shows. Changing the location, port or origin clears the stored key and discovered models.

Add the models the service offers under **Models** and choose the default. Each must return segment timestamps, such as `whisper-1` on OpenAI. **Fetch models** saves the connection first and suggests the discovered models, only Whisper models for OpenAI and the installed models for Kikoto Helper, which asks you to install one in the helper first when it has none. Kikoto Helper also says which languages each of its models hears, and which models translate and the one language each writes from which speech; fetch its models again after installing a model, so Transcribe offers it for the right audio language. The languages of a model on any other service, or of a model ID entered by hand, are unknown: Transcribe offers it for every audio language and lets the lyrics language be chosen. While a service's switch is on, each of its models is offered for transcription. The data boundary and **Maximum content level** work as for [LLM providers](#llm-providers); the shared [content safety policy](#content-safety-policy) decides whose audio may be sent. See [Transcribe](work-detail.md#transcribe) for starting and reviewing transcriptions.

#### LLM providers

The tab lists the configured providers. **Add provider** opens a dialog that lists the built-in services and compatible protocols on the left, with the chosen one's form on the right for the service origin, its models and server-side API key; selecting a provider in the list opens the same dialog to edit it. While a provider's switch in the list is on, each of its models is offered for translation, its default first. Deleting a provider asks for confirmation. Kikoto adds protocol paths automatically and supports native Anthropic. A built-in service uses its own origin when the field is blank. Same-machine Ollama uses a server-derived address; another-machine Ollama accepts an origin. **Kikoto Helper** translates with the model installed in a Kikoto Helper: on **This server's machine** it is reached through the server's host gateway, so only its port is entered (17657 by default); **Another machine** takes an origin. It requires the API token the helper's web interface shows, and **Fetch models** offers the one translation model the helper runs, or asks you to install one in the helper first. The helper formats the prompts for its model and keeps one entry per tag or lyrics line. **Fetch models** also records the translation directions the model supports; translation offers only those target languages and refuses another direction before it starts. Changing the origin, preset, location or port clears the old key and model list. **Clear stored API key** deletes a credential explicitly. **Models** lists the models a provider offers: add a model ID, or a discovered model suggested after **Fetch models**, and choose the default. IDs can be entered manually when discovery is empty or fails. **Fetch models** saves the current connection draft before discovery, so a provider still being added exists from then on. **Request timeout** bounds one translation request, 1 to 60 minutes and 10 minutes by default, so a slow local model can finish. An Ollama provider also offers **Context length**, the model's context window in tokens (blank keeps the model default), and **Turn off thinking**, on for a new Ollama provider, which asks a reasoning model to answer directly. Kikoto constrains Ollama's output to the supplied fields with one entry per tag or lyrics line.

#### Content safety policy

Each service declares a data boundary and an independent **Maximum content level**: **General only**, **Sensitive and below**, or **High sensitivity and below**. New services default to General only; a private boundary does not grant content permission. Blocked content is never sent, even to a service that accepts High sensitivity. The highest matching restriction wins. Invalid or excessive rules reject the whole save.

By default, LLM translation and ASR assess work metadata: known all-ages content without a matching rule is General, restricted age ratings including R15 and adult content start at Sensitive, and unknown age ratings are refused. Original and manual title/description evidence and retained tags participate even when they are not selected for translation; a manual age rating fills in a missing rating and otherwise counts only when it is stricter than the provider's ([Editing metadata](work-detail.md#editing-metadata)). Tag rules select shared tags by stable ID and assign Sensitive, High sensitivity or Blocked. Keyword rules assign the same actions to selected text fields. High-sensitivity and blocking rules apply to every age rating; the all-ages option controls only additional sensitive keyword checks. ASR always uses this metadata assessment without inspecting audio.

**LLM translation checks selected text only** is off by default. When enabled, LLM translation checks only the complete selected source text for titles, descriptions, tag names and lyrics, before it is split into requests. Work age ratings, metadata tag ID rules and unselected text do not participate. All applicable keyword levels are checked regardless of the all-ages option. An unknown work age does not prevent text assessment. No match is General, including when no keyword rules apply. Check results show the mode, checked fields and a notice when no rules apply. Service receive maxima still apply, and Blocked is always refused. Prechecks, execution, send-time checks and the check before a result is written use the same scope.

Text-only mode matches literal keywords; it does not interpret meaning, translate keywords or detect equivalent expressions in other languages. Configure keywords and levels for every language present in the source, including mixed-language text. No match does not guarantee that content is not sensitive. The policy does not guarantee provider compliance or account safety. Remote lyrics translation is off by default. See [Translate with AI](work-detail.md#translate-with-ai).

#### AI lyrics

**Name the models in AI-made lyrics**, on by default, starts every lyrics file written by speech recognition or translation with a line in the lyrics' own language naming the models that wrote it, as [Lyrics attribution](work-detail.md#lyrics-attribution) describes. Turning it off affects files written afterwards; published files keep their text.

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

In **Instance access**, **Anonymous access** (off by default) allows Library
browsing and playback without an account. Turning it on is confirmed first.
The change applies to the production access boundary and creates an audit
entry. Development authenticates every request
as root, so the setting is visible and editable there without creating an
anonymous development session.

## Cleanup

The **Cleanup** page (`/cleanup`) removes local work folders, cache files, and
database records. Its tabs follow the account's permissions: **Works** and
**Cache** need `downloads:manage`, and **Database** needs `sources:write`,
which forgetting works also needs. Demo sees every tab read-only.

### Works

- **Local works by rating** lists the works that have a local folder, one row
  per work family and largest first, by your own rating: up to a chosen number
  of stars, with unrated works when **Include unrated works** is on. A family
  takes the highest rating any of its editions has. The size counts the
  work's indexed local files: a work nobody has opened yet shows none, and a
  size with files of unknown size ends in `+`. A work on an offline storage
  pool cannot be selected. **Delete files** deletes every local folder of the
  selected works, with the system files such as `Thumbs.db` or `@eaDir` in
  them, and can also clear your rating and your Quick mark of them. **Forget
  works**, offered only while both are cleared, also removes the works with
  every account's ratings, marks, list entries, notes, progress, and listening
  history for them; a work another source still provides is kept, and the
  confirmation counts those. The confirmation says how many selected works are
  unrated, and a selection with a work rated 3 stars or more asks again and
  lists those works. The deletion is one workflow run that cleans the works in
  turn: it indexes a work's folders again, deletes them, and only then changes
  that work's rating, mark, and identity. A work whose folder holds anything
  that would keep the folder from being deleted, such as a `#recycle` folder
  with files in it, a link, or any other file that is not the work's, keeps its files,
  rating, mark, and identity: nothing of it is deleted. The run finishes the
  other works and fails, and **Retry** in Workflows tries the failed works
  again.

### Cache

- **Transcode cache** shows usage against its limit and offers a confirmed clear
  action.
- **Managed media cache** reports on-disk, referenced, eligible, and protected
  files, and cleans orphan or per-work cache grouped by source. Cleaning is a
  two-step destructive action queued as a workflow run.

### Database

- **Database records** lists record types that can be removed, each with a
  current count: missing work folders and local files confirmed absent on disk
  (with the empty track entries, local availability, and folder display names
  they leave behind), orphaned metadata snapshots, unused source tags, expired
  sessions, dismissed
  notifications, finished workflow runs older than 90 days, recommendation
  signals older than 90 days, unused recommendation snapshots, and
  [ranking](discover.md#rankings) updates past the history the
  [ranking settings](discover.md#ranking-settings) keep. Personal tags,
  runs with reviews, Fetch records, or metadata issues, the latest run of each
  workflow, the latest update of each ranking order, finished annual rankings,
  and the update each account last viewed are kept.
  Selected tasks are removed after confirmation and recorded in the audit log;
  media files are never deleted. Expired sessions, eligible old workflow runs,
  and old ranking updates are also removed automatically with the same rules,
  shortly after the server starts and then every 10 days.
- Path checks pause when the data folder is missing or empty, so an unmounted
  library is never treated as deleted.
- **Works without any source** links to the **Needs attention** filter of
  Metadata's **DLsite works** for review and deletion.
- **Compact database** rewrites the SQLite file to return free pages to disk.
  It runs in the background as a workflow run shown in Workflows, and only one
  compaction can be queued or running at a time.

## Metadata

Metadata uses `/metadata`; `/work-management` links redirect there with their filters, and links to the former Metadata settings open **System → Proxy**.

The **Metadata** page shows its views as tabs along the top, grouped as **Works** (DLsite works and Custom works) and, after a divider, **Entries** (Tags, Circles, Voice actors). **DLsite works** lists only works with a provider catalog code, such as a DLsite code, and opens on **All**; the filter in the header, beside search and the list controls, switches between **All** and **Needs attention** (`/metadata?reason=catalog` and `all`). **Needs attention** lists works with a metadata issue, a first sync still to run, or no available source, and each row names which; `reason=metadata` and `reason=no_source` links open it. Custom works appear only in **Custom works** and in the coverage of the [Translation page](translation.md#coverage). The tabs sit above the list, so the tables keep the full width; phones scroll the tab row sideways. **DLsite works**, **Custom works**, and each filter show how many works they list; the **Needs attention** count takes the attention color while it lists any. The filter names the selected view, or on phones only its count, and turns primary while it narrows the list; on **All**, a dot on it marks works that need attention. Work tables provide search, pagination, selection and manual refresh, and the pencil opens the same editor as work detail. Admin and super_admin receive `library:write` for metadata, covers, metadata links, shared tag edits, and circle identity edits.

**Tags** (`/metadata?view=tags`) lists shared concepts by their shared tag **ID**, ordered by ID so the list never depends on a language setting. The ID cell shows the DLsite genre id below the tag ID when there is one, and **Hidden** or **Merged** below that only for a hidden or merged tag; an active tag shows no status. The columns are ID, Name, Works, and Manage. **Name** is the name the interface language displays: its own manual name, then the all-language manual name, then the DLsite dictionary name, then a remote source's name. A tag without a name of its own in that language shows the name it falls back to, muted. Search matches every known name, including remote-source names, and a numeric query also matches the tag ID or DLsite genre id. Manage opens manual names for all languages or a locale, global hiding, merge-target selection, and undo of the merge mapping. **Circles** (`?view=circles`) lists circles by their DLsite maker id (RG code), ordered by code; maker ids a merge brought along appear below the primary one, and circles known only from a remote source follow, shown by their Kikoto id. The columns are Code, Name (beside the latest known work's cover), Known names, Works, and Manage, and search also matches maker ids. Manage supports a manual name that survives provider refresh, confirmed aliases, and reviewed merges that move works, maker ids, catalogs, snapshots, series, and personal circle data. Undo processes the latest merge first and refuses to replace later edits to affected records. **Voice actors** (`/metadata?view=aliases`, with `&voice=<id>` to open one person) lists people by Kikoto id, ordered by id, with the columns ID, Name (beside the latest work's cover), Aliases, Works, Status (catalog sync), and Manage; alias and duplicate management requires `metadata:sync`. Demo allows inspection while changes remain disabled.

**Custom works** (`/metadata?reason=custom`) lists the custom works, one row per work, with the same search, editing, and status as the other work tables. A custom work whose folder is missing shows **No available source**, and its local information can be deleted here after confirmation; it offers no metadata retry or source check. The first time an administrator opens the view, a notice describing the folder rename covers it; an administrator accepts it once for the server before custom works can be created. **Add** in its header opens **Add custom work**, which chooses a library folder whose name carries no work code, within the scan depth in online storage pools, in one of three ways. **Found folders** lists such folders after **Scan library folders**, which reads every folder within the scan depth; search matches the folder path, and the list shows at most 200 folders. **Browse** shows the library as a folder tree that leaves out work folders and the folders inside them; a folder that holds a work folder is marked **Holds works** and cannot be chosen, but opens to show the folders beside its works. **Enter path** checks a path relative to the library folder; a full path that starts with the library folder also works. **Next** asks for a title, which defaults to the folder name, and shows the new folder name. Creating a custom work renames its folder: Kikoto assigns a code from `KT00000001` upward and appends it in brackets, such as `Example Work [KT00000001]`, so every scan finds the work. Kikoto refuses a Fetch folder and a folder a running Fetch or **Manage files** writes into, marked **Used by Fetch**, and asks you to try again while another job changes library folders. A scan then adds the folder's files, and the metadata editor sets the work's title, description, and other fields; a custom work has no DLsite page, provider metadata, or remote source, so its [detail page](work-detail.md#custom-works) offers only its local folders and manual metadata. **Add** requires both `library:write` and `downloads:manage` and is not shown in Demo; `/metadata?view=custom` opens **Add custom work** over the custom works list.

Entry lists follow access to the Metadata page: sign in with at least one of `library:write`, `metadata:sync`, `sources:write`, or `system:admin`. Anonymous read access does not include these management lists. Demo shows only tags and circles related to demo works, counts only those works, and does not expose circle merge history.

Tag visibility follows the final merge target. Hiding an already merged tag stores its hidden setting for after undo; merging into a hidden target hides the resulting tag. Original names remain searchable while merged, and undo restores the original identities and search names.

Cover layout migration and tag backfill run independently in the background after core startup workflows. A failed cover file does not stop other files. Repair failures are logged and retried next startup.

The header keeps the categories, search, and list controls on one row. On wide screens the search field sits beside the categories; on narrower screens it collapses to a search icon at the right that opens the field below the row. Refresh and rows per page follow. Pagination above and below the list matches the Library. The page has no settings of its own: the DLsite proxy is in **System → Proxy**, and catalog freshness in **System → Library**. Start metadata sync from Workflows.

Work rows show the title above the code and circle, then a **Status** column that names only what the work needs and stays empty for a healthy work; narrow screens, and wide ones while the inspector is open beside the table, list it under the title. **Metadata issues** marks a failed or unavailable update, **Not synced** a work DLsite has not been asked about yet, and **No available source** a work no library folder, remote source, or cache provides; a running sync shows beside them. A work whose metadata a remote source filled because DLsite has no record of it is complete and shows nothing. **Retry metadata** queues a first sync or a retry.

Press a row to open the work inspector: beside the table on wide screens and in a sheet on narrower ones; keyboard focus reveals an inspect button on the row that does the same. It shows the cover, title, code, and circle; the metadata and source state, where **Metadata** reads **Complete** or **Metadata from** the remote source that filled it and **Source** reads **Local** or **Remote**, with **Retry metadata** and **Check sources** where they apply and the affected editions open below; the release date, age rating, series, voice actors, tracks, rating, and sales that are known; the tags; and **Edit metadata**, **Open work**, and the DLsite page. It reads the row already loaded, and pressing the row again, its close button, or Escape closes it.

Selecting works replaces the upper pagination with a selection bar holding **Retry metadata**, **Check sources**, and, in the views that allow it, **Delete local information**, each with the number of selected works it applies to, plus **Dismiss unavailable** while a selected work has a product reported unavailable. **Retry metadata** counts only eligible selections. You can also retry an affected edition from its details, including products reported unavailable. When an enabled remote source provides metadata, the selection bar offers **Fetch from** that source and each affected DLsite edition offers the same in its details; this asks only that source, as the detail page's `From <source name>` refresh does, without automatic remote fallback being enabled. Failed retries preserve existing metadata and manual overrides. A product DLsite no longer lists, such as a delisted work, stays unavailable however often it is retried: **Dismiss** in its edition details, or **Dismiss unavailable** in the selection bar, stops listing it as a metadata issue for everyone and clears its metadata-run notice. A failed update cannot be dismissed. A later sync that fails for the work lists it again. A failed DLsite update offers **Proxy settings** in its details, which opens **System → Proxy**, to accounts that manage sources. **Check sources** applies to selected families without a source. Confirmed deletion of local information applies only to works without a source, in **Needs attention** and, for custom works, in **Custom works**; the server rechecks availability and retains media files.

**Open metadata issues** on a run in Workflows opens **Needs attention** in **DLsite works**, narrowed to that run's unresolved metadata issues; **Show all pending works** removes the run filter. First-sync failures and pending metadata results open Metadata issues; operators without workflow permission see the unscoped issue list. Run diagnostics are in Workflows. Recovery never changes another user's review of a run. Metadata recovery requires `metadata:sync`, while source checks, deletion, and source/language settings require `sources:write`. This page does not duplicate the sync workflow's configuration or run controls.

Shared tag names try each preferred language in order: that language’s manual name, the all-language manual name, then the provider name. Detail language switching follows the same precedence.

Hide, merge and undo save their state immediately. Related works update continuously in the background; the tag manager shows the remaining instance-wide work count, including works waiting for retry. Refresh the list to check progress. A failed work retries automatically without delaying others, and updates resume after restart.

### Tag names in preferred languages

DLsite names genres in the requested language even for Japanese-only works. When any user's preferred metadata language is not Japanese, the **Learn tag names** workflow fills missing tag names in the background: for each language it asks DLsite once for the work that covers the most unnamed tags, so the number of requests depends on missing tags, not on the size of the library. It runs after startup, metadata syncs, and language changes, uses the same request pacing and DLsite proxy as metadata sync, and resumes after a restart. Progress, results, and failures appear in Workflows. It stores only tag names, never titles or introductions, and does not ask again for a tag DLsite did not name.

### Remote metadata fallback

**Remote metadata fallback** is an option of a DLsite metadata sync run and of the interval trigger that stores it, off by default; on Workflows it is set in **Metadata options** on the **Metadata** card. Enable it and choose up to 16 enabled sources that provide work metadata, in request order. Only an explicit DLsite not-found result triggers fallback; timeouts and temporary failures do not. Requests describe existing works only and use the shared bounded transport. Filled metadata remains after the run. These choices do not change the instance-wide ordering of stored remote values or manual/DLsite precedence.

### Purchase bonuses

**Link purchase bonuses to their work** is an option of a DLsite metadata sync run, on by default and set in **Metadata options** on the **Metadata** card, also saved in triggers. It controls automatic detection for that run. Detection checks stored works first, then at most 10 circle pages and 5 candidate products. Existing links continue to apply when detection is off; see [purchase bonuses](work-detail.md#purchase-bonuses).

## Related Docs

- [Configuration](../../operations/configuration.md)
- [Security](../../operations/security.md)
- [Sources](sources.md)
