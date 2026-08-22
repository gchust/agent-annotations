# Changelog

## Unreleased

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

## 0.1.0-alpha.0 - 2026-08-13

- Ships as `@gchust/agent-annotations`; the `agent-annotations` CLI and task schema
  identifiers remain unchanged.
- Added the host-neutral `agent-annotations.task.v1` schema, mutations, formatting,
  redaction, React runtime, Vite plugin, file transport, and CLI.
- Added the public client Extension Registry and built-in toolbar contributions.
- Added exact source verification, screenshot evidence, iframe and Shadow Root
  marker recovery, bounded Area capture, and development-only production exclusion.

This alpha intentionally starts a new protocol. It does not read or migrate
previous Portal-specific task data or endpoints.
