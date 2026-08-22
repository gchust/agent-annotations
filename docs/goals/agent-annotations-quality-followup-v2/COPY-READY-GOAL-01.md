# COPY-READY — Agent Annotations Goal 01

下面内容可作为单个附件直接交给 Codex。它合并了共享合同和 Goal 01；完成后请改用完整目录执行 Goal 02。

---

# 共享产品与工程合同

本文件是 Goal 01～11 的共同权威合同。当前 Goal 与本文件冲突时，以本文件为准；若真实仓库事实要求调整实现路径，只能调整文件位置和内部结构，不得改变产品边界。

## 1. 执行方式

- 必须先检查实际 `git status`、当前 HEAD、相关文件和现有测试。
- 不要只输出计划、伪代码或建议；`/goal` 阶段必须实际修改仓库。
- 每个 Goal 只实现自己的范围，不得提前开始后续 Goal。
- 每个 `PASS` 必须有实际运行的命令或浏览器证据。
- 失败后先定位最小原因，修复后重跑最小测试，再跑当前 Goal 完整门禁。
- 不得通过跳过测试、增加重试、延长固定 sleep、放宽断言或捕获异常来伪造通过。
- 不得声称未执行的远程 CI、浏览器测试或平台矩阵已经通过。

## 2. 保留的产品能力

必须保留：

- React + Vite 开发态自动注入。
- `react-grab/primitives` 作为唯一通用感知引擎。
- Pick / Multi / Area。
- Annotation、Marker、List、Open/Completed/Reopen。
- 可扩展 Toolbar / Panel / Enricher / Exporter / Redactor / Host。
- Task Schema、Revision、Mutation、Redaction。
- Screenshot Evidence、Diagnostics。
- 普通 CLI Code Agent 交接；不恢复 MCP。
- Production Build 完全剔除。
- `/core` 纯入口和 packed tarball consumer。

## 3. 明确禁止

- 不恢复 MCP。
- 不恢复已删除的 `verify` 命令；合法命令仍为 `validate-task`。
- 不引入 React Fiber 私有访问、`element-source` 直连、自研源码猜测或旧感知 fallback。
- 不引入 basename 猜文件。
- 不引入浏览器源码写入、Shell、Git 或模型调用。
- 不添加 NocoBase 硬编码；NocoBase 只能通过外部 Extension 集成。
- 不为当前预发布中间态保留 Browser State 或 CLI Wait 兼容别名。
- 不静默接受非法 Task、非法 Browser State 或非法 Transport 成功响应。
- 不用模糊 Selector 或近似文本重新绑定 Marker。
- 不把用户 Query、Cookie、Header、Body、表单值写入任务、诊断或浏览器状态。

## 4. 允许的破坏性变更

当前仍为预发布 Alpha，以下变更允许破坏旧中间态：

- Browser State v1 → v2。
- 单文件 Browser State → per-runtime Browser State。
- `wait --source-revision` / `--browser-source-revision` 重命名为语义准确的新选项。
- Handoff 输出合同变化。
- `complete` 增加 `--summary-file`。
- 内部 Runtime Controller API 调整。

不要为这些旧中间态添加兼容层。旧 Browser State 应被拒绝或安全清理。

## 5. 安全不变量

- Vite API 默认仅允许 loopback，随机 Token 必须验证。
- Runtime 文件权限保持私有。
- Task 最终持久化必须执行 Parse → Generic Redaction → Parse。
- 自定义 Transport 前的 Mutation 必须验证、脱敏并重新验证。
- Screenshot 不采集表单值、凭据和原始媒体内容。
- Diagnostics 不采集 Query、Headers、Bodies、Auth。
- Page Context 默认不持久化 Search Params。
- Browser State 不包含 Token。
- Evidence、Diagnostics 和 Browser State 路径不得逃逸 Runtime Root。
- 第三方 Extension 视为可信页面代码，但其注册表面故障必须被隔离。

## 6. 测试不变量

每个 Goal 至少运行：

```bash
pnpm typecheck
pnpm test
pnpm check:architecture
```

涉及 Browser/Vite/CLI/Package 时，还必须运行对应的：

```bash
pnpm build
pnpm check:docs
pnpm check:package
pnpm check:tarball
pnpm test:e2e
```

不要在每个小修复后无条件跑最重门禁；先运行最小相关测试，Goal 结束前再跑完整门禁。

## 7. ExecPlan 记录要求

每个 Goal 文件中的以下章节必须持续更新：

- `Progress`
- `Surprises & Discoveries`
- `Decision Log`
- `Outcomes & Retrospective`

最终报告必须列出：

- 修改文件；
- 行为变化；
- 精确测试命令和结果；
- 每条 AC 的 PASS / FAIL / BLOCKED；
- 未解决风险；
- 最终 Commit SHA（若已提交）。

## 8. 停止条件

仅在以下情况下允许停止为 `BLOCKED`：

- 上游 `react-grab` 公共 API 无法满足已确认合同，且没有不违反边界的实现路径；
- 操作系统或浏览器缺失使要求的真实门禁无法运行；
- 没有远程仓库写权限，无法获得 Goal 11 要求的远程 CI；
- 所需外部发布凭据不存在。

阻塞报告必须包含：

- 已尝试路径；
- 命令和错误；
- 为什么继续会违反合同；
- 解除阻塞所需的最小输入。

## 9. 默认 Conventional Commit

每个 Goal 给出建议 Commit。除非仓库规则另有要求，保持一个 Goal 一个主提交；当前 Goal 内为修复门禁而追加的小提交可以 squash。


---

# Goal 01 — 建立可信的 Browser Update Protocol v2

## Goal Objective

```text
/goal 让浏览器“已应用源码”的状态只能由真实 Initial Mount、Full Reload 或 Vite `vite:afterUpdate` 推进；任何 Task Mutation 都不能改变该状态。
```

## 单一完成结果

让浏览器“已应用源码”的状态只能由真实 Initial Mount、Full Reload 或 Vite `vite:afterUpdate` 推进；任何 Task Mutation 都不能改变该状态。

## 问题背景

当前 `TaskController` 在 Annotation Mutation、冲突恢复和 Task Subscription 后调用源码 Revision 刷新。该刷新读取的是磁盘文件，而不是浏览器实际执行结果，因此语法错误或 HMR 失败时，Task-only 变化可能把未应用源码报告为已应用。

## 前置依赖

- 无；从共享基线开始。

## 必须先阅读

- `00-shared-contract.md`
- `CURRENT-REVIEW-BASELINE.md`
- 当前 Goal 中列出的相关生产代码与测试
- 实际仓库的 `AGENTS.md`、`package.json` 和当前 HEAD

## 主要修改范围

- `src/server/browser-state.ts`
- `src/client/runtime/mount.ts`
- `src/client/runtime/task.ts`
- `src/vite/index.ts`
- `src/types/index.ts`
- `src/core/transport.ts`
- 相关 browser-state、status、runtime、Vite 和 packed E2E 测试

实际文件名可以根据当前 HEAD 调整，但不得创建第二套平行协议或重复实现。

## 实现合同

1. 将 Browser State 协议破坏性升级为 `agent-annotations.browser-state.v2`；不读取或迁移 v1。
2. Browser State 至少包含 `browserUpdateRevision`（非负整数）、`referencedSourceRevision`（string|null）、`referencedSourceFiles`（有界数组）以及现有 runtime/task/route/heartbeat 字段。
3. `browserUpdateRevision` 的唯一推进入口是可信 Browser Update Reporter；Initial Mount 记为首个已应用 generation，之后只有 Full Reload 新 Runtime 或 `vite:afterUpdate` 推进。
4. 将当前 `refreshAppliedSourceRevision()` 重命名为语义准确的可信 Hook，例如 `reportBrowserUpdate()`；它不是 `StudioPublicApi` 命令，第三方 Extension 不能调用。
5. 从 `TaskBindings`、Task Mutation、Conflict Adoption 和 Task Subscription 中删除推进 Browser Update 的调用。
6. Task 的 Source 文件集合变化时可以将 `referencedSourceRevision` 置为 `null` 等待下一次可信 Browser Update，但不能直接报告磁盘值已应用。
7. Vite 虚拟客户端在 Initial Mount 完成后和每次 `vite:afterUpdate` 后调用可信 Hook；失败的 HMR 不得调用。
8. Heartbeat 只报告 Runtime 已经确认的状态，不能自行读取磁盘后更新 applied 字段。
9. Browser State Parser 严格拒绝未知字段、v1、非法 Revision、过大 Source File 列表和非法 SHA。
10. 保持 Task Schema 不变。

## 明确禁止

- 不在本 Goal 改 CLI Wait 选项；Goal 02 负责。
- 不实现多标签页文件布局；Goal 04 负责。
- 不通过 Task Mutation、Poll 或定时器猜测浏览器应用状态。
- 不保留 Browser State v1 兼容读取。
- 不使用固定 sleep 让 HMR 测试通过。

## 必须新增或更新的测试

- 单元测试：Task `update`、`complete`、`reopen`、`addEvidence` 不改变 Browser Update Revision。
- 单元测试：Task Conflict Adoption 不推进 Browser Update。
- 单元测试：v1 Browser State 被拒绝，v2 严格解析。
- Vite 测试：虚拟客户端只在 Initial Mount 与 `vite:afterUpdate` 调用 Reporter。
- 真实 E2E：写入语法错误，不触发成功 HMR；随后 Complete Annotation，Browser Update Revision 与 referenced applied 状态均不得推进。
- 真实 E2E：修复语法错误并成功 HMR 后才推进 Revision。

## 验收标准

- **G01-001**：Task-only Mutation 不能改变 `browserUpdateRevision`。
- **G01-002**：Task-only Mutation 不能把新的磁盘 Hash 写入 `referencedSourceRevision`。
- **G01-003**：Initial Mount 建立明确的首个 Browser Update Generation。
- **G01-004**：一次成功 `vite:afterUpdate` 精确推进一次 Generation。
- **G01-005**：失败 HMR 不推进 Generation。
- **G01-006**：Browser State v2 严格解析且 v1 明确拒绝。
- **G01-007**：第三方 Extension 无法直接报告 Browser Update。
- **G01-008**：现有 Pick/Multi/Area、Task Sync 和 Production Exclusion 无回归。

## 验收命令

先运行最小相关测试，修复后执行：

```bash
pnpm exec vitest run tests/server/browser-state.test.ts tests/client/runtime-controllers.test.ts tests/client/runtime.test.ts tests/server/vite.test.ts
```
```bash
pnpm typecheck
```
```bash
pnpm test
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
fix(runtime): trust only applied browser updates
```

## 完成证据格式

最终回复必须包含：

```text
Goal 01: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Behavioral result:
Commands and exact results:
Acceptance criteria:
  G01-001 PASS/FAIL/BLOCKED — evidence
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
