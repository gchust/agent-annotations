# Codex 启动提示词

将路径替换为你在仓库中的实际目录。

## 通用 `/plan`

```text
/plan Read:
- docs/goals/agent-annotations-quality-followup-v2/00-shared-contract.md
- docs/goals/agent-annotations-quality-followup-v2/<CURRENT-GOAL>.md

Inspect the actual repository HEAD and working tree. For this Goal only,
produce a criterion-by-criterion repository adaptation. Map every acceptance
criterion to concrete files, tests, commands, and evidence artifacts. Identify
conflicts with current code before proposing changes.

Do not modify code. Do not start a later Goal. Do not introduce compatibility
layers, fuzzy marker fallbacks, MCP, NocoBase coupling, or unverified claims.
```

## 通用 `/goal`

```text
/goal Complete the current Agent Annotations quality Goal.

Read:
- docs/goals/agent-annotations-quality-followup-v2/00-shared-contract.md
- docs/goals/agent-annotations-quality-followup-v2/<CURRENT-GOAL>.md

Inspect actual HEAD before editing. Implement the Goal in the current
repository; do not stop at a plan and do not start a later Goal.

Continue until every current-Goal acceptance criterion has concrete command,
test, browser, package, or CI evidence. Keep Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective current in the Goal file.

Do not mark a criterion PASS without actually running its evidence. If blocked,
report the attempted paths, exact errors, why further work would violate the
contract, and the smallest input that would unblock it.
```

## 独立复核

```text
Independently review the just-completed Goal.

Read the shared contract and the current Goal. Do not trust the previous
completion claim. Inspect git diff and current HEAD, rerun every acceptance
command, and verify each criterion against actual source and behavior.

Fix omissions that are inside the current Goal. Do not start the next Goal.
Report PASS, FAIL, or BLOCKED for every criterion with exact evidence.
```

## Goal 文件顺序

```text
01-goal-trusted-browser-update-protocol.md
02-goal-revision-coverage-and-cli-contract.md
03-goal-privacy-safe-page-context.md
04-goal-multi-runtime-browser-state.md
05-goal-host-and-transport-boundaries.md
06-goal-marker-multitarget-correctness.md
07-goal-status-and-agent-handoff-health.md
08-goal-freeze-faithful-evidence.md
09-goal-runtime-and-protocol-simplification.md
10-goal-release-pipeline-and-open-source-polish.md
11-goal-clean-room-release-proof.md
```
