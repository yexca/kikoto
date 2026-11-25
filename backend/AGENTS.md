# Backend Agent Guide

The root [`AGENTS.md`](../AGENTS.md) invariants apply here. Schema changes also
follow [`migrations/AGENTS.md`](migrations/AGENTS.md). The
[backend](../docs/architecture/backend.md),
[workflows](../docs/architecture/workflows.md), and
[data model](../docs/architecture/data-model.md) indexes list their topic pages;
open only the page a change needs.

## Layering

Dependencies point from HTTP composition toward domain and storage code:

```text
httpapi composition -> domain packages -> shared helpers -> primitives
```

- Handlers own transport: auth context, decoding, encoding, status mapping.
  Move reusable state transitions, filesystem transactions, source adapters,
  and workflow persistence into focused `internal/` packages once they are
  independently testable. Do not add unrelated orchestration to large handler
  files; extract by cohesive behavior, not by mechanically moving a file.
- A package with several outside consumers exposes a small explicit entry.
- `make backend-sql-ratchet`, part of `ci-backend-static`, counts the SQL
  statements `internal/httpapi` runs itself (`database/sql` exec, query and
  prepare calls, and `sqlutil.InsertID`/`SelectID`) against
  `scripts/httpapi-sql-baseline.json`. A package function or named closure
  that passes one of its string parameters into a statement, such as
  `execBestEffort`, counts once per call instead, so a wrapper hides no
  statement. `-helpers` lists the wrappers it found. The count may only fall: put new
  queries in a domain package and never raise the baseline. After an
  extraction, run `make backend-sql-ratchet-lower` and commit the lower
  baseline with it.
- Rationale and package map:
  [Code Organization](../docs/architecture/backend/stack-and-packages.md#code-organization),
  [Main Packages](../docs/architecture/backend/stack-and-packages.md#main-packages),
  [Backend Guidelines](../docs/development/backend-guidelines.md#principles).

## Outbound HTTP

An administrator-configured endpoint is trusted configuration and may be a
private LAN address. URLs, redirects, headers, and metadata it returns are
untrusted. For every new or materially changed outbound path:

- Route it through the shared transport in `internal/outbound` and define its
  destinations. The transport existing does not cover a new path; document
  the stronger contract only after the path uses the policy and has tests.
- Accept only HTTP(S) URLs; reject embedded credentials.
- State whether the destination stays on the configured origin or may use an
  explicit allowlist. Do not follow arbitrary redirects: validate every hop
  and drop credentials once a redirect changes origin.
- When untrusted input can influence the hostname, validate the resolved
  addresses and connect to the same validated address (DNS rebinding).
- Bound timeouts, buffered metadata responses, streamed bytes, concurrency,
  and retries. Stream large media to a bounded destination; never buffer it.
- Keep detailed upstream errors in protected logs or Activity. Public API and
  UI errors never reveal credentials, private endpoints, or local paths.

Required tests: private and reserved addresses, redirects, response limits,
cancellation, and the explicitly configured private-origin exception.

Full policy, proxy handling, and per-feature boundaries:
[Outbound HTTP](../docs/development/security.md#outbound-http),
[Errors, Logs, and Diagnostics](../docs/development/security.md#errors-logs-and-diagnostics),
[Outbound Requests](../docs/architecture/backend/outbound-requests.md#outbound-requests).

## Which Section To Open

| Change | Section |
| --- | --- |
| HTTP routes, error shape | [API Shape](../docs/architecture/backend/api-shape.md#api-shape), [HTTP Responses](../docs/architecture/backend/http-responses.md#http-responses) |
| Auth, permissions, mutations | [Authentication and Mutations](../docs/development/security.md#authentication-and-mutations) |
| Filesystem moves, fetch, trash | [Filesystem Operations](../docs/development/security.md#filesystem-operations), [Fetch Publication](../docs/architecture/workflows/fetch-queue-and-review.md#fetch-publication) |
| Scan, pools, availability | [Library Layout and Onboarding](../docs/architecture/workflows/library-layout-and-onboarding.md#library-layout-and-onboarding), [Source Presence Check](../docs/architecture/workflows/source-availability.md#source-presence-check) |
| Workflows, queueing | [Model](../docs/architecture/workflows/built-in-workflows.md#model), [Queue Ordering](../docs/architecture/workflows/fetch-queue-and-review.md#queue-ordering) |
| Tables and modeling | [Modeling Rules](../docs/architecture/data-model/modeling-rules.md#modeling-rules) and the matching data-model section |
| Go tests | [Backend](../docs/development/testing.md#backend), [Choose the Lowest Sufficient Layer](../docs/development/testing.md#choose-the-lowest-sufficient-layer) |
