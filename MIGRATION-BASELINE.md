# Agent Annotations migration baseline

Captured fresh on 2026-08-12 UTC before moving or changing any Default Portal Studio production source.

## Source repositories

- Default Portal: `/root/work/portal-template-default`
- Branch: `feat-agent-annotations`
- Commit: `cdfbfb4c959ee660379b7510d89ce506c15f4817`
- Standalone package: `/root/work/agent-annotations`, initialized as an independent Git repository on branch `main`.
- Initial Default Portal `git status --short`: modified `AGENTS.md`; untracked `docs/exec-plans/agent-annotations-npm-extraction-v1/`.
- Initial Default Portal `git diff --stat`: `AGENTS.md | 19 +++++++++++++++++++`; no `src/`, `scripts/`, `vite.config.ts`, `package.json`, or lockfile diff.

## Current embedded Studio inventory

Commands and fresh results:

```text
rg --files src/studio | wc -l
44

rg --files src/studio | xargs wc -l | tail -n 1
13903 total

rg --files scripts | rg '(^|/)portal-studio-' | wc -l
5

rg --files tests e2e | rg -i 'portal-studio|react-grab-g01' | wc -l
49
```

All 44 `src/studio/**` files are TypeScript or TSX. The five public Studio scripts are:

- `scripts/portal-studio-agent.mjs`
- `scripts/portal-studio-inspection-audit.ts`
- `scripts/portal-studio-mcp.mjs`
- `scripts/portal-studio-print.mjs`
- `scripts/portal-studio-verify.mjs`

## Direct NocoBase and host coupling

Fresh `rg` inspection found these direct boundaries in the embedded implementation:

- `src/studio/toolbar.tsx` imports `@nocobase/portal-sdk/i18n`.
- `src/studio/redact.ts` imports the NocoBase error-boundary redactor from `@/extensions/nocobase-error-boundary/error-diagnostics`.
- `src/studio/endpoint.ts`, `inspection/normalize.ts`, `inspection/region.ts`, and `inspection/nocobase-context.ts` recognize `data-ai-page-element` and `data-nb-*`.
- `vite.config.ts` reads `NOCOBASE_*` values and directly registers `portalStudioPlugin` from `src/studio/vite.ts`.
- `src/studio/vite.ts` and the public scripts use Portal Studio names, `/__portal-studio/*`, `x-portal-studio-token`, and `.portal-studio`.
- `src/studio/inspection/react-grab-engine.ts` is the sole current `react-grab/primitives` importer.

The new package runtime source, package metadata, tests, and Playground source contain no `@nocobase/*`, `data-nb-*`, `data-ai-page-element`, `NOCOBASE_*`, PortalStudio, `portal-studio`, or `.portal-studio` string. This baseline necessarily names those legacy boundaries, but it is repository-only evidence and is excluded from the publish tarball.

## Current public scripts

The template exposes its normal `dev`, `build`, `typecheck`, Vitest, SDK, Playwright, and Refine scripts plus:

```text
studio:list
studio:complete
studio:reopen
studio:print
studio:verify
studio:mcp
studio:inspection:audit
```

## Fresh baseline checks

```text
pnpm typecheck
PASS — tsc --noEmit, exit 0.

pnpm build
PASS — tsc && refine build; Vite transformed 5,952 modules and produced dist, exit 0.

pnpm exec vitest run tests/logic/portal-studio tests/components/portal-studio --reporter=verbose
FAIL — 644 passed, 2 timed out at the suite's 5,000 ms default while this run overlapped other CPU-heavy checks.

pnpm exec vitest run tests/logic/portal-studio/print-cli.test.ts tests/logic/portal-studio/cli-smoke.test.ts --testTimeout=15000 --reporter=verbose
PASS — both timed-out files reran in isolation: 2 files, 11 tests passed, exit 0.
```

The overlapping-suite timeout is retained as baseline evidence rather than rewritten as a clean full-suite result. The focused rerun demonstrates that the two named failures were timing-sensitive, not assertion failures.

Independent review reran the complete focused command serially on 2026-08-12:

```text
pnpm exec vitest run tests/logic/portal-studio tests/components/portal-studio --reporter=verbose
PASS — 37 files, 646 tests passed, exit 0.
```

The passing run emitted React duplicate-key warnings in the existing `G02-07b` 409 refresh/retry component test. Goal 01 records the warning but does not change embedded Studio behavior.

## Known bugs and migration risks at this baseline

These are current-code findings carried into later Goals; Goal 01 intentionally does not fix them:

- `src/studio/vite.ts` contains deterministic basename source guessing; the target contract requires exact canonical paths and unresolved ambiguity.
- iframe and ShadowRoot checks use current-realm `instanceof` in several files; the target contract requires cross-realm handling.
- `capture-freeze.ts` monkey-patches `requestAnimationFrame`; the target contract permits only React Grab's public freeze capability.
- region results are truncated with `slice(0, MAX_REGION_TARGETS)` after pruning; later migration must prove collect, score/deduplicate, then truncate.
- marker observation currently lives in the monolithic toolbar path; later migration must ensure observation only runs for genuinely visible markers.
- the prior React Grab public-contract Goal recorded the raw nested SVG-path hit mismatch; the current embedded adapter includes semantic ancestor promotion. This extraction must preserve the observed Portal behavior without adding a second perception engine.
- focused Studio tests can exceed the default 5-second timeout under concurrent CPU-heavy validation, as demonstrated above.
- the focused component suite's existing 409 refresh/retry case emits duplicate React-key warnings despite passing; investigate during runtime migration rather than changing embedded behavior in Goal 01.

## Goal 01 boundary

No `src/studio/**`, `scripts/portal-studio-*`, template package metadata, lockfile, or Vite runtime source was moved or changed. No Goal 02 schema, Registry, browser runtime, server protocol, NocoBase adapter, or compatibility layer was implemented.
