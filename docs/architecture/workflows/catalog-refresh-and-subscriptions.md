# Voice Catalog Refresh and Creator Subscriptions

How creator catalogs are refreshed and how an account subscribes to a creator's new releases.

## Voice Catalog Refresh

Opening a voice actor detail reads the persisted local works and voice catalog
only; entering either a voice or circle detail never queues a workflow.

Circle and voice actor detail refreshes are catalog sync preset runs without a
tag or filter. `POST /api/circles/{externalId}/refresh` and `POST
/api/voices/{personId}/catalog/refresh` only queue a `circle_catalog_sync` or
`voice_catalog_sync` run and return its id. A circle refresh runs the catalog node,
the optional source-check node, and the metadata action for catalog works that
lack metadata. A voice actor refresh runs the catalog node and a
`voice_metadata` node limited to the voice actor's known works; it never
materializes a catalog-only row. A voice actor metadata retry uses the stored
catalog. A
request identical to an active run for the same creator joins it, and a
different request is rejected until that run settles. A detail refresh is
authorized by `metadata:sync`; because its graph holds only refresh steps, the
run carries `workflows:run` on the requester's behalf. Circle detail returns
the newest catalog sync run for the circle so the page can follow it across
reloads.
The only inline circle refresh is the bounded incremental catalog lookup
that resolves a series link. Creator
catalogs expose Never, Attention, or Synced from their last successful pull and
the configured freshness window. An authorized user can start an explicit First
pull or manual refresh through the same catalog sync workflow.

DLsite circle catalogs request newest-release order explicitly. The HTML
parser isolates the result-list element from surrounding recommendations.
Incremental pulls collect every unknown code on a page and stop at a page
that adds no codes, within the catalog page limit.

Reading a circle, changing its per-user state, and a detail refresh never
create one. An unknown maker id returns `404` with `circle_not_in_database`;
the page offers a user with `metadata:sync` and `workflows:run` the
`circle_catalog_sync` run form with that id filled in, and asks anyone else to
contact an administrator. Only a `circle_catalog` fetch adds the circle: it
starts as an unfetched placeholder, and a failed first fetch removes that
placeholder unless it has since gained a name, catalog, relation, or user
state. A stored-catalog run and the circle metadata and source nodes require
a circle that already exists. A voice actor exists only once a synced work
credits them, so an unknown voice actor page asks a user with
`metadata:sync` to sync the metadata of any of their works and asks anyone
else to contact an administrator. A work's circle, series, or voice link
resolves from stored relationships for any signed-in user; fetching the
work's metadata or its circle's catalog to find a missing link requires
`metadata:sync`, and anyone else gets `404` with `entity_not_in_database`.

The workflow searches the display name and every confirmed alias against each
enabled compatible source. It follows the source-reported result count through
all pages and applies no product-level page or result maximum. Outbound response
limits, a per-source deadline, cancellation, repeated-page detection, and a
three-source concurrency bound still protect the request boundary. Results are
deduplicated by canonical `primary_code` before each successful source is
persisted atomically.

A failed source keeps its earlier catalog observations, while a complete
source marks observations absent from the new generation `not_found`. Remote
discoveries remain catalog rows and never materialize works recursively. In a
detail refresh, only catalog items that already resolve to canonical works enter the refresh run's
metadata node; it synchronizes them within the same `voice_catalog_sync` run
rather than creating one metadata workflow per work. Metadata incremental
refreshes select only those known canonical work families without a DLsite
snapshot; full refreshes retry every known canonical family. Neither mode
materializes a catalog-only row as a work. Metadata failures can make the
workflow partial without making an otherwise complete catalog generation stale.

## Creator Subscriptions

A creator subscription asks for new releases of one circle, one series of a
circle, or one voice actor. It is personal state (`favorites:write`) and is
separate from Favorite. Subscribing never creates a circle, series, or voice
actor; an unknown circle is added by its catalog sync first. A voice actor
subscription needs an enabled compatible remote source, because the voice
actor catalog comes from remote sources.

A circle subscription includes the circle's series. An account cannot
subscribe to a series of a circle it subscribes to, and subscribing to a circle
removes that account's subscriptions to its series once the account confirms
it. A circle merge keeps each account's subscriptions on the target with this
rule applied, and a voice actor merge keeps them on the target; Undo restores
both sides.

Subscribed works come from catalogs: a circle and its series from the DLsite
circle catalog, a voice actor from the voice actor catalog. Each circle and
voice actor keeps a seen set of the catalog codes already accounted for. A
subscription takes effect when its catalog has a baseline: right away when the
catalog was pulled within the catalog freshness window, otherwise after the
next successful pull that finishes after it was created. Taking effect records
the whole catalog in the seen set, unless another active subscription already
keeps that set current, so works already in the catalog never count as new. A
user with `metadata:sync` may queue that pull while subscribing: a full pull
for a catalog never pulled, an incremental one otherwise; anyone else waits for
the next refresh.

One system workflow, `creator_subscription_refresh`, serves every account:

```text
catalogs (each subscribed circle and voice actor once)
  -> metadata (DLsite family sync of codes outside the seen sets)
  -> feed (one entry per subscriber whose subscription covers the code)
  -> watch (queue Availability Watch)
```

A catalog pulled within the last six hours, for example by a detail refresh,
is not pulled again. A failed pull keeps the earlier catalog and makes the run
partial. Codes outside the seen sets are synchronized newest code first, at
most 60 per run; the rest wait for the next run. A code DLsite does not list
enters the seen set without a feed entry, and a code whose metadata fails stays
unseen for a retry. Synchronizing creates the code's edition works, because a
subscription is an explicit request for its new works; catalog codes in the
baseline are never materialized. A release entry requires a known release date
no more than 30 days before the refresh, using UTC calendar days. Older works
and works without a valid release date count as seen without a release entry;
a missing catalog date is checked through metadata sync first. A discount does
not qualify an old work as a new release. A non-original edition whose
original was released more than 30 days earlier is a new edition rather than a
new release. A series subscription receives the codes its series lists.

The feed (`user_release_feed_item`) records one entry per account, code, and
event (`released`, `edition`, or `available`). Availability Watch adds
`available` entries for every account it notifies, and a target that becomes
available again moves its entry to the top. The Discover page groups
entries by work family, newest event first, and shows each family through its
canonical work, or through catalog details when no work exists yet, and, for
an account with `workflows:run`, whether the Availability Watch pool watches
the shown code, directly or through another edition of its family. A family
whose `available` event belongs to an available target also carries that
target, so its card can Track or Fetch it. Each family
belongs to the day of its newest event in the account's time zone, and a feed
page holds 5, 10, or 15 days that have entries. Opening the
feed records it as read for the navigation badge. A run that adds entries for
an account creates one notification for that account. A subscription whose
Availability Watch option is on also adds its new works to the shared watch
pool, on behalf of a subscriber who may edit the pool.

The workflow has one fixed interval trigger, configured only on the
Discover page by a user with `metadata:sync`: on or off, an interval from
1 to 168 hours (24 by default), and whether each refresh checks Availability
Watch. Startup plans its first run. The trigger needs no owner: the run holds
only refresh steps, and the Availability Watch run it queues uses the watch's
configuring account. The run lists show its runs and link to the Discover
page; no page edits or deletes the trigger. `POST
/api/subscriptions/refresh` queues a run now; a run that is already queued or
running is kept.

Demo shows a fixed sample feed and subscription list built from obviously
synthetic names and reserved codes. It stores, refreshes, and links nothing.
