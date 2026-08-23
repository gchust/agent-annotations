# Goal 11 Release-Candidate Evidence

Status: PASS. Goal 11 changed only this evidence file. No product, test,
workflow, package metadata, lockfile, or goal file changed. No push, tag,
release, npm publish, force operation, or product rerun was performed.

## Candidate and provenance

- Dedicated worktree: `/root/work/agent-annotations-goal11-final`, branch
  `goal11-final-0f297ec`.
- Product SHA: `0f297ecb9f9465950b4ac4cee5c0544b7db13eaa` (`fix(storage): preserve fresh stale-lock claims`).
- Evidence commit: separate from the product SHA; recorded in the final handoff
  after this document is committed.
- Fresh external root: `/root/agent-annotations-goal11-final-USTX9j`.
- Source command: `git archive --format=tar --output=.../source.tar 0f297ecb9f9465950b4ac4cee5c0544b7db13eaa`.
- Source archive: `/root/agent-annotations-goal11-final-USTX9j/source.tar`,
  SHA-256 `db4e7bf9c6cf65a66a684e574dcde39e71864d6160713e574d62c3b56efe4f39`,
  `1,812,480` bytes.
- `tar -tf ... | rg '(^|/)(\.git|dist|node_modules)(/|$)'` returned no
  matches. The extracted-tree `find` also returned no `.git`, `dist`, or
  `node_modules` directory before install.
- Before evidence, `HEAD`, local `main`, `origin/main`, and live
  `refs/heads/main` all resolved to the product SHA. The dedicated worktree was
  clean. Protected `evidence/goal11-blocked-cc3ec2a` remained at
  `cc3ec2aab08d805901fef4a5b75fd71fdeec96e8`.
- Environment: Linux `dev3-199`, x86_64, kernel `6.8.12-4-pve`; Node
  `v22.22.0`; pnpm `10.28.1`. Local browser evidence is Chromium on Linux;
  Windows and Node 20/24 coverage comes from the exact remote CI jobs below.
- Logs: `/root/agent-annotations-goal11-final-USTX9j/logs/`; reports:
  `/root/agent-annotations-goal11-final-USTX9j/reports/`.

## Clean-room commands and exits

The commands ran in the extracted archive in this order. Every observed
first-run exit is in `logs/exit-codes.txt`; no failed gate was retried.

| Command | Exit | Direct evidence |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | `logs/01-install.log` |
| `pnpm typecheck` | 0 | `logs/02-typecheck.log` |
| `pnpm test` | 0 | `logs/03-test.log`: 42 files, 479 tests |
| `pnpm check:architecture` | 0 | `logs/04-architecture.log`: 31 tests |
| `pnpm check:docs` | 0 | `logs/05-docs.log` |
| `pnpm build` | 0 | `logs/06-build.log` |
| `pnpm release:verify` | 0 | `logs/07-release-verify.log` |
| `pnpm test:e2e:repeat` | 0 | `logs/08-repeat-e2e.log` |
| browser consumer `pnpm build` | 0 | `logs/09-browser-production-build.log` |

`release:verify` used its one candidate tarball for its non-repacking suite
(39 files, 471 tests), architecture (31/31), docs, publint (`All good!`), ATTW
(ESM and bundler profiles green), tarball audit, fresh no-React Node 20/24
Core/CLI consumer, and first packed browser consumer run. Its individual logs
are under `source/artifacts/release-candidate/`.

## Exact candidate artifact

- Path: `/root/agent-annotations-goal11-final-USTX9j/source/artifacts/release-candidate/gchust-agent-annotations-0.1.0-alpha.0.tgz`
- SHA-256: `760533f06ff7bc43f65aa67aaa45ed56a7c90d174c24392f5011b71cb7a39607`
- Size: `117462` bytes; files: `26`; candidate-root tarballs: `1`.
- Browser copy: `browser-consumer/gchust-agent-annotations.tgz`, same SHA-256
  and size.
- `publint`, ATTW, `tarball-audit.mjs`, both consumers, and all five repeats
  received this exact path/hash; there was no second pack.
- Full sorted list (`reports/tarball-list.txt`):

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
package/dist/metadata-DoQAyxaA.mjs
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

The tarball audit rejected source/test/fixture/script/source-map/internal-path
and `workspace:` leaks and passed the exact 26-file artifact.

## Consumers and production exclusion

The fresh Core/CLI consumer is
`source/artifacts/release-candidate/core-consumer/consumer`. It installed the
exact tarball with peer auto-install disabled, imported `/core`, and ran the
public CLI under Node `20.20.2` and `24.19.0`. All four checks passed.
Top-level `react` and `react-dom`, exact `.pnpm` React package directories, and
exact lockfile entries are absent. `react-grab@0.1.50` is present; React,
ReactDOM, and Vite occur only as package peer metadata (`reports/core-no-react.txt`).

The browser consumer is `source/artifacts/release-candidate/browser-consumer`.
`release:verify` installed it once from the exact tarball. The repeat gate did
not install, repack, or retry; it only cleared runtime evidence before each
foreground execution. Each run passed 20 tests on its first pass:

| Run | Exit | Direct log |
|---:|---:|---|
| 1 | 0 | `source/artifacts/release-candidate/repeat-e2e-1.log` |
| 2 | 0 | `source/artifacts/release-candidate/repeat-e2e-2.log` |
| 3 | 0 | `source/artifacts/release-candidate/repeat-e2e-3.log` |
| 4 | 0 | `source/artifacts/release-candidate/repeat-e2e-4.log` |
| 5 | 0 | `source/artifacts/release-candidate/repeat-e2e-5.log` |

The same installed consumer then produced a real production build. Recursive
fixed-string scans of `dist/` returned zero occurrences for every forbidden
marker (`reports/production-scan.txt`):

```text
mountAgentAnnotations=0
virtual:agent-annotations=0
__agent-annotations=0
agent-annotations-root=0
react-dom/server=0
```

## Remote CI and release facts

GitHub API and raw job logs independently verify run `32645393649`, event
`push`, attempt `1`, exact head SHA `0f297ecb...`, completed `success`:
https://github.com/gchust/agent-annotations/actions/runs/32645393649.

| Job | ID | Attempt | Result |
|---|---:|---:|---|
| release verify (Ubuntu / Node 20) | `97208767983` | 1 | success |
| Ubuntu / Node 24 | `97208768058` | 1 | success |
| Windows / Node 24 | `97208768060` | 1 | success |
| Ubuntu / Node 20 | `97208768064` | 1 | success |
| Windows / Node 20 | `97208768104` | 1 | success |

The release-job raw log (`logs/ci-job-97208767983.log`) records one CI
candidate SHA `7c6bfaa2...`, release verification PASS, and repeat runs 1/5
through 5/5 all PASS. That CI-built artifact is distinct from the local
artifact, as expected; each environment internally reused its own exact
one-pack checksum. API identity is preserved in `reports/remote-run-api.json`
and `reports/remote-jobs.json`; all five raw logs are preserved under `logs/`.

Release metadata facts (`reports/release-facts.txt`): package
`@gchust/agent-annotations`, version `0.1.0-alpha.0`,
`publishConfig.access=public`, and exactly one matching changelog heading
(`0.1.0-alpha.0 - 2026-08-22`). Registry command
`npm view @gchust/agent-annotations@0.1.0-alpha.0 version --json` exited `1`
with `E404 Not Found`: this exact version is unpublished. No source or
consumer was substituted for that registry fact.

## Goal 11 acceptance

- **G11-001 PASS**: product SHA is `0f297ec...`; external artifacts and the
  later evidence-only commit are separate.
- **G11-002 PASS**: new archive, frozen install, full clean gates, and
  `release:verify` all exited 0 on first run.
- **G11-003 PASS**: package audits, Core/CLI, browser consumer, production
  build, and repeats reused local SHA `760533f0...`.
- **G11-004 PASS**: one pack, one browser install, five consecutive first-pass
  20-test runs, no retry/repack/reinstall.
- **G11-005 PASS**: the real production bundle has zero occurrences of all
  five forbidden markers.
- **G11-006 PASS**: all five exact-product-SHA jobs succeeded on attempt 1.
- **G11-007 PASS**: F-001 through F-050 are mapped below to current clean-run
  unit, packed browser, artifact, CI, or registry evidence.
- **G11-008 PASS**: paths, commands, exits, checksums, environment, separate
  local/CI artifacts, unpublished state, and platform limits are explicit.

## Final acceptance matrix

| ID | Result and direct current evidence |
|---|---|
| F-001 | PASS - `runtime-evidence-status.test.ts` proves task mutation does not report a browser update; `logs/03-test.log`. |
| F-002 | PASS - the same suite preserves/clears applied baselines around failed browser reports; packed `status.spec.ts`; five repeat logs. |
| F-003 | PASS - `server/vite.test.ts` asserts `vite:afterUpdate`; mount/status tests cover initial mount and reload. |
| F-004 | PASS - packed `status.spec.ts` waits for CSS-only HMR browser-update revision; all five repeats pass. |
| F-005 | PASS - CLI/browser-state tests assert `referencedSourceRevision: null` without referenced files. |
| F-006 | PASS - packed source benchmark and handoff tests keep referenced-source and browser-update fields distinct. |
| F-007 | PASS - CLI rejects both old revision flags; browser-state tests reject v1. |
| F-008 | PASS - capture tests and packed query sentinel prove default task URL/route omit query. |
| F-009 | PASS - packed status/vertical privacy assertions cover browser state, handoff, diagnostics, and evidence. |
| F-010 | PASS - capture tests strictly validate host page context and safe fallback. |
| F-011 | PASS - packed status test creates two distinct runtime state files. |
| F-012 | PASS - packed status ambiguity returns `ambiguous_browser_runtime`. |
| F-013 | PASS - packed handoff contains exact runtime, route, annotation, wait, and status selectors. |
| F-014 | PASS - runtime-controller tests isolate every host callback/disposer failure. |
| F-015 | PASS - host identity failure test preserves ordinary annotation flow. |
| F-016 | PASS - validated-transport and store tests require matching task ID and advancing revision for mutate. |
| F-017 | PASS - evidence-status tests require matching task, existing annotation, and advancing revision. |
| F-018 | PASS - transport read/subscription input and output schema failures are rejected before publication. |
| F-019 | PASS - mutation tests prove validation and redaction before custom transport calls. |
| F-020 | PASS - store tests prove final persistence redaction, including the product-SHA stale-lock regression. |
| F-021 | PASS - controller cache and packed multi-target tests track every iframe target. |
| F-022 | PASS - marker controller and packed multi-target test share one resolution snapshot. |
| F-023 | PASS - packed nested iframe/open-shadow and dynamic DOM tests recover after changes/reload. |
| F-024 | PASS - selector/inspection and packed reliability tests explicitly report cross-origin unsupported. |
| F-025 | PASS - geometry unit tests and packed scroll/resize checks keep highlights aligned. |
| F-026 | PASS - packed frozen-popover PNG samples the visible pre-unfreeze state. |
| F-027 | PASS - evidence-status test saves/closes UI before delayed screenshot completion. |
| F-028 | PASS - packed privacy PNG checks sanitized input/password/textarea/contenteditable pixels. |
| F-029 | PASS - CLI status tests select exact runtime, route, and annotation. |
| F-030 | PASS - CLI and packed status checks remove/restore an exact target and verify health. |
| F-031 | PASS - CLI tests fail only on diagnostics newer than `--diagnostics-since`. |
| F-032 | PASS - handoff unit/packed copy uses browser-update baseline and wait command. |
| F-033 | PASS - handoff unit/packed copy excludes raw comment from completion summary. |
| F-034 | PASS - CLI tests cover valid and invalid cross-platform `--summary-file` inputs. |
| F-035 | PASS - packed vertical test executes annotation -> handoff -> wait/status -> summary-file completion. |
| F-036 | PASS - architecture audit rejects legacy heartbeat; Vite tests accept complete v2 state only. |
| F-037 | PASS - Vite test gets 404 for `/source`; architecture audit rejects route code. |
| F-038 | PASS - runtime tests assert one public snapshot commit per logical action. |
| F-039 | PASS - runtime/host tests assert pointer moves add zero public commits/renders. |
| F-040 | PASS - architecture/core-export tests plus the fresh no-React consumer prove the `/core` boundary. |
| F-041 | PASS - `reports/production-scan.txt` has zero for all five markers. |
| F-042 | PASS - release metadata and directory scan show one pack and one candidate-root tarball. |
| F-043 | PASS - publint, ATTW, tarball audit, both consumers, and five repeats use SHA `760533f0...`. |
| F-044 | PASS - exact jobs `97208768064` and `97208768058`, Ubuntu Node 20/24, attempt 1 success. |
| F-045 | PASS - exact jobs `97208768104` and `97208768060`, Windows Node 20/24, attempt 1 success. |
| F-046 | PASS - exact release job `97208767983`, Ubuntu Node 20, attempt 1 success with five repeat PASS lines. |
| F-047 | PASS - local repeat logs contain five first-pass 20-test runs; CI release log independently contains five PASS runs. |
| F-048 | PASS - version, one changelog heading, public publishConfig, and exact-version npm E404 are consistent. |
| F-049 | PASS - clean archive root has no intermediate implementation file; tarball is the 26-file whitelist only. |
| F-050 | PASS - this evidence records current commands, exits, logs, hashes, complete list, refs, CI IDs, environment, and limitations. |

## Self-audit and limitations

- `git diff --check` and the one-file diff/status checks were run before commit.
- Generated evidence remains outside every repository worktree.
- The npm version is not published. Local browser evidence is Linux/Node 22;
  exact remote CI supplies Ubuntu/Windows Node 20/24 evidence.
- The original `/root/work/agent-annotations` worktree and its live changes
  were not inspected or modified. Historical run `32643189383`, old external
  roots, old artifacts, and superseded Goal 11 evidence were not used.
