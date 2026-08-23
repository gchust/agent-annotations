# Codex Launchers

每次只读取共享合同与当前一个 Goal。完成后开启独立 Review，再进入下一个 Goal。

## Goal 01 — Plan

```text
/plan Read:
- docs/goals/agent-annotations-must-fix-v3/00-shared-contract.md
- docs/goals/agent-annotations-must-fix-v3/01-goal-runtime-continuity-across-hmr-and-reload.md

Inspect the actual repository HEAD and working tree. For Goal 01 only, map every acceptance criterion to concrete production files, tests, commands, and evidence. Confirm the current HMR/pagehide/runtime lifecycle before proposing changes.

Do not modify code. Do not start Heartbeat serialization, release evidence, WebSocket, MCP, Task schema changes, or compatibility layers.
```

## Goal 01 — Execute

```text
/goal Complete Agent Annotations Must-fix Goal 01.

Read:
- docs/goals/agent-annotations-must-fix-v3/00-shared-contract.md
- docs/goals/agent-annotations-must-fix-v3/01-goal-runtime-continuity-across-hmr-and-reload.md

Preserve one runtimeId and a monotonically increasing browserUpdateRevision across Studio HMR remounts and full page reloads in the same tab. Make wait --runtime tolerate temporary reload disconnection without changing status semantics.

Do not stop at a plan. Do not start Goal 02. Continue until every G01 criterion has actual unit, Vite, CLI, packed-browser, build, and E2E evidence. Report PASS, FAIL, or BLOCKED for every criterion.
```

## Goal 01 — Independent Review

```text
Independently review Goal 01. Do not trust the previous completion statement. Re-read the shared contract and Goal 01, inspect the diff, and rerun every acceptance command. Specifically try to make runtimeId or browserUpdateRevision reset during extension HMR and full reload. Fix only Goal 01 defects. Do not start Goal 02.
```

## Goal 02 — Plan

```text
/plan Read:
- docs/goals/agent-annotations-must-fix-v3/00-shared-contract.md
- docs/goals/agent-annotations-must-fix-v3/02-goal-serialize-heartbeats-and-reject-regressions.md

Inspect the completed Goal 01 implementation. For Goal 02 only, map the single-flight latest-state heartbeat queue and server monotonic-write defense to concrete files and deterministic concurrency tests.

Do not modify code. Do not add a new Browser State schema, WebSocket, sequence log, release evidence, or compatibility layer.
```

## Goal 02 — Execute

```text
/goal Complete Agent Annotations Must-fix Goal 02.

Read:
- docs/goals/agent-annotations-must-fix-v3/00-shared-contract.md
- docs/goals/agent-annotations-must-fix-v3/02-goal-serialize-heartbeats-and-reject-regressions.md

Implement a single-flight latest-state Heartbeat queue and reject stale browser-state writes whose browserUpdateRevision regresses. Keep Browser State v2 and all current CLI/product behavior.

Do not stop at a plan. Do not start Goal 03. Continue until every G02 criterion has deterministic unit/server/Vite/packed E2E evidence, including delayed-request ordering. Report PASS, FAIL, or BLOCKED for every criterion.
```

## Goal 02 — Independent Review

```text
Independently review Goal 02. Use deferred requests to force responses and writes to complete out of order. Verify only one POST is in flight, only the latest pending snapshot is sent, and the server cannot overwrite revision 6 with revision 5. Fix only Goal 02 defects. Do not start Goal 03.
```

## Goal 03 — Execute

```text
/goal Complete Agent Annotations Must-fix Goal 03.

Read:
- docs/goals/agent-annotations-must-fix-v3/00-shared-contract.md
- docs/goals/agent-annotations-must-fix-v3/03-goal-current-candidate-release-proof.md

Freeze the current clean product HEAD as the release candidate. Run every local exact-tarball gate, confirm five first-pass E2E runs on the same installed tarball, and verify real remote CI for that candidate SHA. Only after all evidence passes, archive the stale root evidence and create a new evidence-only commit.

Do not modify product code. Do not push unless the user explicitly authorized it in this session. Do not publish or tag. If remote CI for the candidate cannot be obtained, report BLOCKED rather than claiming release readiness.
```
