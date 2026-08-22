# Goal 07 — 把 Status 与 Handoff 升级为具体 Annotation 的验证合同

## Goal Objective

```text
/goal 让 Code Agent 能选定 Runtime 和 Annotation，验证 Route、Target、Browser Update 与新 Diagnostics；完成命令使用跨平台 Summary File，而不是把原始评论当作验证摘要。
```

## 单一完成结果

让 Code Agent 能选定 Runtime 和 Annotation，验证 Route、Target、Browser Update 与新 Diagnostics；完成命令使用跨平台 Summary File，而不是把原始评论当作验证摘要。

## 问题背景

当前 `status --check` 只检查任务、Browser 连接与 Revision，同步成功不代表目标仍可解析或页面没有新错误。Handoff 将原始用户评论预填为 `--summary`，不能证明实现与验证，并使用偏 POSIX 的命令引用。

## 前置依赖

- Goal 06 完成并通过。

## 必须先阅读

- `00-shared-contract.md`
- `CURRENT-REVIEW-BASELINE.md`
- 当前 Goal 中列出的相关生产代码与测试
- 实际仓库的 `AGENTS.md`、`package.json` 和当前 HEAD

## 主要修改范围

- `src/server/browser-state.ts`
- `src/client/runtime/mount.ts`
- `src/client/runtime/markers.ts`
- `src/cli/index.ts` 与参数解析
- `src/core/handoff.ts`
- `src/types/index.ts`
- Status/Handoff/Diagnostics/CLI/E2E 与文档

实际文件名可以根据当前 HEAD 调整，但不得创建第二套平行协议或重复实现。

## 实现合同

1. Browser State v2 增加当前 Route 的有界 `annotationHealth`：annotationId、resolved、total、reason。
2. Heartbeat 只写 Open 且当前 Route 的健康摘要；严格限制数量和字节。
3. `status` 增加 `--annotation <id>`、`--fail-on-diagnostics`、`--diagnostics-since <ISO>`。
4. `status --annotation` 验证选定 Runtime 的 Route 与 Annotation Route 匹配，并检查 Target Summary。
5. `status --check` 在指定 Annotation unresolved、route mismatch 或 baseline 后出现 Diagnostic 时退出 1。
6. 不指定 `--fail-on-diagnostics` 时继续报告但不失败，保持信息模式。
7. Handoff 记录生成时间、Runtime ID、Browser Update Baseline 和 Annotation ID。
8. `complete` 增加 `--summary-file <path>`；与 `--summary` 互斥，UTF-8、最大 2000 字符、必须非空并经过 Redaction。
9. 默认 Handoff Completion 命令使用 `--summary-file` 占位路径，不使用原始评论，不生成 POSIX 专用 quote。
10. Handoff 为每条 Annotation 输出精确的 `status --runtime ... --annotation ... --fail-on-diagnostics --diagnostics-since ... --check --json`。
11. Handoff 明确：修改真实源码；等待 Browser Update；运行项目验证；写实现+验证 Summary；最后 Complete。
12. 所有 JSON 输出保持单值，错误码稳定。

## 明确禁止

- 不自动清空 Diagnostics。
- 不把历史 Diagnostics 永久视为失败；必须使用时间 Baseline。
- 不把用户原始评论当作 Completion Evidence。
- 不在 Handoff 中执行命令。

## 必须新增或更新的测试

- Browser State Parser 测试 annotationHealth 边界。
- CLI 测试 Runtime、Route、Annotation、Diagnostics Since 的组合。
- CLI 测试 `--summary-file`、互斥、空文件、过大文件、Secret Redaction。
- Handoff 单测：跨平台文本，无 POSIX 转义依赖。
- E2E：目标 unresolved 时 status check 失败；恢复后通过。
- E2E：baseline 后出现 fetch 500，status fail；旧 Diagnostic 不阻塞。
- E2E：按 Handoff 命令完成 Annotation，Completion Evidence 包含真实 Summary。

## 验收标准

- **G07-001**：`status --annotation` 能验证具体目标。
- **G07-002**：新 Diagnostic 可选择性阻塞 Complete。
- **G07-003**：历史 Diagnostic 有清晰 Baseline。
- **G07-004**：Handoff 锁定 Runtime 与 Annotation。
- **G07-005**：Completion Summary 不再复制用户评论。
- **G07-006**：`--summary-file` 跨平台可用。
- **G07-007**：低参数 Agent 可按 Copy 文本完成完整闭环。

## 验收命令

先运行最小相关测试，修复后执行：

```bash
pnpm exec vitest run tests/cli/arguments.test.ts tests/cli/cli.test.ts tests/core/handoff.test.ts tests/server/browser-state.test.ts tests/client/runtime.test.ts
```
```bash
pnpm typecheck
```
```bash
pnpm test
```
```bash
pnpm check:docs
```
```bash
pnpm check:architecture
```
```bash
pnpm build
```
```bash
pnpm test:e2e
```

任何命令失败都不能标记 Goal 完成。

## 建议 Conventional Commit

```text
feat(handoff): verify annotation runtime health
```

## 完成证据格式

最终回复必须包含：

```text
Goal 07: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Behavioral result:
Commands and exact results:
Acceptance criteria:
  G07-001 PASS/FAIL/BLOCKED — evidence
  ...
Remaining risks:
Commit:
```

## Progress

- [ ] 检查实际 HEAD 和工作区。
- [ ] 建立 AC → 文件 → 测试 → 证据映射。
- [ ] 实现生产代码。
- [ ] 增加最小回归测试。
- [ ] 运行当前 Goal 完整门禁。
- [ ] 独立 Review。
- [ ] 更新 Outcomes。

## Surprises & Discoveries

- 执行时填写。

## Decision Log

- 执行时填写实际决策及原因。

## Outcomes & Retrospective

- 完成时填写。
