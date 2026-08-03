# Testing

The goal is the smallest test set that gives strong confidence in a real
behavior or stable contract. Before adding a test, state the regression it is
meant to catch.

## Value Gate

A test is valuable when all of these are true:

1. It protects user-visible behavior, a documented contract, a security
   boundary, a state transition, or a previous regression.
2. A realistic production-code defect would make it fail.
3. The behavior is not already covered at a more appropriate layer.
4. It can survive an internal refactor that preserves behavior.

Business rules, authorization, persistence, recovery, loading/error states,
keyboard behavior, and bug fixes normally require coverage. A pass-through
wrapper, type-only change, or purely visual adjustment normally does not need a
new test unless it changes a documented responsive or accessibility contract.

## Choose the Lowest Sufficient Layer

| Behavior | Preferred layer |
| --- | --- |
| Pure parser, mapper, reducer, queue rule, or state machine | Unit test beside the source |
| Go domain or persistence transition | Package test against the real service or store |
| HTTP authentication, validation, or response contract | Handler/API test |
| Browser interaction, focus, responsive layout, or navigation | Playwright |
| Migration chain, restart, process, or container behavior | Integration or dedicated process test |

Do not repeat every pure-helper branch in Playwright. Conversely, a unit test of
a mocked callback does not prove that a user can complete the browser workflow.

## Backend

```sh
cd backend
go test ./...
go vet ./...
go test -race ./...
```

Backend tests are organized by boundary:

- Package unit tests stay beside the production files as `*_test.go`. They may
  use the production package name when they need to verify unexported logic.
- Public API and cross-package database tests live under
  `backend/tests/integration` and use an external `integration_test` package.
- Process, container, and restart-interruption tests should live in a dedicated
  suite under `backend/tests` instead of importing handler internals.

Do not export production identifiers only to move a white-box test into the
integration suite. Extract a domain service first, then test its public
contract.

## Frontend

```sh
cd frontend
npm install
npm audit --audit-level=moderate
npm run format:check
npm run lint
npm run test:unit
npm run build
npm run test:e2e
```

Vitest unit tests stay beside their source under `frontend/src`.
Playwright browser tests live under `frontend/tests/e2e`; Android JVM and device
tests use the standard Gradle `src/test` and `src/androidTest` source sets.
CI installs Chromium and runs the complete Playwright project after the
frontend unit and production-build gates.

Current Vitest coverage is primarily pure state and model logic. User-visible
React interaction belongs in Playwright until a real component-test environment
is introduced; do not build a large fake component runtime inside a unit test.

## Assertions and Locators

Assert observable behavior: returned data, persisted state, visible content,
accessible name, focus, disabled state, navigation, playback continuity, or an
external request boundary.

For Playwright, prefer locators in this order:

1. `getByRole` with an accessible name.
2. `getByLabel`.
3. User-visible text when copy is part of the contract.
4. An authored stable semantic marker or `data-testid` for an app-owned region.
5. CSS selectors only for a documented visual or third-party-widget contract.

Avoid DOM-parent traversal, Tailwind utility selectors, and fixed sleeps when a
semantic locator and user-observable completion condition exist. A CSS/class
assertion should include or point to the design/layout contract it protects.

Mock the narrowest external boundary needed for determinism: network, clock,
filesystem, process, or browser API. Do not mock the subject under test or
recreate production behavior inside the mock.

## Regression Review

A bug-fix test should identify:

- The user-visible failure or violated contract.
- The smallest setup that reproduces it.
- The assertion that fails before the fix.

Reject tests whose only claim is that a component renders, children are passed
through, a mock placeholder exists, or a large snapshot changed. Snapshots are
appropriate only when the small serialized output is itself the reviewed public
contract.

## Smoke Test

```sh
make smoke
```

## Before Committing

- Run relevant tests.
- Run `cd frontend && npm run docs:check-links` for public documentation changes.
- Check `git status`.
- Review staged changes for secrets, real source details, private paths, logs,
  databases, and runtime data.
- Update public docs for behavior changes.

## Suggested Routine

For a backend-only change:

1. Run `cd backend && go test ./...`
2. Review affected public docs.
3. Check git-tracked changes for sensitive paths or data.

For a frontend-facing change:

1. Run backend tests if API behavior changed.
2. Run frontend lint, unit tests, and the production build.
3. Run the relevant Playwright project for interaction changes.
4. Check the affected product docs and README links.

## Related Docs

- [Local development](local-dev.md)
- [Secure development](security.md)
- [Commit and release](commit-and-release.md)
