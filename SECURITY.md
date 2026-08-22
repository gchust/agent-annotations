# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's Security Advisory
flow: **Security → Report a vulnerability** on the repository page. Do not
open a public issue for security bugs. Include:

- package version, Node/React/Vite versions,
- the minimal reproduction (prefer a packed-consumer or fixture repro),
- expected vs observed behavior, and
- whether the issue touches tokens, task data, evidence, or diagnostics.

## Supported versions

Only the current release line is supported. Releases are tagged by the
maintainers; `alpha`/pre-release versions receive best-effort fixes.

## Security boundaries

- **Session tokens**: the Vite API binds to loopback by default and uses a
  random private token; tokens must never be committed or embedded in
  exported tasks.
- **Diagnostics**: bounded, redacted, privacy-safe. Network capture stores
  only origin+path — never query strings, bodies, headers, cookies, or
  arbitrary error text. `console.error`/window/promise diagnostics are
  redacted at the boundary.
- **Evidence**: confined to `<runtimeRoot>/evidence`; references and pruning
  never follow symlinks or traverse outside the runtime directory. Never
  point the runtime at a directory you do not control.
- **Custom transports**: a third-party `TaskTransport` observes every task
  mutation after validation and redaction. Only wire transports you trust;
  redaction never substitutes for transport-level security.
- **Extension code**: third-party extensions run in the page; treat any
  extension you install as trusted code. The runtime isolates its registered
  surfaces but cannot sandbox arbitrary `setup` side effects.
