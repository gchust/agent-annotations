# Agent Annotations

Developer-only visual annotations handed to Code Agents in React/Vite applications.

## Install

Agent Annotations requires Node 20 or newer, React 19, React DOM 19, and Vite 6:

```sh
pnpm add -D @gchust/agent-annotations
```

The package is ESM-only. Vite is optional when the root runtime is embedded
with a custom `TaskTransport`.

## Vite

Register the development-only plugin; it injects the client automatically, so
the application entry point needs no Agent Annotations code:

```ts
import agentAnnotations from "@gchust/agent-annotations/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agentAnnotations()],
});
```

Screenshot evidence mode is configurable on both the plugin and
`mountAgentAnnotations()`: `screenshotEvidence: "auto" | "manual" | "off"`
(default `"auto"`). `auto` captures best-effort evidence in the background
right after an annotation is saved (the save never waits for it); `manual`
skips automatic capture and exposes the `Capture screenshot` action in the
annotation editor plus `studio.commands.annotations.captureEvidence(id)`;
`off` disables capture entirely — no entry, no page cloning. Invalid values
throw a `TypeError` at plugin/mount time.

The package root exports the host-neutral `agent-annotations.task.v1` core and
`mountAgentAnnotations()` browser runtime. Public contracts are also available
from `@gchust/agent-annotations/types`; `MemoryTaskTransport` is available only
from `@gchust/agent-annotations/testing` for tests and playgrounds.

## Minimal client extension

Create `src/annotation-extension.ts` using only the public extension entry:

```ts
import { defineClientExtension } from "@gchust/agent-annotations/extension";

export default defineClientExtension({
  id: "example.copy",
  apiVersion: 1,
  toolbar: [{
    id: "copy-open",
    group: "handoff",
    label: "Copy open annotations",
    icon: () => null,
    kind: "action",
    execute: ({ studio }) => studio.commands.annotations.copyOpen(),
  }],
});
```

Register its absolute browser-module path with the Vite plugin:

```ts
import path from "node:path";
import agentAnnotations from "@gchust/agent-annotations/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [agentAnnotations({
    clientExtensions: [path.resolve(import.meta.dirname, "src/annotation-extension.ts")],
  })],
});
```

## CLI

The CLI reads `active-task.json` from the resolved runtime data directory
(`.agent-annotations` by default), which always uses `agent-annotations.task.v1`:

```text
agent-annotations --root <path> --dir <path> <command> [options]
agent-annotations list [--json]
agent-annotations complete <annotation-id> --verified --summary <text>
agent-annotations reopen <annotation-id>
agent-annotations print [--json|--markdown]
agent-annotations validate-task [--json]
agent-annotations status [--json] [--check]
agent-annotations revision [--json]
agent-annotations wait --source-revision <sha256> [--timeout-ms <n>] [--json]
agent-annotations wait --browser-source-revision <sha256> [--timeout-ms <n>] [--json]
agent-annotations diagnostics [--json|--clear]
agent-annotations evidence [--json]
```

`validate-task` strictly validates the persisted task file with the schema
parser and reports the task id, revision, schema, and valid state; it never
claims anything about the browser or the running dev server. `--json` prints
exactly one parseable JSON value on stdout; without it the CLI prints stable
human-readable text; errors go to stderr with stable exit codes.

`status [--json] [--check]` reports the development-loop state: task validity,
session presence, browser connection (fresh heartbeats within 15 seconds),
task synchronization, source synchronization (the browser-reported applied
source revision vs the referenced-source revision), plus ids, revisions,
route, last heartbeat, and diagnostic count. Without `--check` it is purely
informational and exits 0 even with no browser; `--check` exits 1 unless
task, browser, task synchronization, and source synchronization are all
healthy. `wait --browser-source-revision <sha256>` waits until the
browser-applied source revision moves off the baseline (a missing or stale
browser never counts as applied), while `wait --source-revision` keeps
waiting on the referenced-source revision computed from disk.

The default `Copy` action emits a Code-Agent handoff instead of a data dump:
instructions, the browser-applied source revision baseline (or exactly
`source revision unavailable` without one — a SHA is never invented), and an exact
`complete --verified --summary` command per annotation. The loop is:

```text
# 1. the agent edits real source files (never active-task.json)
# 2. wait until the browser actually applied the change
agent-annotations wait --browser-source-revision <sha256> --json
# 3. the full runtime is synchronized and healthy
agent-annotations status --check --json
# 4. the task file itself is valid
agent-annotations validate-task --json
# 5. only after verification passes, complete the annotation
agent-annotations complete <annotation-id> --verified --summary "<text>"
```

The handoff is configurable and strictly bounded (`handoff: { command,
verificationCommands, includeCompleted }` on the Vite plugin and
`mountAgentAnnotations()`); it only formats text and never executes
anything. The default includes open annotations only.

The workspace root and the runtime data directory are resolved separately.
`--root`/`AGENT_ANNOTATIONS_ROOT` set the workspace root; `--dir`/
`AGENT_ANNOTATIONS_DIR` set the runtime data directory (their existing
meaning). Without explicit paths, the CLI discovers the nearest ancestor
`.agent-annotations/session.json` written by the Vite plugin, then falls back to
the nearest ancestor workspace (a directory containing `package.json` or
`.git`), then the current directory. Running from a monorepo subdirectory keeps
`revision` and `wait` anchored to the session's workspace root.

`diagnostics` prints the bounded redacted browser diagnostics persisted under
`.agent-annotations` (with `--clear` emptying only diagnostics); `evidence`
lists task-referenced screenshot files with their annotation ids and never
touches files outside the runtime evidence directory. `revision` reports the
exact task revision, the sha256 of the referenced canonical source files, and
those files; `wait` treats the given sha256 as a baseline and returns
`{ changed: true, sourceRevision }` as soon as the referenced-source revision
moves off it, or `{ changed: false, sourceRevision }` when it stays until the
bounded (30 second) timeout.

## Security

The Vite API binds to loopback by default, requires a random private session
token, and validates Host plus Origin/Referer. Set `allowRemote: true` only on a
trusted development network. Runtime data is stored under `.agent-annotations`;
do not commit it. The client does not collect form values, cookies,
Authorization headers, request bodies, or response bodies.

Generic redaction is the final persistence boundary: every mutation path
(browser, CLI, Vite API, and direct store calls) passes through
`prepareAgentAnnotationsTaskForPersistence()` (Parse → Generic Redaction →
Parse) before atomic write, so update comments, `setExtension` data,
completion summaries, and evidence metadata cannot persist secrets.

Before that final boundary, the built-in runtime also redacts every delegated
mutation: `redactAgentAnnotationsMutationRequest()` validates the current task
and the request, redacts every data-carrying operation, and re-validates the
redacted payload before any custom `TaskTransport` sees it. Extension
redactors run on the client and are composed deterministically in stable
`(extensionId, redactorId)` order; generic redaction runs before and after
them, and a faulty redactor fails closed for its own namespace. Screenshot PNG
bytes are never string-redacted; the capture sanitizer and the server-side PNG
boundary handle screenshot privacy.

Custom persistent transports must call `prepareAgentAnnotationsTaskForPersistence()`
(or an exactly equivalent boundary) before writing to a database, object
store, or file. The library redacts everything it delegates and everything it
persists itself, but it cannot control what a transport does internally:
redaction guarantees apply to Runtime-originated requests and to data written
through the official helper, not to arbitrary third-party writes.

Extension setup receives `{ studio }`
only — raw `TaskTransport` is never exposed to extensions. The CLI is scoped to
the resolved runtime data directory and does not execute shell commands or
expose arbitrary file reads.

## Release verification

`pnpm release:verify` runs the full release gate: typecheck, unit tests,
architecture audit, docs smoke, package checks, tarball audit, and a packed
consumer E2E. `pnpm pack` always rebuilds and verifies the required `dist`
entries first through the `prepack` lifecycle, so a clean checkout without
`dist` still produces a complete tarball.

## API reference

See [API.md](./API.md) for the public root, Vite, extension, types, testing, and
browser-transport entries.

## Limitations

- Development only: production builds exclude the injected runtime and API.
- React 19 and Vite 6 are the supported first-release peer ranges.
- Same-origin iframes and open Shadow Roots are supported; closed Shadow Roots
  and cross-origin frames are reported unresolved.
- Screenshot evidence is best-effort structural evidence, not pixel-perfect
  page capture.
- This alpha uses only `agent-annotations.task.v1`; it does not read or migrate
  previous host-specific schemas, directories, endpoints, or capture tools.
