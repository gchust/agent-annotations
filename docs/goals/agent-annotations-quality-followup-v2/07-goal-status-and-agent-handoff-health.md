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

- [x] 检查实际 HEAD `9cc09873585fb9c011f9ac22fa041e2326d5d34f` 和干净工作区，并复核 Shared Contract、Goal 07、Browser State、Marker Snapshot、CLI、Diagnostics 与 Handoff 调用链。
- [x] 建立 AC → 文件 → 测试 → 证据映射：G07-001～003 由 Browser State/CLI/packed vertical 覆盖，G07-004～007 由 Handoff/summary-file/packed completion 覆盖。
- [x] 实现生产代码：当前 Route 的 Open Annotation Health Heartbeat、精确 Status/Diagnostics 检查、严格 UTF-8 Summary File、固定 Baseline 的 Handoff。
- [x] 增加 Parser、CLI、Runtime、Handoff 与 packed Chromium 回归测试。
- [x] 运行当前 Goal 完整门禁；最终全部通过。
- [x] 独立 Review 最终 Diff，修复 Summary Redaction 扩张越过 2000 字符、Heartbeat 缓存陈旧、Health 最大合法集合超过字节上限，以及 Handoff 指令顺序问题。
- [x] 更新 Outcomes；未开始 Goal 08。

## Surprises & Discoveries

- `redactAgentAnnotationsText()` 可能把接近 2000 字符的输入扩张到 Schema 上限之外；CLI 现在先完整脱敏，再以带截断标记的 2000 字符结果进入 Mutation。
- Marker 可见时 Goal 06 的 Observer 会主动刷新 Snapshot，但 Marker 隐藏时仍需要周期 Heartbeat 重新解析，否则 Health 可能永久保留旧值；最终 packed test 显式隐藏 Marker 验证此路径。
- 6 KiB 无法容纳 50 条全部合法且使用最长 ID/Reason 的 Health；改为仍然严格有界的 8 KiB，覆盖 Task Schema 允许的 50 条最坏合法集合。
- 首次并行执行 `check:package` 与 `build` 时，Build 清理 `dist` 导致 Publint 报导出文件缺失；完成 Build 后串行重跑通过。该失败是门禁互相干扰，不是产品缺陷。
- packed E2E 的两个中间失败来自测试编排：恢复轮询误用会在首个非零退出时抛错的 CLI helper；隐藏 Marker 后未恢复可见性影响后续既有断言。两处均收紧为真实状态轮询并隔离测试状态，最终完整 packed gate 通过。

## Decision Log

- 复用 Goal 06 唯一 `resolutionSnapshot()`，Heartbeat 不建立第二套 Selector/Identity 解析；Task、Route、DOM 变化会重置 Snapshot，5 秒 Heartbeat 也会重置以覆盖 Marker 隐藏状态。
- Browser State 继续使用严格 v2 Parser；`annotationHealth` 限 50 条、8 KiB、唯一合法 ID、0～50 计数及 Reason/Resolved 一致性，不保留旧格式兼容路径。
- `status --annotation` 只在选中 Runtime 上核对 Task Annotation Route 与 Heartbeat Health；Diagnostics 默认只报告，只有同时指定 `--fail-on-diagnostics` 与规范 ISO Baseline 时才参与 `--check`。
- Handoff 使用调用时的单一 `generatedAt` 同时作为展示时间和 Diagnostics Baseline，并固定 Runtime、Route、Browser Update Baseline 与每条 Annotation；命令只使用无空格文件名占位符，不引入 Shell Quote 抽象。
- 保留已有直接 `--summary` 能力；新增 `--summary-file` 与其严格互斥，不增加别名或兼容层。Summary File 使用 Node 标准库严格 UTF-8 解码、非空/大小限制及既有通用脱敏。
- 不清空 Diagnostics，不加入 MCP、NocoBase 或 Module Graph Hashing，也未开始 Goal 08。

## Outcomes & Retrospective

- 行为结果：Browser State Heartbeat 现在携带当前 Route 最多 50 条 Open Annotation Health；`status --annotation --check` 会对 Runtime、Route、Target Summary 与同步状态给出单值 JSON 和稳定退出码；可选 Diagnostics Baseline 只阻塞新错误。
- Handoff 现在按 `source edit → browser update wait → project verification → exact annotation status → implementation+verification summary file → complete` 输出，固定生成时间、Runtime、Route、Annotation 与 Diagnostics Baseline，Completion 命令不再复制用户评论。
- `complete --summary-file` 对不可读、非法 UTF-8、空白、超过 2000 字符及与 `--summary` 同时出现均退出 2；合法内容经过既有 Redaction 后持久化。
- G07-001 PASS：CLI 单测覆盖 found/missing、route match/mismatch、resolved/unresolved；packed Chromium 在 Marker 隐藏时移除精确 Target 后失败、恢复相同节点后通过。
- G07-002 PASS：CLI 与 packed Chromium 均证明 Baseline 后新 fetch 500 仅在 opt-in 时使 `status --check` 退出 1。
- G07-003 PASS：旧 Diagnostic 在 Handoff `generatedAt` 之前不阻塞；新 Handoff 生成新 Baseline 后恢复通过，Diagnostics 未被清空。
- G07-004 PASS：Handoff 单测和 packed Copy 文本均包含精确 Runtime、Route、Browser Update Baseline、Annotation ID 与 Diagnostics Baseline。
- G07-005 PASS：Completion 命令仅引用 Summary File；packed completion evidence 等于实现+验证摘要，且不等于原始评论。
- G07-006 PASS：CLI 覆盖严格 UTF-8、互斥、空/过大/不可读、Secret Redaction 及脱敏扩张边界；Handoff 使用跨平台无空格相对文件名。
- G07-007 PASS：fresh packed consumer 使用生成的 Status 与 Completion 参数完成真实 Browser→CLI→Browser 闭环。
- 最终门禁：`pnpm exec vitest run tests/cli/arguments.test.ts tests/cli/cli.test.ts tests/core/handoff.test.ts tests/server/browser-state.test.ts tests/client/runtime.test.ts` = 5 files / 202 tests PASS；`pnpm typecheck` PASS；`pnpm test` = 37 files / 456 tests PASS；`pnpm check:docs` PASS；`pnpm check:architecture` = 1 file / 29 tests PASS；`pnpm build` PASS；`pnpm check:package` = Publint/ATTW PASS；`pnpm check:tarball` = 26 files / 116371 bytes PASS；`pnpm test:e2e` = 19 Playwright tests plus SIGTERM cleanup PASS；`git diff --check` PASS。
- 剩余风险：Diagnostics Baseline 使用调用端生成时钟与服务端记录时钟；本地开发态通常同机，但跨机器时钟漂移仍可能改变边界归属。Goal 07 未引入时钟同步协议。
