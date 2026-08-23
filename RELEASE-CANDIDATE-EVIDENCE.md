# Goal 11 Release-Candidate Evidence

Status: PASS. This is the only repository file changed by Goal 11. No product,
test, workflow, package metadata, lockfile, or goal bundle file was changed.
No npm publish, tag, release, push, or Goal 10 rerun was performed.

## Candidate and provenance

- Product repository: `/root/work/agent-annotations`
- Product SHA under audit: `d24718380734c6407ee0c790d98815aaf67143b5`
- Candidate archive source: `git archive d24718380734c6407ee0c790d98815aaf67143b5`
- Fresh external clean-room root: `/root/agent-annotations-goal11-INDM3X`
- Archive: `/root/agent-annotations-goal11-INDM3X/archive/source.tar`
- Archive SHA-256: `2c9fa5fb6dd14c0feccaa59cf6b8094166460aa74693b0be72ac0a59559c7661`
- Archive size: `1,812,480` bytes
- Archive scan: `tar -tf ... | rg '(^|/)(\\.git|dist|node_modules)(/|$)'` returned no matches; extracted `find` returned zero `.git`, `dist`, or `node_modules` paths.
- Product worktree before evidence: clean. `HEAD` and `origin/main` were the product SHA; `git ls-remote origin refs/heads/main` also returned the product SHA. The checked-out branch was `goal10-ci-repair`. A separate stale local branch `refs/heads/main` points to the protected historical evidence branch `cc3ec2a`; it was not used or modified.
- Environment: Linux `dev3-199`, x86_64, kernel `6.8.12-4-pve`; Node `v22.22.0`; pnpm `10.28.1`; Chromium installed by the existing packed-E2E gate.
- Logs and reports: `/root/agent-annotations-goal11-INDM3X/logs/` and `/root/agent-annotations-goal11-INDM3X/reports/`.

## Clean-room commands and exits

Commands ran in the extracted archive, in this order. The exit codes are the
observed first-run values in `logs/exit-codes.txt`; no gate was rerun after a
failure because none failed.

| Command | Exit | Log |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | `logs/01-install.log` |
| `pnpm typecheck` | 0 | `logs/02-typecheck.log` |
| `pnpm test` | 0 | `logs/03-test.log` (42 files, 478 tests) |
| `pnpm check:architecture` | 0 | `logs/04-architecture.log` (31 tests) |
| `pnpm check:docs` | 0 | `logs/05-docs.log` |
| `pnpm build` | 0 | `logs/06-build.log` |
| `pnpm release:verify` | 0 | `logs/07-release-verify.log` |
| `pnpm test:e2e:repeat` | 0 | `logs/08-repeat-e2e.log` |
| browser consumer `pnpm build` | 0 | `logs/09-browser-production-build.log` |
| artifact identity and scans | 0 | `reports/artifact-identity.txt`, `reports/production-scan.txt`, `reports/core-no-react.txt` |

The ordinary full test suite was run before the release orchestrator and passed
`42 files / 478 tests`. The release orchestrator's non-repacking suite passed
`39 files / 470 tests`, architecture passed `31/31`, publint reported `All
good!`, ATTW passed its ESM/bundler profiles, the tarball audit passed, both
Node 20 and Node 24 core/CLI smoke runs passed, and the first packed browser
consumer passed.

## Exact candidate artifact

`pnpm release:verify` created one candidate tarball after its single build and
single pack. The release directory contains exactly one `.tgz` file.

- Path: `/root/agent-annotations-goal11-INDM3X/artifacts/release-candidate/gchust-agent-annotations-0.1.0-alpha.0.tgz`
- SHA-256: `47371b05e09d0b84e4e50bf256e3e475a22e55f503a1ac5ea435cf5462955ed2`
- Size: `117528` bytes
- Files: `26`
- Exact browser copy hash: identical SHA-256; `/root/agent-annotations-goal11-INDM3X/artifacts/release-candidate/browser-consumer/gchust-agent-annotations.tgz`
- Full `tar -tf | sort` list:

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
package/dist/metadata-uduXdvB7.mjs
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

The tarball audit found no source, test, fixture, script, source map, internal
declaration path, or `workspace:` leak.

## Consumers and production scan

The browser consumer is `/root/agent-annotations-goal11-INDM3X/artifacts/release-candidate/browser-consumer`.
It was installed once by `release:verify` from the exact tarball. The repeat
gate only removed its runtime evidence directory before each foreground test;
it did not install, pack, or reinstall. The five logs all begin with the same
candidate SHA and each reported 20 passing tests:

| Run | Exit | Result | Log |
|---:|---:|---|---|
| 1 | 0 | 20 passed, first pass | `artifacts/release-candidate/repeat-e2e-1.log` |
| 2 | 0 | 20 passed, first pass | `artifacts/release-candidate/repeat-e2e-2.log` |
| 3 | 0 | 20 passed, first pass | `artifacts/release-candidate/repeat-e2e-3.log` |
| 4 | 0 | 20 passed, first pass | `artifacts/release-candidate/repeat-e2e-4.log` |
| 5 | 0 | 20 passed, first pass | `artifacts/release-candidate/repeat-e2e-5.log` |

The browser consumer production build was run once. The scan of its `dist/`
returned zero occurrences for every forbidden marker:

```text
mountAgentAnnotations=0
virtual:agent-annotations=0
__agent-annotations=0
agent-annotations-root=0
react-dom/server=0
```

The fresh no-React core/CLI consumer is
`/root/agent-annotations-goal11-INDM3X/artifacts/release-candidate/core-consumer/consumer`.
It installed the same exact tarball once, imported `@gchust/agent-annotations/core`,
and ran the public CLI under Node 20.20.2 and Node 24.19.0. Both core imports
and both CLI `--help` checks passed. `node_modules/react` and
`node_modules/react-dom` are absent; exact React package directories and exact
React lockfile snapshots are zero; the only matching store package is
`react-grab@0.1.50`. The installed package has runtime dependencies
`magic-string` and `react-grab`; React, ReactDOM, and Vite appear only as peer
metadata.

## Remote CI and registry facts

The exact first-run remote run was queried independently:

- Run `32640448134`, URL `https://github.com/gchust/agent-annotations/actions/runs/32640448134`, event `push`, attempt `1`, head SHA `d24718380734c6407ee0c790d98815aaf67143b5`, conclusion `success`.
- Ubuntu Node 20: job `97196617544`, success, attempt 1.
- Ubuntu Node 24: job `97196617578`, success, attempt 1.
- Windows Node 20: job `97196617582`, success, attempt 1.
- Windows Node 24: job `97196617554`, success, attempt 1.
- Release verify Ubuntu Node 20: job `97196617527`, success, attempt 1. Its log records the exact candidate SHA, release verification PASS, and repeat runs 1/5 through 5/5 all PASS.
- Raw job logs are preserved under `logs/ci-job-*.log`; the API job identity is in `reports/remote-jobs.json`.

Independent release facts:

- `package.json`: name `@gchust/agent-annotations`, version `0.1.0-alpha.0`, `publishConfig.access=public`.
- `CHANGELOG.md`: exactly one current `0.1.0-alpha.0 - 2026-08-22` heading.
- `npm view @gchust/agent-annotations@0.1.0-alpha.0 version --json`: exit `1`, `E404 Not Found`; this exact version is unpublished. It is recorded as an honest registry fact, not as a substituted consumer source.

## Goal and acceptance mappings

### G11

- **G11-001 PASS**: Product SHA is `d247183...`; candidate artifact and this evidence are separate. Archive and product-ref reports are external; the eventual evidence commit is not the product SHA.
- **G11-002 PASS**: Fresh archive, frozen install, typecheck, 478-test suite, architecture, docs, build, package/tarball audits, and release verify all exited 0 on first run.
- **G11-003 PASS**: Core/CLI and browser consumers used the same 64-character candidate SHA; the browser copy hash equals the packed hash.
- **G11-004 PASS**: One install, one pack, and five consecutive first-pass browser runs; no retry, repack, or reinstall.
- **G11-005 PASS**: Real browser production `dist/` scan found all five forbidden markers absent.
- **G11-006 PASS**: All five exact-SHA CI jobs in run `32640448134` succeeded on attempt 1.
- **G11-007 PASS**: F-001 through F-050 are mapped below to current source tests, packed browser tests, release logs, or exact CI/registry evidence.
- **G11-008 PASS**: External paths, commands, exit codes, artifact identity, environment, unpublished registry state, and local-branch limitation are recorded without claiming publication.

### F-001 through F-050

| ID | Result and concrete evidence |
|---|---|
| F-001 | PASS — `tests/client/runtime-evidence-status.test.ts` “does not report a browser update when an accepted task changes the referenced sources”; `logs/03-test.log`. |
| F-002 | PASS — same suite “preserves the applied baseline ... clears it for a failed browser report”; packed `status.spec.ts`; repeat logs. |
| F-003 | PASS — `tests/server/vite.test.ts` asserts `vite:afterUpdate`; mount/status tests exercise initial mount and full reload. |
| F-004 | PASS — packed `fixtures/packed-react-vite/tests/status.spec.ts` CSS HMR wait and `browserUpdateRevision`; five exact runs. |
| F-005 | PASS — `tests/cli/cli.test.ts` unavailable referenced-source wait and browser-state fixtures assert `referencedSourceRevision: null`. |
| F-006 | PASS — packed `source-benchmark.spec.ts` prints distinct source baseline; core handoff tests assert both fields. |
| F-007 | PASS — CLI tests reject `--source-revision`, `--browser-source-revision`; `tests/server/browser-state.test.ts` rejects v1. |
| F-008 | PASS — `runtime-markers-capture.test.ts` query-free page context; packed status query sentinel is absent from persisted state. |
| F-009 | PASS — packed status and vertical privacy assertions cover Browser State, Handoff, Diagnostics, and evidence. |
| F-010 | PASS — `runtime-markers-capture.test.ts` strict host page-context validation and fallback. |
| F-011 | PASS — packed `status.spec.ts` uses two runtimes/routes and verifies distinct state files; Vite tests cover heartbeat isolation. |
| F-012 | PASS — packed status ambiguity returns `ambiguous_browser_runtime`; CLI exit is checked. |
| F-013 | PASS — packed vertical handoff includes exact runtime, route, annotation, and runtime-scoped wait/status commands. |
| F-014 | PASS — `runtime-controllers.test.ts` isolates every host callback/disposer; host UI tests continue cleanup after dispose failure. |
| F-015 | PASS — guarded host test records identity failure while ordinary Pick/Marker flows remain usable. |
| F-016 | PASS — validated transport tests and server store revision-conflict tests require matching task identity and advancing revision. |
| F-017 | PASS — evidence-status tests validate `writeEvidence` once, annotation existence, conflict retry, and revision update. |
| F-018 | PASS — invalid transport task and invalid subscribed task tests fail before UI/state publication. |
| F-019 | PASS — runtime evidence-status tests redact update/add mutations before custom transport calls. |
| F-020 | PASS — `tests/server/store.test.ts` final persistence redaction is idempotent across comments, extensions, refs, and completion evidence. |
| F-021 | PASS — controller cache test checks every iframe target; packed nested/multi-target tests recover all targets. |
| F-022 | PASS — marker controller and packed multi-target test use one shared resolution snapshot for marker, highlight, summary, and tracking. |
| F-023 | PASS — packed nested iframe/open-shadow and dynamic DOM tests recover after population/reload. |
| F-024 | PASS — selector/inspection tests and packed reliability test explicitly keep cross-origin unsupported. |
| F-025 | PASS — marker capture unit geometry tests and packed reliability highlight/scroll/resize checks. |
| F-026 | PASS — packed frozen-popover test samples the visible popover in saved PNG; screenshot tests freeze prepared DOM before render. |
| F-027 | PASS — runtime evidence-status test persists/closes composer before delayed screenshot resolves. |
| F-028 | PASS — packed privacy screenshot records sanitized input/password/textarea/contenteditable pixels; no raw media/form values. |
| F-029 | PASS — CLI status tests select exact runtime, route, and annotation. |
| F-030 | PASS — CLI status `--check` tests exact target health and packed status removes/restores the target. |
| F-031 | PASS — CLI diagnostics baseline tests block only diagnostics newer than `--diagnostics-since`. |
| F-032 | PASS — handoff unit and packed copy assert Browser Update Revision baseline and wait command. |
| F-033 | PASS — handoff tests and packed copy assert raw comment is absent from completion instructions. |
| F-034 | PASS — CLI tests cover valid UTF-8 summary files, unreadable files, invalid UTF-8, empty/oversize, and mutually exclusive flags. |
| F-035 | PASS — packed vertical test performs browser annotation, generated handoff, wait/status checks, summary-file completion, and verification. |
| F-036 | PASS — architecture audit rejects legacy heartbeat; server Vite tests accept only complete Browser State v2 heartbeat. |
| F-037 | PASS — Vite test asserts `/source` returns 404; architecture audit rejects route code. |
| F-038 | PASS — `tests/client/runtime.test.ts` checks one public commit per mutation/route/toolbar action. |
| F-039 | PASS — same runtime test checks 100 pointer moves add zero public commits; host UI test keeps render counter flat. |
| F-040 | PASS — architecture/core export tests and no-React consumer prove `/core` has no React/Vite/Node runtime dependency. |
| F-041 | PASS — real browser production scan: all five markers count zero. |
| F-042 | PASS — release logs show one candidate pack JSON record and one `.tgz` in the release directory. |
| F-043 | PASS — package audit, tarball audit, core consumer, browser copy, and all five runs record SHA `47371b05...`. |
| F-044 | PASS — exact run jobs `97196617544` and `97196617578`, Ubuntu Node 20/24, success. |
| F-045 | PASS — exact run jobs `97196617582` and `97196617554`, Windows Node 20/24, success. |
| F-046 | PASS — exact release job `97196617527` success, including exact candidate release verify and five repeats. |
| F-047 | PASS — local and CI repeat logs show five first-pass runs, all green, with no retry/reinstall/repack. |
| F-048 | PASS — package version, changelog heading, and public publishConfig agree; npm exact-version query returns E404, accurately recording unpublished state. |
| F-049 | PASS — clean archive root has no intermediate implementation file; tarball contains only the 26 whitelisted files. |
| F-050 | PASS — this document records reproducible commands, exact exits, paths, hashes, complete tarball list, limitations, and no fabricated publication claim. |

## Self-audit and handoff

- `git diff --check` was run before writing this document and again after it was written.
- `git diff --name-only` must contain only `RELEASE-CANDIDATE-EVIDENCE.md`; no generated external artifacts are inside the product worktree.
- Evidence commit is intentionally separate from the audited product SHA and is reported by the final handoff after commit.
- Remaining risks: the exact npm version is not published; browser repeat and local clean-room tests are Linux/Node 22 evidence, while Windows/Node 20/24 evidence is the exact remote CI run; the stale local `main` branch ref remains untouched and is not the live remote `main` ref.
