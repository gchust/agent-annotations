# Goal 03 Runtime Continuity Release-Candidate Evidence

Status: PASS. This evidence proves product candidate
`f2002313f71f803098cf53f43b33e9cebf492323`. The evidence-only commit containing
this file and the historical archive is a child of that immutable candidate.

No product code, tests, fixtures, scripts, workflows, package metadata, lockfile,
or Goal record changed during this audit. The audit did not run `git push`,
`npm publish`, create a Git tag, or create a GitHub release. The candidate was
pushed externally after local verification, enabling exact-SHA CI validation.

## Candidate and clean-room provenance

- Product candidate: `f2002313f71f803098cf53f43b33e9cebf492323`
  (`test(e2e): wait for orphan evidence cleanup`).
- Required ancestors: Goal 01 `2e905e92a6c28abcdf9bd5eedb8c3b9464adea7e`;
  Goal 02 `eb04c9ef54b4237514ec5eea7348ebd6a27d61e6`.
- External audit root: `/tmp/agent-annotations-g03-f200231-6lkWbK`.
- Source archive: `source.tar`, SHA-256
  `c41fd1b1f8dd1b3a27e41c1bf9834ef34dd5fb42c2b85ccb68aeb8f842db6415`,
  `1904640` bytes, `203` tracked files.
- `git get-tar-commit-id` returned the exact product candidate. The archive file
  list and all extracted tracked bytes matched the candidate tree. Before the
  audit, the archive contained no `.git`, `dist`, `node_modules`, or `artifacts`.
- Environment: Linux x86_64, kernel `6.8.12-4-pve`; Node `v22.22.0`; pnpm
  `10.28.1`; Playwright `1.62.1`.
- Local logs are under the external audit root's `logs/` directory. Generated
  tarballs, consumers, browser evidence, and reports remain outside the Git
  repository.

The clean-room commands ran once, in order, from the extracted exact-candidate
archive. No failed acceptance command was retried.

| Command | Exit | Result |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | frozen install PASS |
| `pnpm typecheck` | 0 | TypeScript PASS |
| `pnpm test` | 0 | 42 files / 489 tests PASS |
| `pnpm check:architecture` | 0 | 31/31 PASS |
| `pnpm check:docs` | 0 | docs smoke PASS |
| `pnpm release:verify` | 0 | complete release gate PASS |
| `pnpm test:e2e:repeat` | 0 | five consecutive first-pass runs PASS |
| browser consumer `pnpm build` | 0 | production build PASS |

`release:verify` built and packed once, then passed typecheck, its 39-file /
481-test release suite, architecture 31/31, docs, Publint (`All good!`), ATTW
ESM/bundler checks, tarball audit, fresh Core/CLI consumer, and the first packed
browser consumer run.

## Exact tarball

- Path within the audit root:
  `source/artifacts/release-candidate/gchust-agent-annotations-0.1.0-alpha.0.tgz`.
- SHA-256: `43eaae943071680a3cf6e740d89dc420bdce9734ebfe909058fda8e75d32254d`.
- Size: `118644` bytes; files: `26`; candidate-root tarballs: `1`.
- The browser consumer retained `gchust-agent-annotations.tgz` with the same hash
  and byte size.
- Metadata JSON, sorted manifest, direct `tar -tf`, both consumer-installed
  copies, and the retained browser copy all matched this exact artifact.
- Publint, ATTW, tarball audit, Core/CLI smoke, packed browser run, and all five
  repeats used this artifact. No second pack occurred.

Full sorted file list:

```text
package/API.md
package/CHANGELOG.md
package/LICENSE
package/README.md
package/THIRD_PARTY_NOTICES.md
package/dist/cli/index.d.mts
package/dist/cli/index.mjs
package/dist/client/index.d.ts
package/dist/client/index.js
package/dist/core-CHf3wBTf.js
package/dist/core/index.d.ts
package/dist/core/index.js
package/dist/extension/index.d.ts
package/dist/extension/index.js
package/dist/index-kW-tUw7k.d.ts
package/dist/metadata-DFiY8sR7.mjs
package/dist/mutation-DuaR3BHP.js
package/dist/testing/index.d.ts
package/dist/testing/index.js
package/dist/types/index.d.ts
package/dist/types/index.js
package/dist/vite/client.d.ts
package/dist/vite/client.js
package/dist/vite/index.d.mts
package/dist/vite/index.mjs
package/package.json
```

## Consumers and production exclusion

The fresh Core/CLI consumer installed the exact tarball with peer auto-install
disabled. `/core` import and the public CLI passed under Node `20.20.2` and
`24.19.0`. It had no top-level React or ReactDOM, zero exact `.pnpm` React /
ReactDOM package directories, and zero exact React / ReactDOM lockfile package
entries.

Both consumer package links resolved inside their own external pnpm stores.
Neither package metadata nor lockfiles contained `link:` or `workspace:`, and no
symlink targeted the Git worktree or unpacked package source/build directories.
All 26 installed package files were byte-identical to the tarball in both
consumers.

The repeat gate reused one installed browser consumer and the retained exact
tarball. Its log contains five `test:e2e` invocations, no install or pack
invocation, no retry marker, and no failed-run marker. Playwright configuration
does not enable retries.

| Run | Exit | Result | Duration |
|---:|---:|---|---:|
| 1 | 0 | 22/22 tests PASS | 128.6s |
| 2 | 0 | 22/22 tests PASS | 126.9s |
| 3 | 0 | 22/22 tests PASS | 126.8s |
| 4 | 0 | 22/22 tests PASS | 127.0s |
| 5 | 0 | 22/22 tests PASS | 128.0s |

The same consumer then produced a real Vite production build. Recursive
fixed-string scans of `dist/` returned:

```text
mountAgentAnnotations=0
virtual:agent-annotations=0
__agent-annotations=0
agent-annotations-root=0
react-dom/server=0
```

## Exact-candidate GitHub Actions

Checked at `2026-08-23T23:09:23Z`. GitHub Actions run
[`32671853420`](https://github.com/gchust/agent-annotations/actions/runs/32671853420)
is event `push`, attempt `1`, exact head SHA
`f2002313f71f803098cf53f43b33e9cebf492323`, and completed `success`.

| Required job | Job ID | Result |
|---|---:|---|
| `ubuntu-latest / node 20` | `97273779297` | success |
| `ubuntu-latest / node 24` | `97273779195` | success |
| `windows-latest / node 20` | `97273779311` | success |
| `windows-latest / node 24` | `97273779342` | success |
| `release verify (ubuntu / node 20)` | `97273779293` | success |

The release-job raw log independently records one 26-file, 118644-byte package
with the same SHA-256 as the local artifact, release verification PASS, and
five uninterrupted repeat PASS results (`111.0s`, `111.6s`, `111.5s`, `111.1s`,
`111.1s`). The exact candidate is now remote `main`; this audit did not perform
that push.

## Goal 03 acceptance

- **G03-001 PASS**: a clean exact product candidate was frozen before evidence
  edits; archive identity and required ancestry were verified.
- **G03-002 PASS**: every required local clean-room command passed on its first
  execution.
- **G03-003 PASS**: every package and consumer gate used the same exact tarball
  SHA-256, with byte-identical retained and installed copies.
- **G03-004 PASS**: one installed browser consumer passed five consecutive
  first-pass E2E runs without reinstall, repack, or retry.
- **G03-005 PASS**: the real production build contains none of the five
  forbidden runtime-injection markers.
- **G03-006 PASS**: all four Linux/Windows Node 20/24 matrix jobs and the release
  job are green on exact candidate SHA, attempt 1.
- **G03-007 PASS**: the superseded root evidence is archived under
  `docs/historical/`; this root file proves only the current candidate.
- **G03-008 PASS**: the final diff is limited to the evidence archive and this
  evidence file; its commit is the candidate's evidence-only child.
- **G03-009 PASS**: this audit performed no push, publish, tag, release, or
  credential change.

## Self-review and limitations

- Local browser evidence is Linux/Node 22. Exact remote CI supplies Ubuntu and
  Windows Node 20/24 coverage.
- The local and CI package hashes happen to be identical, demonstrating a
  deterministic build; each environment still built its own candidate once.
- Superseded `eb04c9e` audit artifacts and PASS claims were not reused.
- `git diff --check`, exact two-file scope, parent identity, and evidence content
  were checked before commit and are checked again after commit.
