# Changelog

## Unreleased

- **Breaking**: renamed the CLI `verify` command to `validate-task`; `verify`
  is no longer recognized and returns `unknown command: verify` with exit
  code 2. `validate-task` strictly validates the persisted task file and never
  claims browser or dev-server state.
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
