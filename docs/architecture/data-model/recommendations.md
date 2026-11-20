# Recommendation Catalog And Generations

The recommendation catalog, its generations and the tables that serve them.

Important tables:

- `recommendation_catalog_epoch` and `recommendation_catalog_state`
- `recommendation_catalog_dirty` and `recommendation_name_dirty`
- `recommendation_catalog_work`, `recommendation_catalog_entity`,
  `recommendation_catalog_frequency`, and `recommendation_catalog_name`
- `recommendation_user_revision`
- `recommendation_generation`
- `recommendation_generation_state`
- `recommendation_client_session`
- `recommendation_generation_profile`
- `recommendation_query_context`, `recommendation_query_candidate`, and
  `recommendation_query_checkpoint`

In production and development, a shared derived catalog stores effective
metadata tags, voices, circles, entity-to-work membership, entity frequency,
names, aliases, and ambiguous name
resolution. Relation and name mutations enqueue durable work in the same
transaction. A cancellable worker processes bounded batches and atomically
publishes a complete `catalog_epoch`. Version intervals retain only changed
records; publishing an epoch does not copy the library. The first epoch becomes
available only after its backfill completes, and later updates keep the last
published epoch available. An epoch also waits for the upstream metadata-tag
projection queue to drain, so names and effective relationships publish together.
GET requests never rebuild the catalog. Each work
receives an indexed exploration key when it is created, independently of the
worker, so a newly created work remains browsable before projection completes.

A generation freezes the algorithm, effective configuration, user revision,
published catalog epoch, entity preference evidence, and sparse personal states
(non-default listening status, favorite, or rating). Profile preparation reads all the
user's feedback works, not every work's relations. Its cost grows with feedback
volume, and scoring does not truncate that evidence. Preparation happens outside
the publication transaction; revision validation and bounded retries prevent a
partially prepared profile from being bound to a session. Matching preparation
tasks share one result. A staged epoch pin protects history before preparation
starts, including while the task waits for a CPU slot without a SQLite connection.
Client sessions reuse a ready immutable generation with
the same inputs; cards still read live favorite and listening state from
`user_work_state`. An algorithm version change renews older generation bindings.
An old generation retains its own catalog features, frequencies, names, and
personal evidence despite later edits. Works absent from its epoch receive
neutral affinity features; deleted works are excluded from browsing.
Catalog records, frozen states, and stored candidate prefixes also retain
`primary_code`; reads verify it against the current work. Reusing a deleted
SQLite row id cannot transfer that work's recommendation inputs to another work.

`heuristic-v7` weighs each feedback work rating first.
`user_work_state.rating` is the account's own one-to-five-star rating; NULL is
unrated, and the API, imports, and scoring treat any other value as unrated. A
rated work contributes only its rating: five and four stars add positive
evidence, two and one stars add negative evidence and count as disliked, and
three stars add none. An unrated work falls back to its marks: a favorite adds
one favorite's evidence, Relisten and Shelved add their configured shares.
The weights are percentages of one favorite in the recommendation
configuration, and the generation's configuration weighs the frozen evidence.
Each entity sums positive and negative evidence once, excluding the
candidate's own feedback, and nets them. Positive net evidence is a match
whose strength grows linearly to one favorite, then from 1 to 2 by five
favorites' worth. Negative net evidence is a deduction of the same strength
when one disliked work, or at least `negativeMinEvidence` unrated shelved
works, support it. Lanes still follow the listening status. Tag specificity is `1 - 0.5 * frequency / work_count`;
contributions are rounded after summation and retain the configured caps.
Exploration is proportional to the remaining affinity headroom, while jitter
uses a separate seeded hash. Creator diversity subtracts 0–8 ordering points
within the bounded query candidates (two per later work in the same lane and
circle, with voice as the fallback); it does not change affinity.

Each normalized query context includes the generation, filters/search, scope,
seed, direction, and ordering inputs. Page and page size do not change it.
Recall budgets are 1,200 entity matches, 400 personal-state works, 200 recent
works, and 200 exploration works; deduplication limits scoring to 2,000 works.
Entity selection and indexed range probes are bounded even for common tags.
Each context retains at most 500 ranked candidates, and each generation retains
at most eight contexts. Within each listening lane, these candidates precede
the complete remaining matching set in a seeded ring over indexed exploration
keys. Lane counts and slot cycles select page windows without a full personal
`ROW_NUMBER` ranking. Search exact matches remain ahead of partial matches,
and zero-slot states follow scheduled states. Total counts include the complete
matching set. Membership and filter changes can move page boundaries; unchanged
visible data has deterministic, complete pagination without duplicates.

Ordinary sorting completes its page before scoring at most 100 page works and
creates no query context. Detail explanations score any work from the frozen
profile and epoch, including works outside the candidate prefix. A list's opaque
`recommendationContext` binds query-specific diversity and ordering explanations
to its owner and generation; without it, explanations report affinity only.
An evicted context returns HTTP 410 `recommendation_context_expired` only when
its token authenticates the original user and generation. Its original session
can still supply frozen affinity without ordering. Invalid, unverifiable,
cross-user, and cross-generation contexts return HTTP 400 `invalid_request`.
Each frozen profile persists a private signing key that stays outside API
responses. Cached legacy unsigned contexts still validate their owner and
generation; an evicted unsigned context cannot prove that binding.

Demo recommendation scores use `demo-random-v1`, a simulated value derived from
the demo session and unified `primary_code`; a missing session uses a stable
default. Feedback and recommendation features are not score inputs. Demo
recommendation sorting uses seeded random pagination and preserves filters,
exact-search priority, and complete totals. The seed affects ordering without
changing a work's demo score. Demo explanations identify `scoreKind` as
`demo_random`, return an empty component list, and omit preference signals,
listening lanes, and ranking adjustments. Demo starts no real recommendation
catalog worker, and its requests do not prepare profiles, generations, query
contexts, candidate recall, or real recommendation scores.

`recommendation_generation_profile` stores each generation's weighted evidence and
name mappings. In production and development, the authenticated remote
recommendations endpoint accepts at most 100 candidates from the displayed
page, validates known work identities,
batch-loads their frozen features, and scores unknown candidates with frozen
name resolution and this profile.
Localized tag names and creator aliases resolve to one entity; repeated names
count once and ambiguous names are ignored. Scoring does not fetch upstream
metadata or create works, tags, creators, or source presence.

Cleanup removes expired sessions, unreferenced generations, contexts, unfinished
preparation records, legacy full-library score caches, and unreferenced shared
history in bounded batches. Referenced epochs remain protected. Personal
feedback, settings, telemetry retention, and durable listening history are
separate from these derived caches.

For you (`for-you-v1`) draws from the same generation as a
sessionless explanation: the generation of the account's current inputs. It
reads candidates through the Local-scope recall above plus the account's most
recent 1,000 works with playback history, and measures novelty against the
catalog features of the works the account has heard or marked. It writes no
profile evidence and no generation of its own. `user_preference.for_you_temperature`
holds the account's temperature (`safe`, `balanced`, or `adventurous`; NULL is
balanced). Every drawn work is a `recommendation_event` impression with
`surface = 'for_you'` and the column as `context_id`; opens report the same
surface. Impressions of the last three days not followed by an open or play
lower a work's score in later draws. Library events use `surface = 'library'`,
and the recommendation activity report reads only those. A Demo draw
(`algorithmVersion` `demo`) samples the admitted local works at random, each
column preferring works the other columns do not show, with example reasons
from each work's DLsite rating or circle and random scores. It records no
impression, saves no temperature, and reads no profile or generation.
