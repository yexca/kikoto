# Frontend Structure

The frontend stack, the dependency direction and module boundaries new code
keeps, the build and API client rules, and where failures are contained.

## Stack

- React.
- TypeScript.
- Vite.
- Tailwind CSS 4 with PostCSS and matching `tailwind-merge` utilities.
- Local shadcn-style primitives.
- lucide-react icons.

The web app and Android WebView require modern CSS support (Chrome 111+,
Safari 16.4+, or Firefox 128+), following the
[Tailwind browser requirements](https://tailwindcss.com/docs/compatibility).

Non-English translation resources and their surface labels live in separate
language modules loaded on demand. The English fallback must not synchronously
import a module that also owns deferred languages, or those languages enter the
initial bundle despite the dynamic resource entry points. Each deferred locale
module owns its own copy, and a unit test keeps other scripts out of the English
modules apart from the language picker's native labels.

## Code Organization

New and extracted frontend code follows a downward dependency direction:

```text
app and pages -> domain features, player -> shared application code -> UI primitives
```

- `app` and page shells compose navigation, providers, and domain surfaces.
- `features/<domain>` owns a cohesive business slice such as work detail,
  workflows, or maintenance. Sibling features should not deep-import each
  other's internals.
- `player` owns the global player, which stays mounted across navigation.
- `components`, reusable hooks, and `lib` hold application-wide behavior with no
  single domain owner.
- `components/ui` contains generic primitives and must not acquire work, source,
  or workflow knowledge.

Oxlint's `kikoto/dependency-direction` rule in
`frontend/oxlint-plugin-kikoto.mjs` enforces the direction outside tests:
`components`, `hooks`, and `lib` never import `features`, `pages`, `app`, or
`player`; `features` and `player` never import `app` or `pages`;
`components/ui` also never imports other components, hooks, or `auth`; and a
feature imports another feature only through its public entry
(`@/features/<domain>`). The rule's `crossFeatureAllowance` lists the deep
imports that predate it. It only shrinks, and a unit test fails when an entry
no longer matches an import.

This is an incremental extraction direction, not a request for a repository-wide
move. A domain earns its own feature boundary after it owns a real page or flow
and several mostly private components, models, or hooks. App composition or a
small shared contract should resolve cross-domain needs.

Navigation and browse state that the shell, pages, features, and the player
share lives in `lib`: page ids and addresses (`lib/appPages`), the page a
location belongs to (`lib/appRoutes`), work detail routes and events, mobile
tab snapshots, opening the playing work, remote track events, circle and voice
route helpers, Library browse state, and Library search clauses.
`app/navigation` adds each page's label, icon, audience, and sidebar group,
and a unit test keeps its entries matching `lib/appPages`. The app header's
back action and title slots (`components/pageHeader`) and the not-found page
(`components/NotFoundPage`) are shared components that the shell renders and
detail pages fill.

Work detail metadata editing exposes its public entry from
`features/work-detail/metadata`. Its modal owns interaction and save actions,
suggestion hooks own asynchronous lookup, and a pure model maps editor state
to metadata overrides. Work detail and the Metadata page compose that entry
instead of owning its internals.

Workflow surfaces that other pages compose, such as the catalog sync dialog,
a remote source's library work check, and the Availability Watch
configuration, live in `features/workflows`. The addresses of Workflows live in
`lib/workflowLinks`, which shared code and every feature can import: they build
the address of Workflows or a run with `workflowsPath` and `workflowRunPath`
and open a run with `openWorkflowRun` rather than spelling an address or
writing it to browser history themselves. The `kikoto-workflow-links` Oxlint
rule, defined in `frontend/oxlint-workflow-links.mjs`, rejects an address
written anywhere else.

## Build and Caching

The production build keeps React, i18next, and `tailwind-merge` in a separate
`vendor` chunk so a release that changes only app code leaves it cached; list
only libraries the entry already loads there, because everything in that chunk
loads eagerly.

The production build stamps `public/sw.js` with a build id derived from the
version and the emitted file names. Each build therefore owns one service
worker cache, and activating a new worker deletes the previous build's cache
instead of keeping its hashed assets.

## API Client

The API client lives in `lib`. `lib/apiTransport` owns the authenticated request
functions: base URL and asset URLs, credentials, session fencing, shared
in-flight reads, and error mapping. JSON and plain-text API reads share browser
cookie or native bearer authentication. Each domain module (`lib/*Api`)
declares its response types beside its requests. A domain module imports the
transport and, for types only, a domain it builds on; none imports `lib/api`.
`lib/api` composes the domain modules into the single `api` object and
re-exports their types, and is the entry pages, features, and tests import.

## Failure Boundaries

The global player and app shell are continuity infrastructure. Route and domain
error boundaries should sit inside them so a render failure in Library,
Settings, or a remote panel does not stop playback or discard navigation.

Fallbacks must use sanitized copy and offer a relevant recovery action. Raw
stacks, upstream bodies, private endpoints, and local paths are diagnostic data,
not anonymous UI. A page that already has useful local data should keep it
visible while the failed remote or media stage renders an inline Retry state.

Shared API reads, including plain-text previews, belong to a server and session
generation. Account, session, credential, and server changes reject their old
results and errors, including response bodies still being decoded. Each caller
can cancel independently.
Writes fence reuse both when they start and when their response body settles;
progress and other personal writes leave current directory reads running.
A local-directory refresh or source untracking can interrupt that work's shared
read. A still-current caller waits for the write to settle and automatically
retries, at most twice, preserving the detail shell and global player. Session
changes, caller cancellation, and ordinary network or API failures do not
trigger this recovery. Background workflow completion uses the explicit refresh
paths; in-flight sharing does not cache settled responses.

Retained workflow run snapshots and event streams belong to the same session
generation. A session change clears the snapshots immediately, stops their
streams and polling, rejects pending run-settlement waits, and rebinds mounted
views to the current session. An authentication, permission, or not-found
response clears the run, events, and review candidates; a temporary failure
within the same session keeps the last known snapshot for retry.
