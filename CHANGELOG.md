# Changelog

## 0.1.6 - 2026-08-26

- Reduced the default task polling frequency from 500 ms to 5 seconds, matching
  the browser heartbeat interval.
- Deferred the automatic completed-task reload while Vite is showing a build
  error, so failed source changes are never reported as browser-applied.

## 0.1.5 - 2026-08-25

- Made copied handoffs prioritize the smallest relevant check instead of the
  full test suite, while preserving explicitly configured verification commands.
- Made completion idempotent when an annotation has already disappeared, so
  stale handoffs can continue without retries; `reopen` remains strict.

## 0.1.4 - 2026-08-25

- Added optional host-provided brand colors for annotation accents, including
  live updates and readable foreground colors in light and dark themes.

## 0.1.3 - 2026-08-24

- Kept completed annotations visible with their original marker color and a
  compact check badge, and refreshed the page after the full task completes.
- Added Enter-to-save for annotation comments while preserving Shift+Enter
  for newlines.
- Removed sampled-element highlights from region annotations so the region
  outline remains the authoritative visual selection.
- Moved generated implementation-summary placeholders into the ignored
  `.agent-annotations` runtime directory.

## 0.1.2 - 2026-08-24

- Expanded the annotation toolbar by default, exited capture mode after saving,
  and added a confirmed action for clearing all annotations.
- Replaced browser confirmation dialogs with built-in confirmation panels.
- Corrected screenshot marker placement and exact target selectors, including
  recovery for legacy ancestor selectors that uniquely identify a descendant.
- Kept dynamically growing toolbar panels visible and clear of the draggable
  dock.

## 0.1.1 - 2026-08-24

- Simplified the default Code-Agent handoff to four steps: edit source,
  complete immediately, run project checks, and validate the task file.
- Removed browser revision, runtime synchronization, generated `wait`/`status`
  commands, and diagnostics baselines from copied handoffs. The standalone
  CLI commands remain available.

## 0.1.0-alpha.0 - 2026-08-22

- Unified release verification around one build and one checksummed tarball;
  package audits, Node consumers, the installed browser consumer, and five
  repeated browser runs now reuse that exact candidate and preserve failure
  logs and artifacts.
- Split the browser runtime integration suite by marker/capture,
  diagnostics/extensions, evidence/status, and host/UI controller ownership;
  Windows CI now covers file locks, stores, evidence, diagnostics, Vite, source
  paths, and CLI paths on Node 20 and 24.
- Page context now omits query data by default across tasks, browser state,
  handoff, diagnostics, and evidence metadata. Hosts may provide validated,
  query-free business route keys through `pageContext()`.
- **Breaking**: split browser update generation from referenced-source hashes.
  `revision` now returns `referencedSourceRevision`/`referencedSourceFiles`,
  empty source sets return `null`, and the wait modes are now
  `--browser-update-revision` and `--referenced-source-revision` with no old
  aliases.
- Added `agent-annotations evidence --prune [--json]`: a safe orphan sweep
  that deletes only unreferenced regular files directly inside the evidence
  directory (never symlinks or directories, never files referenced by the
  current task, with a grace window for newly written evidence), reporting
  deleted/skipped/error counts and safe relative refs.
- Documented platform boundaries with deterministic tests (Windows-style
  backslash refs rejected, symlinked evidence roots refused, symlinked
  workspace roots canonicalized through symlinks, monorepo
  subdirectory CLI resolution) and a packed-consumer relative Vite base spec.
- Added open-source governance: `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue/PR templates, and `docs/architecture.md` with
  the runtime module graph; the docs smoke now blocks old `verify` usage,
  MCP/NocoBase coupling, and missing governance files.
- Moved the previous alpha candidate evidence to
  `docs/historical/release-candidate-evidence-2026-08.md`; final clean-room
  release-candidate evidence will be produced separately.
- **Breaking**: renamed the CLI `verify` command to `validate-task`; `verify`
  is no longer recognized and returns `unknown command: verify` with exit
  code 2. `validate-task` strictly validates the persisted task file and never
  claims browser or dev-server state.
- Added a pure, host-neutral `@gchust/agent-annotations/core` subpath export
  for Node tooling: task schema/validation, mutation, formatting/handoff,
  redaction, ids, selection, placement, selectors, and shortcuts plus their
  pure types. `/core` never imports React, React DOM, Vite, or Node built-ins,
  and its built declaration closure is free of React/DOM references.
- Removed the browser runtime's dependency on `react-dom/server`: imperative
  overlay icons are built as controlled DOM SVG from the same path data as the
  React icon components.
- Unified CLI output contracts: `--json` writes exactly one parseable JSON
  value to stdout, the default writes stable human-readable text, and errors
  go to stderr with stable exit codes.
- Added shared workspace/runtime root resolution for the CLI: `--root` and
  `--dir` (plus `AGENT_ANNOTATIONS_ROOT`), discovery of the nearest ancestor
  session, and the nearest ancestor workspace (`package.json`/`.git`);
  sessions now record canonical `workspaceRoot` and `runtimeRoot`.
- Ships as `@gchust/agent-annotations`; the `agent-annotations` CLI and task schema
  identifiers remain unchanged.
- Added the host-neutral `agent-annotations.task.v1` schema, mutations, formatting,
  redaction, React runtime, Vite plugin, file transport, and CLI.
- Added the public client Extension Registry and built-in toolbar contributions.
- Added exact source verification, screenshot evidence, iframe and Shadow Root
  marker recovery, bounded Area capture, and development-only production exclusion.

This alpha intentionally starts a new protocol. It does not read or migrate
previous Portal-specific task data or endpoints.
