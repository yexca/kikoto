# Workflow Model and Built-In Workflows

The workflow persistence model and every built-in system workflow, with the operation each runs.

## Model

```text
workflow_definition
  -> workflow_trigger
  -> workflow_run
      -> workflow_node_run
      -> workflow_job
      -> workflow_candidate
      -> workflow_run_review
```

## Built-In Workflows

Every `workflow_definition` is a system definition: one of the built-in
workflows below or a [preset workflow](shown-works-and-presets.md#preset-workflows). There are no
user-authored definitions. Each run stores its own workflow code and name.

Library and metadata:

- `local_library_scan`: discover local work folders and synchronize local
  presence (see [Local Folder Trigger](local-folder-trigger.md#local-folder-trigger)).
- `record_library_scan`: discover the independent record root's folders and
  files without changing audio works, and queue `record_media_probe` for the
  files it leaves pending (see [Record library](../record-library.md)).
- `record_media_probe`: read the length of pending record videos and audio
  files, and whether audio files carry cover art, yielding to other queued
  jobs between files (see [Record library](../record-library.md)).
- `local_media_index`: index the media files of discovered local work folders
  (see [Local Work File Refresh](local-folder-trigger.md#local-work-file-refresh)).
- `metadata_sync`: bulk metadata sync of existing works and explicitly
  selected codes (see [Metadata Sync Scope](metadata-sync.md#metadata-sync-scope)).
- `metadata_family_sync`: refresh one work and its bounded language-edition
  family, queued by work detail, Metadata recovery, and link changes.
- `metadata_genre_names`: learn genre names in preferred metadata languages
  (see [Genre Name Learning](metadata-sync.md#genre-name-learning)).
- `llm_translation`: a per-work LLM translation for review. Nothing queues one;
  its job ends a queued or retried run without a request, as
  [Translation task persistence](../data-model/llm-translation.md#llm-translation) describes.
  Translate with AI runs as `ai_translation`.
- `ai_translation`: Translate with AI for one work: translate the missing
  title, description, shared tag names, display names and lyrics, each from a
  lyrics file, into each requested language, accepting
  each item as it finishes while auto-accept is on, in one job that yields
  between requests like a transcription. Each item
  keeps its own state, so one item's failure leaves the others running.
  [Translate with AI](../data-model/translate-with-ai.md#translate-with-ai) defines the items,
  rechecks, review and retry.
- `asr_transcription`: transcribe one local audio track with a configured
  speech recognition service for review, one chunk per request. Between
  chunks the job defers itself for a few seconds whenever another job is
  waiting, so a long track shares the single executor instead of holding it.
  Retry continues after the last committed chunk. [Speech
  transcription](../data-model/speech-transcription.md#speech-transcription) defines the task,
  rechecks and publication.
- `demo_library_scan`: the Demo library scan, which indexes only works
  eligible for public browsing.

Remote sources:

- `remote_source_sync`: track one remote work and its selected-source
  directory.
- `source_availability_check`: check which configured remote sources can
  provide a work (see [Source Availability](source-availability.md#source-availability)).
- `unlinked_work_source_check`: check remote sources for selected works that
  have no available source, from the Metadata no-source view.
- `source_presence_check`: check whether library works exist on one remote
  source (see [Source Presence Check](source-availability.md#source-presence-check)).
- `availability_watch`: see [Availability Watch](source-availability.md#availability-watch).
- `remote_work_fetch`: Fetch one remote work into the local library.
- `remote_bulk_action`: dispatch per-work Track or Fetch workflows for several
  selected remote works or available Availability Watch targets. A run
  started from the watch also carries the Fetch extension exclusion and which
  target each code acts for.
- `dlsite_popular_collection` and `remote_popular_collection`: pull the
  DLsite and remote source ranking lists (see [Rankings](rankings.md#rankings)).
- Preset catalog sync workflows `circle_catalog_sync`, `series_catalog_sync`,
  and `voice_catalog_sync`. Circle and voice actor detail refreshes run as
  catalog sync runs.
- `creator_subscription_refresh`: see
  [Creator Subscriptions](catalog-refresh-and-subscriptions.md#creator-subscriptions).
- `shown_works_metadata_sync` and `shown_works_source_check`: sync the metadata
  of, or check the sources of, the works a Discover view shows (see
  [Shown Works Actions](shown-works-and-presets.md#shown-works-actions)).

Media, cleanup, and database:

- `media_cache`: cache remote media during playback.
- `media_cache_cleanup`: delete cached media files and mark their cache
  locations unavailable.
- `cache_maintenance`: remove unreferenced managed cache files after a safety
  grace period and prune empty directories.
- `media_location_cleanup`: delete selected cache or local files and mark their
  locations unavailable. A local file whose location no longer records the
  queued path, media item, work, and source when the run reaches it, such as
  after a folder edit renamed it, is left alone: the run records a
  `media_cleanup.location_changed` event, lists it in `changed_locations`,
  and finishes `partial`. `media_cleanup_forget_work` also removes the then
  unlinked work families and their personal state. A removed work folder takes
  the sidecars a NAS or operating system keeps beside its files (`._` files,
  `.DS_Store`, `Thumbs.db`, `@eaDir`, `__MACOSX`) with it. A run queued from
  [Local works](../../user/en/settings.md#works) cleans its works in
  turn while it holds the library folders: it claims the work's confirmed
  folders, indexes them again, checks that every claimed folder holds nothing
  but the work's available indexed files, the lyrics folder's marker, and
  those sidecars, and moves each claimed folder by a same-filesystem rename
  into `.kikoto-staging/<run>/cleanup/<folder>` on its own pool, where the
  check runs again. Only then does one transaction mark the folders and their
  files unavailable; the moved folders are deleted from the cleanup area,
  leaving any folder the work gained since the confirmation, and another
  transaction clears the requester's rating and Quick mark of the work and
  forgets it when asked. A folder holding anything else, such as a link or a
  recycle bin with files in it, or a folder that cannot be moved stops the
  work before any of its files is deleted, and the folders moved before it go
  back. A folder an interrupted attempt left in the cleanup area is deleted
  by the run's next attempt once the index has let it go, and is otherwise
  returned to its place when the run gives the folder back to its work. A
  work that cannot be cleaned gets its folders back, keeps its state, and is
  listed in the run's failures; the run goes on with the other works and then
  fails, so a retry cleans only the failed works.
- `work_folder_edit`: add files from the family's other local folders and
  remote editions to one local folder of a work, arrange its files and
  folders, remove the files taken out of it, and delete the local folders
  merged into it. It collects and size-checks every added file in
  `.kikoto-staging` on the folder's pool, moves the files taken out into the
  same staging directory and marks their locations unavailable, takes each
  moved file into it too, moves each collected and moved file to its path,
  removes the folders it emptied, creates the requested ones, indexes the
  folder, and then deletes the merged folders. The files taken out are deleted
  with the staging directory only once the edit succeeds; a failed or
  cancelled edit, including one that waits for a retry, puts them back and
  makes their locations available again, except a file whose path a file the
  edit placed now holds: that one is dropped. A retried or resumed run
  continues from its checkpoint. A Fetch into a new
  folder queues one as its follow-up once it completes. Lyrics track bindings
  that an edit or a Fetch follow-up recorded are not stored: the edit run
  counts them in its summary and Activity, and a Fetch follow-up's run notes
  them, with any lyrics language it chose, once its edit is queued.
- `local_media_delete`: delete one local media file and mark only that location
  unavailable. A queued deletion whose location no longer records the queued
  file is `skipped` with a `media_delete.location_changed` event and deletes
  nothing. `local_symlink_review` notifies users when such a request
  targets a symlink.
- `local_location_cleanup`: mark reviewed local locations unavailable and
  optionally delete the files.
- `database_optimize`: single-flight `VACUUM` (see
  [Database](../../operations/database.md#maintenance)).
- `database_backup`: a verified database copy with bounded retention (see
  [Database](../../operations/database.md#backups)).
