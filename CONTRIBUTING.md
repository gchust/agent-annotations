# Contributing

Thanks for contributing to Agent Annotations. The repository is a single
package with a strict release discipline; every change lands as one commit per
goal and must keep the packed consumer green.

## Local development

```bash
pnpm install --frozen-lockfile
pnpm typecheck      # full project typecheck
pnpm test           # unit/integration suite (vitest)
pnpm build          # ESM + declarations via tsdown
pnpm run check:architecture   # forbidden patterns + runtime module graph audit
pnpm run check:docs           # README/API example guards
pnpm run check:package        # publint + attw
pnpm run check:tarball        # tarball content audit
```

## Packed consumer

The authoritative browser gate is the packed consumer E2E:

```sh
pnpm test:e2e   # builds, packs, installs into a fresh consumer, runs Playwright
```

Run it after any client/runtime, Vite plugin, or packaging change. A Node 20
and Node 24 exact-tarball smoke is available via `node scripts/node20-smoke.mjs`.

## Commit convention

- One logical change per commit, with a Conventional Commit message.
- Run `pnpm test`, `pnpm check:architecture`, `pnpm check:docs`,
  `pnpm build`, `pnpm check:package`, `pnpm check:tarball`, and the packed
  `pnpm test:e2e` before opening a pull request.
- Never `push` release branches or publish/tag without the release owner.

## Architecture constraints

- `src/client/runtime/` is a strict DAG: helpers/controllers may not import
  `chrome`, `overlays`, or `mount`; only `mount.ts` orchestrates.
- `react-grab/primitives` may only be imported by
  `src/client/inspection-engine.ts`.
- One React root only; no second root may be created in the runtime modules.
- No `void` fire-and-forget promises; every promise is handled explicitly.
- No new dependencies without a documented reason and a
  THIRD_PARTY_NOTICES update.

## Tests

Every behavior change ships with focused tests (factory-level controller tests
for runtime modules, server tests for stores/CLI, and packed Playwright specs
for browser behavior). Do not weaken or delete lifecycle/cleanup tests.
