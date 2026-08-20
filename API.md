# API reference

## `@gchust/agent-annotations`

- `mountAgentAnnotations(options)` mounts the React runtime and returns
  `{ api, unmount }`. `options.transport` implements `TaskTransport`; optional
  `options.extensions` uses public client extensions.
- `TaskTransport` requires `read`/`mutate` and may add `writeEvidence`,
  `subscribe`, and `appendDiagnostics` (browser diagnostics are persisted
  through `HttpTaskTransport` and bounded/redacted server-side).
- `createAgentAnnotationsTask`, `parseAgentAnnotationsTask`,
  `validateAgentAnnotationsTask`, and `isAgentAnnotationsTask` own schema v1.
- `applyAgentAnnotationsMutation` applies revision-checked task operations.
- `formatAgentAnnotationsTask` emits Markdown or JSON.
- `redactAgentAnnotationsTask` and `redactAgentAnnotationsText` remove generic secret
  material before persistence or export.
- `RevisionConflictError` is thrown by stores and transports on stale writes; it
  carries the parsed latest task plus expected/actual revisions and is
  `instanceof`-recognizable in the browser.
- The remaining root exports are pure ID, selection, placement, selector, and
  shortcut helpers plus their public types.

## `@gchust/agent-annotations/vite`

The default export is `agentAnnotations(options)`. Options are `root`, `dir`,
`endpoint`, `allowRemote`, and absolute browser-module paths in
`clientExtensions`. The plugin applies only to Vite's development server.
`FileTaskStore` and `createSourcePathService` are exported for controlled Node
integrations.

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
- `HostIntegration` may expose `routeKey()`, `locale()`, `theme()`, `appRoot()`,
  `navigate(routeKey)`, and a single unified `subscribe(listener)` notification.
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
- `StudioPublicApi` exposes snapshots, subscriptions, and commands only. It does
  not expose React setters, reducers, live DOM, or inspection internals.

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

Screenshot evidence is written only inside the runtime `evidence` directory;
`evidence` CLI listings and post-removal cleanup resolve refs strictly inside
that directory and never follow traversal or symlink paths.

## CLI

The `agent-annotations` bin exposes `list`, `complete`, `reopen`, `print`,
`validate-task`, `revision`, `wait`, `diagnostics`, and `evidence`.
`validate-task` strictly validates the persisted task file with
`parseAgentAnnotationsTask()` and reports task id, revision, schema, and valid
state; it does not claim anything about browser or dev-server state. Commands
honor a single output contract: `--json` writes exactly one parseable JSON
value to stdout, the default writes stable human-readable text, and errors go
to stderr with exit code 1 (runtime) or 2 (usage). The removed `verify` command
has no alias.

Path resolution is shared by every command and distinguishes the workspace
root from the runtime data directory: `--root`/`AGENT_ANNOTATIONS_ROOT` set the
workspace root; `--dir`/`AGENT_ANNOTATIONS_DIR` set the runtime data directory.
Without explicit paths the CLI discovers the nearest ancestor
`.agent-annotations/session.json` (recorded by the Vite plugin with canonical
`workspaceRoot` and `runtimeRoot`), then the nearest ancestor workspace
(`package.json` or `.git`), then the current directory. A session runtime root
outside the workspace root is rejected unless `--dir`/`AGENT_ANNOTATIONS_DIR`
was provided explicitly.
