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

The toolbar starts collapsed by default; a capture shortcut (Pick/Multi/Area)
expands the dock and starts the capture instead of failing silently. The
initial UI and the built-in actions are configurable on the Vite plugin and on
`mountAgentAnnotations()`:

```ts
// Minimal builtins: keep only Pick and Copy, move Pick to Ctrl+Alt+X.
agentAnnotations({
  builtins: {
    multi: false,
    area: false,
    markers: false,
    help: false,
    list: false,
    collapse: false,
    shortcuts: { pick: { key: "X", code: "KeyX", primary: true, alt: true, shift: false } },
  },
});

// No builtins at all: only third-party extensions are mounted.
agentAnnotations({ builtins: false });

// Explicit initial UI state (default: { collapsed: true, markersVisible: true }).
agentAnnotations({ initialState: { collapsed: false } });
```

Unconfigured builtins stay enabled; disabling one removes its toolbar entry,
panel, and shortcut together, and shortcut overrides still run through the
extension registry's conflict validation. UI preferences are never written to
the task file.

## Quick start (5 minutes)

1. **Install** (`pnpm add -D @gchust/agent-annotations`), add the Vite plugin
   and the CLI binary.
2. **Register an extension** that defines a toolbar action (see
   [Minimal client extension](#minimal-client-extension)).
3. **Run the dev server** — the studio dock appears on the page.
4. **Capture**: pick an element with `Ctrl+Alt+P`, type a comment, save. The
   task lands in `.agent-annotations/tasks/active-task.json`.
5. **Hand off**: the browser runtime stays in sync; a code agent edits the
   source, then runs `agent-annotations wait --browser-update-revision <generation>` —
   the browser waits for the applied update, then
   `agent-annotations complete <id> --verified --summary <text>`.

## Manual runtime and custom transports

Without Vite, mount the runtime directly with any `TaskTransport`:

```ts
import {
  mountAgentAnnotations,
  createValidatedTaskTransport,
  type AgentAnnotationsMutationRequest,
  type AgentAnnotationsTask,
} from "@gchust/agent-annotations";

// Your transport owns the task storage; the runtime validates and redacts
// every read/mutate crossing this boundary.
declare const task: AgentAnnotationsTask;
declare const persistMutation: (
  request: AgentAnnotationsMutationRequest
) => Promise<AgentAnnotationsTask>;

const mounted = await mountAgentAnnotations({
  transport: createValidatedTaskTransport({
    read: async () => task,
    mutate: persistMutation,
  }),
});
```

Every mutation is validated and redacted before your transport sees it. The
CLI is authoritative for the task file and handoff when the transport shares
the same runtime task files under `.agent-annotations` (the Vite and file
stores do); a fully custom remote transport must bring its own CLI-equivalent
authority.

## Configuration

```ts
agentAnnotations({
  builtins: { help: false },                       // toggle built-in actions
  initialState: { collapsed: false, markersVisible: true },
  screenshotEvidence: "auto",                      // "auto" | "manual" | "off"
  diagnostics: { console: true, network: true },   // both default true
});
```

- `builtins`: configure or disable the built-in toolbar contributions.
- `initialState`: `collapsed` and `markersVisible` defaults.
- `screenshotEvidence`: background evidence capture, manual editor capture, or
  off.
- `diagnostics`: gate console-error and network-failure capture (network
  stores only origin+path, never bodies/headers/auth).

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
import { fileURLToPath } from "node:url";
import agentAnnotations from "@gchust/agent-annotations/vite";
import { defineConfig } from "vite";

// Node >= 20: fileURLToPath(new URL(...)) works on every supported minor.
export default defineConfig({
  plugins: [agentAnnotations({
    clientExtensions: [fileURLToPath(new URL("./src/annotation-extension.ts", import.meta.url))],
  })],
});
```

## Node tooling without the browser runtime

The root export keeps the browser runtime plus the core API, but Node tools
(task file manipulation, validation, mutation, redaction, formatting,
handoffs, ids, selection, placement, selectors, shortcuts) can import the
pure, host-neutral `@gchust/agent-annotations/core` subpath instead. `/core`
never imports React, React DOM, Vite, or Node built-ins, so it runs in a
consumer that has none of them installed:

```ts
import {
  parseAgentAnnotationsTask,
  formatAgentAnnotationsTaskMarkdown,
  redactAgentAnnotationsTask,
} from "@gchust/agent-annotations/core";
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
agent-annotations status [--json] [--check] [--runtime <runtime-id>|--route <route-key>]
agent-annotations revision [--json]
agent-annotations wait --browser-update-revision <integer> [--runtime <runtime-id>|--route <route-key>] [--timeout-ms <n>] [--json]
agent-annotations wait --referenced-source-revision <sha256> [--timeout-ms <n>] [--json]
agent-annotations diagnostics [--json|--clear]
agent-annotations evidence [--json|--prune [--json]]
```

`validate-task` strictly validates the persisted task file with the schema
parser and reports the task id, revision, schema, and valid state; it never
claims anything about the browser or the running dev server. `--json` prints
exactly one parseable JSON value on stdout; without it the CLI prints stable
human-readable text; errors go to stderr with stable exit codes.

`status [--json] [--check]` reports task validity, session presence, all fresh
browser runtimes, the selected runtime, browser
connection, task synchronization, browser update generation, disk-computed
referenced-source revision, browser-reported referenced-source revision, and
whether referenced-source synchronization is available. When no source files
are known, the revision and synchronization fields are `null`; this does not
make `status --check` fail. With multiple fresh runtimes, pass the exact
`--runtime <runtime-id>` or safe `--route <route-key>`; otherwise status and
browser-update waits fail with `ambiguous_browser_runtime` rather than choosing
a last writer. `wait --browser-update-revision <integer>` waits for the selected
fresh browser generation above the baseline, while `wait
--referenced-source-revision <sha256>` watches known referenced files and
returns an explicit unavailable result when none are known.

The default `Copy` action emits a Code-Agent handoff instead of a data dump:
instructions, the browser update generation baseline and supplementary
referenced-source revision (or explicit unavailable values — a SHA is never invented), and an exact
`complete --verified --summary` command per annotation. The loop is:

```text
# 1. the agent edits real source files (never active-task.json)
# 2. wait until the browser actually applied the change
agent-annotations wait --browser-update-revision <generation> --json
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
`.agent-annotations` (with `--clear` emptying only diagnostics), including
privacy-safe network failures (transport, method, status, and the sanitized
origin+path URL — never queries, bodies, headers, or auth); `evidence`
lists task-referenced screenshot files with their annotation ids and never
touches files outside the runtime evidence directory. `revision` reports the
task revision, `referencedSourceRevision` (or `null`), and canonical referenced
files. The two wait modes return their named observed field and use the same
bounded (30 second) timeout.

## Localization

All built-in user-visible text (toolbar, tooltips, composer, editor, list,
statuses, reasons, confirmations) ships in the `en-US` and `zh-CN` message
dictionary (`src/client/messages.ts`). The runtime resolves the dictionary
against the host locale (`host.locale()`, else `<html lang>`):

```ts
import { defineClientExtension } from "@gchust/agent-annotations/extension";
import { mountAgentAnnotations, type TaskTransport } from "@gchust/agent-annotations";

declare const myTransport: TaskTransport;

const localeHost = defineClientExtension({
  id: "host",
  apiVersion: 1,
  host: {
    locale: () => "zh-CN",
    messages: { "Pick": "Select" }, // overrides the built-in key
  },
});

const mounted = await mountAgentAnnotations({
  transport: myTransport,
  extensions: [localeHost],
});
```

The public snapshot's `messages` are merged as
builtin dictionary → registry messages → host `messages`, so a host can
override any built-in key (`host.messages` above). With the Vite plugin,
register the host extension through `clientExtensions` instead.

A locale switch re-renders in place: the Studio never remounts and an open
composer/editor draft survives. Multi-target annotations show `resolved/total`
with a stable reason key (`unresolved`, `identity mismatch`,
`identity unverifiable`, `iframe unsupported`) in the marker tooltip, the
editor, and the list; the list also shows route, kind, and evidence count with
the default Open filter preserved.

Page context is query-free by default: annotation URLs store only
`origin + pathname`, while route keys store `pathname + hash`. A host that
needs tenant or filter identity can return an explicit, allowlisted business
key from `pageContext()`; its `url`, `routeKey`, and `title` overrides are
bounded and validated, and raw query parameters are never accepted. Invalid
or throwing overrides fall back to the safe defaults and produce a bounded
extension diagnostic without breaking capture.

## Runtime diagnostics (console and network)

While mounted, the runtime records `console.error` output and failed network
requests (fetch rejections and 4xx/5xx responses, XHR errors/aborts/timeouts
and 4xx/5xx responses) into the bounded, redacted diagnostics persisted under
`.agent-annotations`. Both are enabled by default and can be gated explicitly:

```ts
agentAnnotations({ diagnostics: { network: false } }); // console only
agentAnnotations({ diagnostics: { console: false } }); // network only
```

Network entries are privacy-safe: the URL is reduced to `origin + pathname`
(query strings and fragments are dropped, and any secrets in them never reach
the diagnostics), no request/response bodies, headers, or cookies are ever
captured, the failure reason is a fixed package-owned label (arbitrary error
text is never embedded, since it could itself contain a sensitive full URL or
query), and the package's own endpoint is suppressed. The fetch/XHR patch is
installed only while the runtime is mounted, preserves the original
return/throw/event behavior, and is removed identity-safely on unmount and on
repeated hot-reload mounts (it never stacks).

## Extension failure isolation

Third-party contributions are isolated at the runtime boundary: a faulty
contribution disables its own registered surface (toolbar entry, shortcut,
panel, host integration, exporter, redactor, or message) and never breaks the
built-in capture/list flows. This covers the registered contributions and
runtime callbacks; arbitrary side effects a `setup` already produced outside
that surface before throwing cannot be rolled back.

- `setup` throwing rolls the extension's registered contributions back
  atomically (toolbar, shortcuts, panels, host integration, exporters,
  redactors, and messages are all removed) and mounting continues; the
  trusted built-in fails fast.
- `isVisible` throwing hides the contribution, `isEnabled` throwing disables
  it, `isPressed` throwing leaves it unpressed, a throwing `icon` renders a
  safe fallback, a throwing `panel` render shows the closable error panel,
  and `pageContext`/`execute`/`enrich`/`export`/`redact` failures are caught with the
  existing per-phase semantics.
- `dispose` throwing never blocks the remaining cleanup, and the structured
  dispose diagnostic still reaches the diagnostics boundary.
- Every failure is recorded once per `(extensionId, phase, contributionId)`
  into the bounded, redacted diagnostics with the phase locatable in
  `extensionId`/`contributionId`/`phase` fields; high-frequency predicate
  errors can never flood the diagnostics.
- `getSnapshot()` returns a deep clone that is deeply frozen: extensions
  cannot mutate the task, diagnostics, shortcuts, exporters, or messages, and
  the extension's own config objects are never frozen.

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
