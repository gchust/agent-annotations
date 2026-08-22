# API reference

The release gate validates these public entries from one checksummed tarball;
package, Node consumer, and browser consumer checks do not repack it.

## `@gchust/agent-annotations`

- `mountAgentAnnotations(options)` mounts the React runtime and returns
  `{ api, unmount, reportBrowserUpdate }`. `options.transport`
  implements `TaskTransport`; optional `options.extensions` uses public client
  extensions. `options.screenshotEvidence`
  accepts `"auto" | "manual" | "off"` (default `"auto"`): `auto` captures
  best-effort screenshot evidence in the background after every save (the save
  never waits for it), `manual` exposes `studio.commands.annotations.captureEvidence(id)`
  and the editor's `Capture screenshot` action, and `off` disables capture
  entirely. Invalid values throw a `TypeError`. `options.browserStatus`
  (`{ endpoint, token }`) enables the authenticated browser runtime status
  heartbeat (`.agent-annotations/browser-states/<runtimeId>.json`).
  `reportBrowserUpdate()` is a trusted mount-level hook (used by the
  generated Vite client after mount and after `vite:afterUpdate`): it re-fetches
  the current source revision through the runtime-owned, generation-guarded
  refresh path and reports it as applied. It is not part of `StudioPublicApi`,
  so extensions cannot spoof the applied revision.
- `StudioPublicApi.commands.annotations.targetSummary(annotationId)` returns the
  annotation's resolution summary `{ resolved, total, reason }` where `reason`
  is one of `"unresolved"`, `"identity mismatch"`, `"identity unverifiable"`,
  `"iframe unsupported"`, or `null` when every target resolves.
  `StudioPublicApi.commands.markers.highlight(annotationId | null)` temporarily
  highlights every resolved target of an annotation without opening the editor
  (the built-in annotation list uses both for its per-item resolution rows and
  focus preview; `null` clears the highlight).
- `TaskTransport` requires `read`/`mutate` and may add `writeEvidence`,
  `subscribe`, and `appendDiagnostics` (browser diagnostics are persisted
  through `HttpTaskTransport` and bounded/redacted server-side).
- Mount options accept `diagnostics?: { console?: boolean; network?: boolean }`
  (both default to `true`): `console` gates `console.error` capture and
  `network` gates the fetch/XHR failure patch. Network diagnostics persist
  `method`, `status`, `transport`, and the sanitized origin+path URL only
  (query, fragment, bodies, headers, and auth are never captured); the
  package's own endpoint is suppressed and the failure reason is a fixed
  label, never arbitrary error text. The patch is one shared process-wide
  wrapper, ref-counted across mounts: installed on the first subscriber and
  restored identity-safely on the last unsubscribe, so simultaneous or
  repeated mounts never stack wrappers and a foreign wrapper installed over
  ours can never cause double-emissions.
- `createAgentAnnotationsTask`, `parseAgentAnnotationsTask`,
  `validateAgentAnnotationsTask`, and `isAgentAnnotationsTask` own schema v1.
- `formatAgentAnnotationsHandoff(task, options)` is the default Copy output:
  a pure Code-Agent execution contract (instructions, browser-applied source
  revision baseline or exactly `source revision unavailable`, evidence refs,
  pinned runtime/route/annotation/diagnostics baselines, and exact
  `complete --verified --summary-file` commands per annotation).
  `validateAgentAnnotationsHandoffConfig(input)` strictly bounds the
  JSON-safe `handoff` option (`command`, `verificationCommands`,
  `includeCompleted`) and rejects unknown keys, control characters, and
  oversized items; it only shapes text and never executes.
- `applyAgentAnnotationsMutation` applies revision-checked task operations.
- `formatAgentAnnotationsTask` emits Markdown or JSON.
- `redactAgentAnnotationsTask` and `redactAgentAnnotationsText` remove generic secret
  material before persistence or export.
- `redactAgentAnnotationsMutationRequest(currentTask, request, redactors?)` is the
  pre-delegation boundary for mutations: it validates the current task and
  request, redacts every data-carrying operation (add/update/setExtension/
  complete/addEvidence) with generic redaction plus extension redactors in
  stable `(extensionId, redactorId)` order, and re-validates the redacted
  payload before the transport sees it. Faulty redactors fail closed for their
  own namespace.
- `prepareAgentAnnotationsTaskForPersistence(input)` is the official final
  persistence boundary for Node integrations: Parse → Generic Redaction →
  Parse. `FileTaskStore` uses it unconditionally; custom persistent transports
  must call it (or an exactly equivalent boundary) before writing.
- `createValidatedTaskTransport(transport)` wraps any `TaskTransport` so every
  task entering the runtime (read/mutate/writeEvidence/subscribe, including
  conflict payloads) is schema-parsed. Successful `mutate` and `writeEvidence`
  results must preserve the requested task ID and advance beyond the expected
  revision; `writeEvidence` must also retain its target annotation. Violations
  throw `TaskTransportProtocolError`. `read` and `subscribe` may replace the
  task identity. Write-evidence metadata is validated while PNG bytes pass
  through unredacted.
- `RevisionConflictError` is thrown by stores and transports on stale writes; it
  carries the parsed latest task plus expected/actual revisions and is
  `instanceof`-recognizable in the browser.
- The remaining root exports are pure ID, selection, placement, selector, and
  shortcut helpers plus their public types.

## `@gchust/agent-annotations/core`

Pure, host-neutral Node entry with no React, React DOM, Vite, or Node built-in
imports (and a built declaration closure free of React/DOM references): task
schema and validation (`parseAgentAnnotationsTask`, `validateAgentAnnotationsTask`,
`createAgentAnnotationsTask`, `isAgentAnnotationsTask`), mutation
(`applyAgentAnnotationsMutation`), formatting/handoff (`formatAgentAnnotationsTask`,
`formatAgentAnnotationsTaskMarkdown`, `formatAgentAnnotationsHandoff`),
redaction (`redactAgentAnnotationsTask`, `redactAgentAnnotationsText`,
`redactAgentAnnotationsMutationRequest`), ids, selection, placement,
selectors, shortcuts, and the pure task/core types (`AgentAnnotationsTask`,
`AgentAnnotation`, `AgentAnnotationFilter`, mutation, redaction, validation,
shortcut, selection, and placement types). It runs in a Node consumer with no
React installed and is the recommended import for Node tooling; the root
entry keeps the browser runtime plus the same core API.

## `@gchust/agent-annotations/vite`

The default export is `agentAnnotations(options)`. Options are `root`,
`dir`, `endpoint`, `allowRemote`, `clientExtensions` (absolute
browser-module paths), `screenshotEvidence` (`"auto" | "manual" | "off"`),
`handoff`, `builtins` (flat per-action booleans plus `shortcuts`),
`initialState` (`collapsed`, `markersVisible`), and `diagnostics`
(`console`/`network` toggles). The plugin applies only to Vite's development
server. `FileTaskStore` and `createSourcePathService` are exported for
controlled Node integrations.

## `@gchust/agent-annotations/extension`

- `defineClientExtension(extension)` defines a public extension without global
  mutation. `setup` receives `{ studio }` only; extensions reach the task through
  `StudioPublicApi` commands, never a raw transport.
- Author input keeps explicit local contribution IDs; the registry canonicalizes
  them internally to `<extensionId>:<localId>`. Toolbar/panel references resolve
  deterministically inside the owning extension, and the public snapshot and
  `StudioPublicApi` commands use the canonical IDs.
- `ClientExtensionRegistry` and `registerClientExtension` provide deterministic,
  atomic registration and disposal.
- Public contribution types cover toolbar actions, panels, target enrichers,
  exporters, redactors, locale messages, and one host integration. Multiple
  redactors per extension are composed deterministically in stable
  `(extensionId, redactorId)` order; duplicate `(extensionId, redactorId)` pairs
  are rejected.
- `HostIntegration` may expose `pageContext()`, `routeKey()`, `locale()`, `theme()`, `appRoot()`,
  `navigate(routeKey)`, and a single unified `subscribe(listener)` notification.
  The registry retains the host extension ID, and the runtime guards every host
  callback, message access, and subscription disposer. Faults record one
  bounded, redacted diagnostic and use safe defaults without disabling Pick,
  Marker, List, or Copy; an `identity()` fault yields no host identity for that
  element.
  `pageContext()` may return bounded `url`, `routeKey`, and `title` overrides;
  URLs must be absolute HTTP(S) values without credentials, query, or fragment,
  and route keys must be query-free. Use an allowlisted business key when tenant
  or filter identity matters; never return raw query parameters. Invalid or
  throwing overrides are diagnosed and fall back to `origin + pathname` and
  `pathname + hash`. `routeKey()` remains the route-only form when
  `pageContext()` is absent.
  `theme()` accepts `"light" | "dark" | "system"`; `system` follows
  `prefers-color-scheme` through a media listener that is bound while the system
  theme is active and released on switch or unmount. `appRoot()` accepts an
  `Element` or `Document` and defaults to `document.body`; observers, frame
  scanning, and capture hits are scoped to it. One `subscribe` notification
  re-reads route, locale, theme, and app root together; locale changes rebuild
  toolbar labels, tooltips, Help, and panel titles without remounting.
  Annotations persist the route key they were created on; markers render only on
  their own route. Without `subscribe`, the runtime observes `popstate`,
  `hashchange`, and patched `pushState`/`replaceState`, and removes those
  listeners and restores the patched methods on unmount.
- `mountAgentAnnotations` accepts `builtins?: false | AgentAnnotationsBuiltinsConfig`
  (per-action booleans plus `shortcuts` overrides, all JSON-safe validated) and
  `initialState?: { collapsed?, markersVisible? }` (default collapsed, markers
  visible). With `builtins: false` only third-party extensions mount; disabled
  builtins contribute no toolbar entry, panel, or shortcut, and shortcut
  overrides still pass the registry's conflict validation.
- `StudioPublicApi` exposes snapshots, subscriptions, and commands only. It does
  not expose React setters, reducers, live DOM, or inspection internals.
  `getSnapshot()` deep-clones and deeply freezes the public payload (task,
  diagnostics, shortcuts, exporters, messages); mutation attempts throw and
  never reach runtime state, and extension config objects are never frozen.
- Extension failures are isolated at the runtime boundary: a throwing `setup`
  rolls back the extension's registered surface (contributions, shortcuts,
  host, messages) and mounting continues; side effects produced by `setup`
  outside the registered surface before the throw are not rolled back; `isVisible`/`isEnabled`/`isPressed` throwing degrade to
  hidden/disabled/unpressed; a throwing `icon` renders the safe fallback; a
  throwing `panel` render shows the closable error panel; `execute`/`enrich`/
  `export`/`redact` keep their fail-closed semantics. All failures record a
  deduplicated, bounded, redacted diagnostic carrying `extensionId`,
  `contributionId`, and `phase`; a throwing `dispose` still runs every other
  cleanup phase and persists its diagnostic.
  `commands.annotations.captureEvidence(annotationId)` captures best-effort
  screenshot evidence on demand for an existing annotation on the current
  route (a no-op in `off` mode); evidence conflicts adopt the latest task and
  retry exactly once while the annotation still exists.

## `@gchust/agent-annotations/types`

Exports the JSON-safe task, annotation, source, evidence, transport, runtime,
extension, contribution, and public Studio API types.

## `@gchust/agent-annotations/testing`

Exports `MemoryTaskTransport` for tests and local playgrounds. It is not a
persistent production transport.

## `@gchust/agent-annotations/vite/client`

Exports `HttpTaskTransport`, the browser transport used by the Vite virtual
client. Applications normally receive it through automatic development-server
injection rather than importing it directly.

`HttpTaskTransport` accepts `pollInterval` only as a finite integer between
100 and 10,000 ms (default 500) and throws a `TypeError` otherwise. Its `read`,
`mutate`, and `writeEvidence` results, every 409 conflict payload, and every
subscription push are schema-parsed; synchronization follows the
`(taskId, taskRevision)` identity rule (a different task id replaces the
current task even at revision 0; the same task id only advances on a strictly
larger revision), and unsubscribing aborts in-flight polls.
`mountAgentAnnotations()` applies the same validation and identity rules
unconditionally around any custom `TaskTransport`.

Screenshot evidence is written only inside the runtime `evidence` directory;
`evidence` CLI listings and post-removal cleanup resolve refs strictly inside
that directory and never follow traversal or symlink paths.

## CLI

The `agent-annotations` bin exposes `list`, `complete`, `reopen`, `print`,
`validate-task`, `status`, `revision`, `wait`, `diagnostics`, and
`evidence [--json|--prune [--json]]`. `evidence --prune` performs a safe
orphan sweep of `<runtimeRoot>/evidence` (only unreferenced regular files,
never symlinks, with a grace window for newly written evidence) and reports
deleted/skipped/error counts plus safe relative refs.
`validate-task` strictly validates the persisted task file with
`parseAgentAnnotationsTask()` and reports task id, revision, schema, and valid
state; it does not claim anything about browser or dev-server state. Commands
honor a single output contract: `--json` writes exactly one parseable JSON
value to stdout, the default writes stable human-readable text, and errors go
to stderr with exit code 1 (runtime) or 2 (usage). The removed `verify` command
has no alias.

`status [--json] [--check] [--runtime <runtime-id>|--route <route-key>]
[--annotation <id>] [--fail-on-diagnostics --diagnostics-since <ISO>]` reads
the per-runtime browser states persisted by the authenticated dev client
(`.agent-annotations/browser-states/<runtimeId>.json`, strict v2 schema, mode
0600, no token or sensitive text) and reports task validity,
session presence, browser connection (fresh heartbeat within 15 seconds), task
and source synchronization, deterministic runtime summaries/selection,
ids/revisions, route, bounded current-route annotation health, last heartbeat,
and diagnostic counts. With multiple fresh
runtimes, callers must select an exact runtime or route; otherwise the result is
`ambiguous_browser_runtime`. `--check` exits 1 unless `taskValid`, `browserConnected`,
`taskSynchronized`, available referenced-source synchronization, requested
annotation route/target health, and opted-in post-baseline diagnostics are
healthy. Diagnostics are informational unless `--fail-on-diagnostics` is
paired with `--diagnostics-since`; without `--check`
the command is informational and exits 0. `wait --browser-update-revision
<integer>` accepts the same runtime selectors and waits for that fresh browser
generation above the baseline; `wait
--referenced-source-revision <sha256>` watches known referenced files and
returns an explicit unavailable result when no files are known.

Path resolution is shared by every command and distinguishes the workspace
root from the runtime data directory: `--root`/`AGENT_ANNOTATIONS_ROOT` set the
workspace root; `--dir`/`AGENT_ANNOTATIONS_DIR` set the runtime data directory.
Without explicit paths the CLI discovers the nearest ancestor
`.agent-annotations/session.json` (recorded by the Vite plugin with canonical
`workspaceRoot` and `runtimeRoot`), then the nearest ancestor workspace
(`package.json` or `.git`), then the current directory. A session runtime root
outside the workspace root is rejected unless `--dir`/`AGENT_ANNOTATIONS_DIR`
was provided explicitly.
