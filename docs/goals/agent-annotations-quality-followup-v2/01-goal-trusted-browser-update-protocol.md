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

- [x] 检查实际 HEAD 和工作区：HEAD `6651cff4d970fd3ddf23f414d08f56149d3709ab`，工作区初始干净。
- [x] 建立 AC → 文件 → 测试 → 证据映射。
- [x] 实现生产代码：Browser State v2、可信 `reportBrowserUpdate()`、Task Controller 解耦。
- [x] 增加最小回归测试：173 个 focused tests，包含四类 task-only mutation、冲突 adoption、严格 v2 parser 和 HMR reporter。
- [x] 运行当前 Goal 完整门禁。
- [x] 独立 Review：最终 diff 仅触及 Goal 01 的 runtime/browser-state/Vite/packed E2E 面。
- [x] 更新 Outcomes。

## Surprises & Discoveries

- 基线与用户提供的 HEAD 一致；未发现需要调整范围的工作区漂移。
- 初始 mount 的 source file 集合来自当前 Task；Task-only 更新只在集合变化时清空 `referencedSourceRevision`，不会推进 `browserUpdateRevision`。
- `/revision` 响应必须带合法 SHA 与有界 `sourceFiles`；可信 reporter 还使用请求 generation 和当前 task identity 丢弃过期结果。
- 首次 packed E2E 的 status 场景假定新增 annotation 后仍有可信 source snapshot；该场景改为显式 full reload，随后测试语法错误 HMR 与 task-only complete 的不推进语义。
- 实测 Vite 6 在 React transform 失败后仍可能发送 `vite:afterUpdate`；虚拟客户端因此先按事件中的 accepted paths 验证更新资源均为成功响应，再调用 reporter。真实语法错误 E2E 证明失败路径不推进 task-only complete 前后的 generation。
- 最终独立 review 发现 `/revision` 已返回 Task identity 但 client 尚未核对；补充严格相等检查，避免订阅尚未到达时把另一 Task revision 的磁盘 Hash 安装到当前快照。

## Decision Log

- 将协议直接升级为 `agent-annotations.browser-state.v2`，不保留 v1 读取或兼容字段，符合 Alpha 破坏性变更合同。
- 将 `refreshAppliedSourceRevision` 改为仅由生成的 Vite client 调用的 `reportBrowserUpdate`，并从 TaskBindings、mutation、conflict adoption、subscription 删除调用。
- 保留 handoff 内部字段名 `appliedSourceRevision` 作为格式化输入，避免扩大 Goal 01 的 handoff 合同；CLI/browser wire state 使用 `referencedSourceRevision`。
- Reporter 仅在请求 generation、当前 Task identity 与 `/revision` 响应 Task identity 三者一致时接受 source snapshot。
- 不改 CLI wait 选项；Goal 02 负责该合同。

## Outcomes & Retrospective

- Browser-applied state 现在包含 `browserUpdateRevision`、`referencedSourceRevision` 和有界 `referencedSourceFiles`。Task-only mutation、conflict adoption、subscription 不推进 generation；initial mount/full reload 与 `vite:afterUpdate` 由 reporter 推进。
- Browser State v1、未知字段、非法 SHA/revision、过大 source file 列表均拒绝；heartbeat 只写入 runtime 已确认的状态。
- 异步 `/revision` 的过期请求、本地 Task 变化及服务端 Task identity 不匹配均不能安装 referenced source snapshot。
- Focused tests（4 files / 173 tests）、typecheck、full unit suite（37 files / 435 tests）、architecture（29 tests）、build、docs、package、tarball（26 files / 107215 bytes）和 packed consumer E2E 均通过；首次 E2E status 检查失败后修复为显式 full reload 并重跑。
- 未开始 Goal 02；未 push、publish 或 tag。
