# API reference

## `@gchust/agent-annotations`

- `mountAgentFeedback(options)` mounts the React runtime and returns
  `{ api, unmount }`. `options.transport` implements `TaskTransport`; optional
  `options.extensions` uses public client extensions.
- `createAgentFeedbackTask`, `parseAgentFeedbackTask`,
  `validateAgentFeedbackTask`, and `isAgentFeedbackTask` own schema v1.
- `applyAgentFeedbackMutation` applies revision-checked task operations.
- `formatAgentFeedbackTask` emits Markdown or JSON.
- `redactAgentFeedbackTask` and `redactAgentFeedbackText` remove generic secret
  material before persistence or export.
- The remaining root exports are pure ID, selection, placement, selector, and
  shortcut helpers plus their public types.

## `@gchust/agent-annotations/vite`

The default export is `agentFeedback(options)`. Options are `root`, `dir`,
`endpoint`, `allowRemote`, and absolute browser-module paths in
`clientExtensions`. The plugin applies only to Vite's development server.
`FileTaskStore` and `createSourcePathService` are exported for controlled Node
integrations.

## `@gchust/agent-annotations/extension`

- `defineClientExtension(extension)` defines a public extension without global
  mutation.
- `ClientExtensionRegistry` and `registerClientExtension` provide deterministic,
  atomic registration and disposal.
- Public contribution types cover toolbar actions, panels, target enrichers,
  exporters, redactors, locale messages, and one host integration.
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
