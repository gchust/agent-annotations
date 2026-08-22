## Scope

- What this changes and why (one logical change per PR).

## Tests
- [ ] Focused unit tests (factory-level for runtime controllers, server tests for stores/CLI)
- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] `pnpm run check:architecture` and `pnpm run check:docs` pass
- [ ] `pnpm build`, `pnpm run check:package`, `pnpm run check:tarball` pass
- [ ] Packed consumer: `pnpm test:e2e` passes (or the affected spec is listed)

## Public API
- List any public export/CLI/type changes; confirm no undocumented exports were added.

## Security / Privacy
- [ ] No tokens/secrets are logged or persisted
- [ ] Diagnostics/evidence boundaries unchanged unless intentional and tested

## Screenshots
- Attach Playwright screenshots for UI/browser-behavior changes (expanded, collapsed, list, editor, locale).
