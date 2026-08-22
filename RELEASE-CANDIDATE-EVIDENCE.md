# Release Candidate Evidence — 0.1.0-alpha.0

Clean-room, repeatable acceptance of the final alpha Product Candidate. Performed
on 2026-08-22 (UTC) after the Goal 15–16 repair commit. The product candidate
was not modified; this document is a new file created in the repository. Nothing
was pushed, published, or tagged.

## Product Candidate

- Commit SHA: `339b3681976917a3baed7e4952bfd91d0421d558`
  - `test(e2e): accept balanced HMR invalidations` (Goal 16 repair; parent
    `edd23a4b0ce36c9e79c1f20feb82b3007760082a`)
- Repository: `/root/work/agent-annotations` (`main`); worktree clean except for
  this document (the sole repo change of this Goal).

## Goal 01–16 Commit Map (exact)

| Goal | Commit SHA(s) |
|---|---|
| 01 | `7f4cd88cc8acec85659fe219dcf2538cd04bbc16` |
| 02 | `f52f8b76cf4c6e39389f14e596443958439855d6` |
| 03 | `a765e7788573d8e0e862182dd53a770b44f9bb0f` |
| 04 | `e82393f64617fb563b8cc35df883b1cf8147ef80`, `52d344d51f0c88476f9d467c844f3204547ab4c4` |
| 05 | `27c97b0ed38bd252314730b013a0e98a0e4419b6`, `c0014cd33ef31a8ee889e1c06d1137b814b38abd` |
| 06 | `2a9c09d9db9685d07630dc3ada8d9e54f8cb06cb`, `4c509d82a35d57f607fe0a185764bb7acfdb3f42`, `5e90c6fea8e806598a55b71f96c7a9f2d9bcf082` |
| 07 | `cc56d3bcea56ab4ecf2d3e46725d310737e9dc06`, `8fb03d7d47422cbb94b0adcb486de5dd6493b196` |
| 08 | `5025fcd439bad90231796b27308fda49f01615fb` |
| 09 | `4fee85e26286d80e2c437a639e5bf3e45914f46d` |
| 10 | `5d9810dcc27a3d06c3cd7f77882634f3fd9839fb` |
| 11 | `cc975c081d64c0707fca65d544e209bfa924a33b` |
| 12 | `db1840d62f9ea8ab5467915d47dbcbeb32f35bcc` |
| 13 | `3644a72eeccab10d7b5f03151a3706e35aa0fc1f` |
| 14 | `6f58f9af46d3cd0515921fd4c2690efd42003a8a` |
| 15 | `edd23a4b0ce36c9e79c1f20feb82b3007760082a` |
| 16 repair | `339b3681976917a3baed7e4952bfd91d0421d558` |
| 16 evidence | pending at document creation |

The 16 evidence commit was not yet created when this document was written, so
its SHA is recorded as pending; it cannot be known inside the document itself.

## Clean-room Method

- Archive created with no `.git`, no `dist`, no `node_modules`:

  ```bash
  git archive --format=tar --prefix=aa-g16b/ 339b3681976917a3baed7e4952bfd91d0421d558 | tar -x -C /tmp
  mv /tmp/aa-g16b /tmp/aa-g16b-clean
  ```

- Clean archive path: `/tmp/aa-g16b-clean`
- Environment: Linux dev3-199 6.8.12-4-pve x86_64; Node `v22.22.0`; pnpm
  `10.28.1`.
- All command stdout/stderr logs preserved outside the repo:
  `/tmp/aa-g16b-logs/`. Gate logs store stdout/stderr only; exit codes were
  printed at the console outside the redirects and are recorded in the
  observed first-run exit-code summary (`exit-codes.txt` in the same
  directory); no gate was re-run to produce that summary.

## Clean Archive Gates

| # | Gate | Exit | Log | Notes |
|---|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | 0 | `01-install.log` | Done in 1.5s |
| 2 | `pnpm typecheck` | 0 | `02-typecheck.log` | 0 TS errors |
| 3 | `pnpm test` | 0 | `03-test.log` | **37 files, 434 tests passed** |
| 4 | `pnpm run check:architecture` | 0 | `04-arch.log` | **29 passed** |
| 5 | `pnpm run check:docs` | 0 | `05-docs.log` | docs smoke PASS |
| 6 | `pnpm build` | 0 | `06-build.log` | Build complete 7437ms |
| 7 | `pnpm run check:package` | 0 | `07-package.log` | |
| 8 | `pnpm run check:tarball` | 0 | `08-tarball.log` | tarball audit PASS (26 files, 106630 bytes) |
| 9 | `pnpm test:e2e` | 0 | `09-e2e-clean.log` | **17 passed** |
| 10 | `pnpm release:verify` | 0 | `10-release-verify.log` | full chain rerun, all passed |

First-run exit codes only; no rerun was needed for any gate.

## Exact Tarball (packed once, after all gates)

- Path: `/tmp/aa-g16b-pack/gchust-agent-annotations-0.1.0-alpha.0.tgz`
- **SHA-256**: `3b76627d4381c833f465afb296390f10bd302290f42beeeeb7bd899e0f769821`
- **Size**: 106588 bytes
- Full file list (`tar -tf | sort`, `12-tarball-list.txt`):

  ```
  package/API.md
  package/CHANGELOG.md
  package/LICENSE
  package/README.md
  package/THIRD_PARTY_NOTICES.md
  package/dist/cli/index.d.mts
  package/dist/cli/index.mjs
  package/dist/client/index.d.ts
  package/dist/client/index.js
  package/dist/core/index.d.ts
  package/dist/core/index.js
  package/dist/extension/index.d.ts
  package/dist/extension/index.js
  package/dist/index-U5OVvAFX.d.ts
  package/dist/metadata-BXwV313k.mjs
  package/dist/mutation-PTz8le1H.js
  package/dist/testing/index.d.ts
  package/dist/testing/index.js
  package/dist/transport-BZmnDCEv.js
  package/dist/types/index.d.ts
  package/dist/types/index.js
  package/dist/vite/client.d.ts
  package/dist/vite/client.js
  package/dist/vite/index.d.mts
  package/dist/vite/index.mjs
  package/package.json
  ```

- Tarball content scan: no `src/`, `tests/`, `fixtures/`, `scripts/` entries, no
  `*.map`, no `workspace:` references (0 leaks).

## External Consumers

### Core/CLI consumer (no React installed — proven)

- Path: `/tmp/aa-g16b-core-consumer`; install: `pnpm add <exact tarball>`.
- Lockfile: `@gchust/agent-annotations@file:../aa-g16b-pack/gchust-agent-annotations-0.1.0-alpha.0.tgz` (no `workspace:`).
- Realpath: `/tmp/aa-g16b-core-consumer/node_modules/.pnpm/@gchust+agent-annotations@file+..+aa-g16b-pack+…/node_modules/@gchust/agent-annotations` (consumer's own store).
- **No React installed (proof in `/tmp/aa-g16b-logs/core-no-react.log`)**: lockfile
  has 0 direct `react`/`react-dom` dependency entries; `node_modules/react` and
  `node_modules/react-dom` are ABSENT; the `.pnpm` store has no `react@…`/
  `react-dom@…` directories (the only `react-*` entry is `react-grab@0.1.50`,
  the screenshot-capture library, not React). Installed manifest
  `dependencies: { magic-string, react-grab }`; `peerDependencies` list
  `react/react-dom/vite` but none were installed (peers not auto-installed).
- `/core` import in this no-React Node consumer: **PASS** (`core-consumer-ok`).
- CLI (`dist/cli/index.mjs`):
  - `--help` exit 0
  - `verify` → **unknown command, exit 2**
  - `validate-task --json` exit 0 `{"ok":true,"taskId":"g16b-task",…}`
  - `status --json` exit 0
  - `diagnostics --json` exit 0 `[]`
  - `evidence --json` exit 0 `[]`
  - `wait --source-revision … --timeout-ms 0 --json` exit 0
  - public bin `node_modules/.bin/agent-annotations validate-task` exit 0

### Browser consumer (authoritative 5× stability gate)

- Path: `/tmp/aa-g16b-browser-consumer` = fresh copy of
  `fixtures/packed-react-vite` from the clean archive; ONLY the exact tarball
  copied in as `gchust-agent-annotations.tgz`; `pnpm install` once (lockfile
  generated/frozen).
- Tarball SHA inside consumer: `3b76627d4381c833f465afb296390f10bd302290f42beeeeb7bd899e0f769821` (identical).
- Lockfile: `@gchust/agent-annotations@file:gchust-agent-annotations.tgz`; no `workspace:`.
- Realpath: `/tmp/aa-g16b-browser-consumer/node_modules/.pnpm/@gchust+agent-annotations@file+gchust-agent-annotations.tgz_react-dom@19.2.8_react@19.2_4dd4aec5e157bd666c6f282739718a77/node_modules/@gchust/agent-annotations`.
- No reinstall, no repack, no Playwright retries, no rerun-after-failure.

### Five consecutive first-pass runs (same exact tarball)

| Run | Exit | Result | Log |
|---|---|---|---|
| 1 | 0 | **17 passed** | `browser-e2e-1.log` |
| 2 | 0 | **17 passed** | `browser-e2e-2.log` |
| 3 | 0 | **17 passed** | `browser-e2e-3.log` |
| 4 | 0 | **17 passed** | `browser-e2e-4.log` |
| 5 | 0 | **17 passed** | `browser-e2e-5.log` |

All five first-pass green; vertical HMR (balanced setup/dispose deltas), relative
base `/app/` authoritative run included in each.

## Production Exclusion & Browser Bundle Scan

### Consumer production build (explicit, real results)

- `pnpm build` run once in the browser consumer (`/tmp/aa-g16b-browser-consumer`):
  exit **0**, "✓ built in 2.17s" — stdout/stderr in `/tmp/aa-g16b-logs/browser-build.log`.
- Production exclusion scan of the built `dist/` (`/tmp/aa-g16b-logs/browser-build-scan.log`):

  | Marker | Result |
  |---|---|
  | `mountAgentAnnotations` | ABSENT |
  | `virtual:agent-annotations` | ABSENT |
  | `__agent-annotations` | ABSENT |
  | `agent-annotations-root` | ABSENT |
  | `react-dom/server` | ABSENT |

  No runtime/API marker is present in the consumer production build.

### Clean-archive dist scan

- `dist` scan in `/tmp/aa-g16b-clean`: no `react-dom/server` occurrence
  (`grep -R` exit 1 = no match).

### Tarball content scan

- Tarball excludes all source/test/fixture/workspace content (full list above).

## Remote CI (real state, read-only `gh run list --workflow ci --limit 10`)

- Runs visible: 1 — `32198810235` (`failure`, headSha
  `53f840292182eda5fe7ed0351e9956450db19f01`, created 2026-08-18, push).
- The only run does NOT match the Product Candidate SHA `339b368…`.
- **Remote CI: NOT RUN** for the candidate SHA.
- The historical failed run for an older SHA is recorded above; it is not
  candidate CI and is never treated as PASS or FAIL for the candidate.

## Known Limitations

- Remote CI has never executed for the candidate; GitHub Actions CI status is
  therefore `NOT RUN` by design of the acceptance contract.
- The browser E2E stability gate is machine-local (Linux, Node 22); the
  candidate was not exercised on Windows/macOS runners in this acceptance.
- Evidence logs live outside the repository (`/tmp/aa-g16b-logs/`); they are
  not committed with the repository.
- The 16-evidence commit SHA is unknowable at document creation (see above).

## Conclusion

- All clean-archive gates passed (first-run exit codes, no reruns).
- Exact tarball packed once; SHA-256/size/full list recorded.
- External core/CLI consumer passed (no React installed, proven); external
  browser consumer passed 5×17/17 first-pass runs on the exact tarball.
- Production exclusion scan: all five contract markers ABSENT from the built
  consumer dist (real scan results).
- Remote CI for the candidate: NOT RUN (recorded as-is, no fabrication).
- Product Candidate SHA reviewed throughout: `339b3681976917a3baed7e4952bfd91d0421d558`.

```text
git push was NOT performed; npm publish was NOT performed.
```
