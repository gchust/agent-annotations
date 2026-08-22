# Alpha Release Candidate Evidence

Audited candidate commit: `9bacdfe2d7b48b48caba43f793422de23df27519` (`feat(ui): polish annotation toolbar workflow`, Goal 10)
Parent: `b94ace8` — working tree at audit time: clean — **git push was NOT performed; npm publish was NOT performed.**

## Clean-room method

1. `git archive 9bacdfe2d7b48b48caba43f793422de23df27519` → `/tmp/agent-annotations-g11/clean-src`
   (no `.git`, no `dist`, no `node_modules` — audit is immune to stale working-checkout artifacts).
2. `pnpm install --frozen-lockfile` → EXIT 0 (log: `gates-logs/00-install.log`).
3. Every repository gate below ran in that clean source; each command, exit code, and log are preserved under `/tmp/agent-annotations-g11/gates-logs/`.
4. Packed the **final RC exactly once, after all gates passed**, from the clean source. Ephemeral tarballs produced inside gates (e.g., `release:verify`/`test:e2e` pack for their own throwaway consumers) are **not** the RC and are excluded from the RC identity. The exact RC tarball was then installed into a fresh external consumer with a fresh lockfile and a frozen re-install.
5. Real dev-browser flows and a production build ran inside that consumer; artifacts preserved under `/tmp/agent-annotations-g11/consumer/`.

## Gate runs (clean archive, one command each)

| Command | Exit | Log | Notes |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | `00-install.log` | pnpm 10.28.1 |
| `pnpm typecheck` | 0 | `pnpm_typecheck.log` | |
| `pnpm test` | 0 | `pnpm_test.log` | 227/227 tests, 26 files |
| `pnpm check:architecture` | 0 | `pnpm_check_architecture.log` | 15 audit assertions |
| `pnpm check:docs` | 0 | `pnpm_check_docs.log` | docs smoke PASS |
| `pnpm build` | 0 | `pnpm_build.log` | |
| `pnpm check:package` | 0 | `pnpm_check_package.log` | publint + attw |
| `pnpm check:tarball` | 0 | `pnpm_check_tarball.log` | 24 files, 64382 bytes |
| `pnpm test:e2e` | 0 | `pnpm_test_e2e.log` | 1+1+7+1+2 = 12/12 |
| `pnpm release:verify` | 0 | `pnpm_release_verify.log` | all of the above, EXIT 0 |

## The exact candidate tarball

- Path: `/tmp/agent-annotations-g11/rc/gchust-agent-annotations-0.1.0-alpha.0.tgz`
- SHA-256: `8b105d74b0e70b4866b3c0aaafa34c9fabdce6fe2032c8c1e5a73cf29e9def2e`
- Size: 64 382 bytes
- Full list (24 entries, `rc/tarball-list.txt`): `package/LICENSE`, `package/dist/vite/client.js`, `package/dist/core-DHFDxR5_.js`, `package/dist/client/index.js`, `package/dist/extension/index.js`, `package/dist/testing/index.js`, `package/dist/types/index.js`, `package/dist/mutation-PTz8le1H.js`, `package/package.json`, `package/API.md`, `package/CHANGELOG.md`, `package/README.md`, `package/THIRD_PARTY_NOTICES.md`, `package/dist/cli/index.mjs`, `package/dist/vite/index.mjs`, `package/dist/metadata-pUpbXX1R.mjs`, `package/dist/cli/index.d.mts`, `package/dist/vite/index.d.mts`, `package/dist/vite/client.d.ts`, `package/dist/index-BXp1wA71.d.ts`, `package/dist/client/index.d.ts`, `package/dist/extension/index.d.ts`, `package/dist/testing/index.d.ts`, `package/dist/types/index.d.ts`
- No `src/`, `tests/`, `fixtures/`, `playgrounds/`, `.map`, or `workspace:` content.

## Fresh external consumer (no workspace links)

- Path: `/tmp/agent-annotations-g11/consumer/app` (copied from the clean archive's fixture, not the working checkout).
- Installed the exact tarball above as `file:./gchust-agent-annotations.tgz`; `grep workspace:` → none.
- `pnpm install` (creates `pnpm-lock.yaml`) EXIT 0 → `pnpm install --frozen-lockfile` EXIT 0 (lock is complete/reproducible).
- Dev browser E2E via the package's authoritative entry `AGENT_ANNOTATIONS_EVIDENCE=... pnpm test:e2e` (each spec is a separate Playwright invocation whose webserver resets `.agent-annotations`): run 1 = 1 failed / 11 passed (see Known limits); run 2 = **12/12, EXIT 0** (logs `consumer-test-e2e.log`, `consumer-test-e2e-2.log`).
- Production build: `pnpm build` EXIT 0 (`consumer-build.log`); `dist/` contains `index.html` + one 200 kB asset; no `mountAgentAnnotations` / `virtual:agent-annotations` / `__agent-annotations` / `agent-annotations-root` marker in the bundle (F-015).
- Browser artifacts: `/tmp/agent-annotations-g11/consumer/evidence/` (7 ux screenshots + playwright-results).

## Acceptance audit F-001..F-018

- **F-001 — PASS.** Product source `src/` contains no MCP surface (`grep -rli mcp src/` empty). The only MCP matches in the tree are absence guards: `tests/cli/cli.test.ts` asserts `--help` output has no `mcp` and that `mcp` exits 2 with `unknown command: mcp`; `scripts/docs-smoke.mjs` throws if README mentions MCP. Public bin from the exact-tgz consumer: `pnpm exec agent-annotations --help` lists exactly `list`, `complete`, `reopen`, `print`, `verify`, `revision`, `wait`, `diagnostics`, `evidence` (EXIT 0); `pnpm exec agent-annotations mcp` → `unknown command: mcp`, EXIT 2.
- **F-002 — PASS.** No public `architecture` command: `pnpm exec agent-annotations architecture` → `unknown command: architecture`, EXIT 2. Internal `pnpm check:architecture` passes (15 assertions).
- **F-003 — PASS.** Tarball list above covers every `exports` target (`.` → `dist/client/index.js` + `.d.ts`; `./vite` → `index.mjs` + `.d.mts`; `./vite/client`; `./extension`; `./types`; `./testing`), the CLI bin (`dist/cli/index.mjs`), and declarations; no source/test/map/workspace leak.
- **F-004 — PASS.** `src/metadata.ts` derives `PACKAGE_NAME`/`PACKAGE_VERSION` solely from `package.json` (`with { type: "json" }`); `engines.node >= 20`. The exact-tgz consumer's public bin was smoke-tested on Node 20.20.2: `fnm exec --using=20.20.2 pnpm exec agent-annotations --help` → EXIT 0, help lists the reviewed commands (log: `gates-logs/consumer-node20-cli.log`). The built output runs on the Node 20 target (the dist grep shows the JSON import attribute is not retained; no lower-bound claim is made beyond `engines.node >= 20`). Local full gates ran on Node 22.22.0; the Node 20/24 CI matrix is defined but the remote run never happened (F-017).
- **F-005 — PASS.** Production scan: `grep -rliE 'mcp|nocobase|element-source' src/ --exclude-dir=audit` → no matches, EXIT 1 (run and verified empty; core, client, vite, cli, server, extension, types, testing). The `check:architecture` gate (15/15 in the clean archive) additionally enforces the other forbidden patterns by rule name in `src/audit/index.ts` — `react-grab-ui` (a second React Grab importer), `element-source`, `fiber-private-source` (Fiber/source fallback), `basename-lookup` (basename guessing), `nocobase` — so a naive `grep src/` hits only that guard file, which is the regression-prevention rule set itself, not product surface. The unique React Grab importer in production is `src/client/inspection-engine.ts` (`import { … } from "react-grab/primitives"`); no other file imports it.
- **F-006 — PASS.** Bounded/redacted persistence proven by `tests/core/redaction.test.ts`, `tests/server/diagnostics.test.ts`, `tests/server/store.test.ts` and the runtime persistence tests (all inside the 227 passing tests); extension setup context exposes no raw `TaskTransport` (`tests/client/runtime.test.ts` "does not expose the raw transport…").
- **F-007 — PASS.** Screenshot/evidence privacy at the sanitized boundary (`tests/client/screenshot.test.ts`) plus the real-browser privacy case in `fixtures/packed-react-vite/tests/reliability.spec.ts` (privacy fixture with SENTINEL values) and the evidence lifecycle assertion in `vertical.spec.ts` — all passed in the consumer E2E.
- **F-008 — PASS.** Route markers across identical selectors (`route-region.spec.ts`, runtime route tests) and region target/source semantics (`region` suite) — passed.
- **F-009 — PASS.** Typed `RevisionConflictError`, serialized polling, read-or-create + hard-link lock recovery, `wait --source-revision` (`tests/server/store.test.ts`, `tests/server/transport.test.ts`, `tests/cli/cli.test.ts`) — passed.
- **F-010 — PASS.** Deterministic extension IDs, message conflicts, redactor/enricher isolation (`tests/extension/registry.test.ts`, runtime extension tests) — passed.
- **F-011 — PASS.** One stable React root with `dataset.studioRenders` proof; Panel draft survives task/marker/viewport updates; pointer movement never re-renders chrome (`runtime.test.ts`).
- **F-012 — PASS.** App root/route/locale/theme unified host subscription; Windows drive/backslash + Unix Vite specifier normalization (`runtime.test.ts`, `vite.test.ts`) — passed.
- **F-013 — PASS.** Toolbar order, divider + collapse chrome, collapsed count/icon + per-task position persistence/clamp, focus/hover tooltips with flip/clamp, confirmed Remove completed, Multi completion chip, continuous Pick, non-mutating Copy (`runtime.test.ts`, `accessibility.test.ts`, `hotkeys.test.ts`, `ux.spec.ts`) — passed.
- **F-014 — PASS.** The exact checksummed tarball installs in the fresh external frozen consumer and passes dev-browser E2E (12/12 on re-run) and `pnpm build`. The consumer's `gchust-agent-annotations.tgz` is byte-identical to the RC: SHA-256 `8b105d74b0e70b4866b3c0aaafa34c9fabdce6fe2032c8c1e5a73cf29e9def2e` on both. Lock resolution: `pnpm-lock.yaml` line 271 `'@gchust/agent-annotations@file:gchust-agent-annotations.tgz'` with `tarball: file:gchust-agent-annotations.tgz` and specifier `file:./gchust-agent-annotations.tgz`; the installed realpath is inside the consumer's own store — `node_modules/.pnpm/@gchust+agent-annotations@file+gchust-agent-annotations.tgz_…/node_modules/@gchust/agent-annotations` — no workspace link or registry dependency.
- **F-015 — PASS.** Production bundle contains no injected runtime/API markers (scan above).
- **F-016 — PASS.** Tarball ships `README.md`, `API.md`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`, `LICENSE`; `check:docs` passes; the packed consumer compiles and runs the documented examples (`demo-extension`, `route-host`).
- **F-017 — PASS (local definition); candidate remote run: NOT RUN.** `.github/workflows/ci.yml` defines Node 20/24 × Ubuntu/Windows with the portable gates (typecheck/build/arch/docs; full `pnpm test` + packed E2E on Linux; native Vite/path gates on Windows). Read-only remote observation was recorded: `git ls-remote origin main` → `774c28e1e782c133a83d6c9ea26baab9c7b2d208` (candidate `9bacdfe` is 10 commits ahead of `origin/main`); `gh run list` → empty. Because no push was performed, the candidate has **no remote CI run — recorded as NOT RUN, not fabricated, not claimed as green** (logs: `gates-logs/remote-ls-remote.log`, `gates-logs/gh-run-list.log`).
- **F-018 — PASS.** This report records every criterion with command, exit code, candidate SHA, tarball hash/size/list, consumer path, browser artifacts, and known limits (below).

## Known limits and invalid probes (recorded honestly)

1. **Invalid probe 1 — self-bin in clean source.** `pnpm exec agent-annotations --help` inside `clean-src` failed with `Command "agent-annotations" not found` because a package does not link its own bin into its own `node_modules/.bin`. This probe is invalid; the F-001/F-002 evidence comes from the exact-tgz consumer's public bin instead.
2. **Invalid probe 2 — shared-store direct Playwright run.** A one-shot `pnpm exec playwright test` (all specs in one worker, one shared `.agent-annotations` store) reported 10 passed / 2 failed purely from cross-spec baseline contamination (UX expected 2 annotations but saw 3; vertical expected 1 but saw 4). It is not a product failure; the authoritative entry point is the package's `pnpm test:e2e`, which isolates each spec with its own webserver reset.
3. **Consumer E2E run 1 flake.** The authoritative consumer `pnpm test:e2e` run 1 failed `source-benchmark` (one of five captured rows not yet visible when the spec read the task file). Re-run 2 passed 12/12; the task file from run 1 already contained all five correctly-resolved rows (selectors + source paths). Non-reproducible timing flake; no product change made per "fix only reproduced final-gate failures".
4. **Node runtime.** Local full gates ran on Node 22.22.0. Node 20 was additionally smoke-tested with the exact-tgz consumer's public bin under Node 20.20.2 (EXIT 0). The Node 20/24 × Ubuntu/Windows CI matrix is defined but no remote run occurred.
5. **Remote CI.** Read-only state: `origin/main` = `774c28e1e782c133a83d6c9ea26baab9c7b2d208`, candidate 10 commits ahead, `gh run list` empty. The candidate's remote matrix run is **NOT RUN** — no push was performed and none is planned.

## Deliverable state

- `RELEASE-CANDIDATE-EVIDENCE.md` added to the repository working tree, **not committed**.
- No product source changes were made during this goal (no reproducible final-gate failure).
- `git status` was clean except for this file; no push, no publish.
