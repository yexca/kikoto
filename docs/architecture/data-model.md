# Data Model

Kikoto uses SQLite and a unified work model. These pages describe the tables, their invariants and the rules that keep them consistent, grouped by topic. Open the page that matches the change; start with Modeling Rules for any table change.

| Page | Open this when |
| --- | --- |
| [Modeling Rules](data-model/modeling-rules.md) | Adding or changing any table or column: where source facts, file paths, snapshots and user state belong, and how `work_search` is derived. |
| [Work Metadata](data-model/work-metadata.md) | Work identity and edition tables, metadata snapshots, projection, sync attempts, search document inputs, and the metadata language priority. |
| [Metadata Tags and Genres](data-model/metadata-tags.md) | Tags, `work_tag`, tag names per language, DLsite genre ids, or tag overrides. |
| [Creators and Voice Catalog](data-model/creators-and-voice-catalog.md) | Circle or voice actor identity, aliases, merges, credits, `/voices` routes, or the voice catalog discovery tables. |
| [Overrides, Normalized Fields and Bundles](data-model/overrides-normalized-fields-bundles.md) | `work_manual_override`, title fallback order, rating/sales/price columns, `work_metadata_link`, purchase bonuses, or bundle membership. |
| [Remote Metadata Fallback](data-model/remote-metadata-fallback.md) | A remote source supplying metadata, its title variants, or the not-found fallback rules. |
| [LLM translation](data-model/llm-translation.md) | LLM providers, the content policy, `work_llm_translation`, accepted tag names, lyrics translation input, or the stored rows of `llm_translation` runs. |
| [Translate with AI](data-model/translate-with-ai.md) | Translate with AI runs, `translation_item` states, auto-accept, or the Translation page reads. |
| [Speech transcription](data-model/speech-transcription.md) | `asr_providers`, `asr_transcription`, chunking, or lyrics published from a transcription. |
| [Custom Works](data-model/custom-works.md) | `KT` custom work codes, their counter, local metadata, editions, lyrics origins, or folder-edit effects on a custom work. |
| [File Availability](data-model/file-availability.md) | File sources, endpoints, `media_file_location`, pools, presence, or the record library tables. |
| [Workflows](data-model/workflow-records.md) | Workflow runs, jobs, events, notifications, Fetch manifests, Availability Watch, creator subscriptions, release feeds or ranking tables. |
| [User State](data-model/user-state.md) | Accounts, sessions, preferences, playback cursors, lyrics preferences, favorite lists, user tags, listening history or the audit log. |
| [Recommendation Catalog And Generations](data-model/recommendations.md) | Recommendation catalog epochs, dirty queues, generations, client sessions or query checkpoints. |

## Related Docs

- [Core boundaries](core-boundaries.md)
- [Source presence](source-presence.md)
- [Workflows](workflows.md)
- [Migrations](../development/migrations.md)
