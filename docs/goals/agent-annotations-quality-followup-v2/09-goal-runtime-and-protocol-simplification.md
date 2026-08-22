# Goal 09 — 删除重复协议并减少每次 UI 更新的重复工作

## Goal Objective

```text
/goal 只保留完整 Browser State Heartbeat，删除无调用 `/source` Endpoint；每次逻辑状态更新只构造一次 Public Snapshot 和一次 Chrome 更新。
```

## 单一完成结果

只保留完整 Browser State Heartbeat，删除无调用 `/source` Endpoint；每次逻辑状态更新只构造一次 Public Snapshot 和一次 Chrome 更新。

## 问题背景

当前 HttpTaskTransport 仍发送空 Heartbeat，而 Browser Runtime 已发送完整状态。Vite 仍保留 legacy 空 Heartbeat 分支和看起来没有生产调用方的 `/source`。大量调用点 `render(); emit();` 会重复 Clone、Deep Freeze 和刷新 Chrome。README 还展示了 Runtime 内部会再次包装的 Transport。

## 前置依赖

- Goal 08 完成并通过。

## 必须先阅读

- `00-shared-contract.md`
- `CURRENT-REVIEW-BASELINE.md`
- 当前 Goal 中列出的相关生产代码与测试
- 实际仓库的 `AGENTS.md`、`package.json` 和当前 HEAD

## 主要修改范围

- `src/server/transport.ts`
- `src/vite/index.ts`
- `src/client/runtime/mount.ts`
- 可新增 `src/client/runtime/ui-state.ts`、`browser-status.ts`
- `README.md` / `API.md`
- 相关 Transport、Runtime、Vite、性能和 packed E2E 测试

实际文件名可以根据当前 HEAD 调整，但不得创建第二套平行协议或重复实现。

## 实现合同

1. 删除 HttpTaskTransport 的空 Heartbeat timer、in-flight 状态和请求。
2. Vite `/heartbeat` 只接受严格 Browser State v2；删除空 Body 和 `{}` legacy 分支。
3. 确认 `/source` 没有公开或生产调用方后，删除 Endpoint、代码和只服务它的测试；源码规范化仍在 Task Mutation 服务端边界执行。
4. README Manual Runtime 示例直接传 Custom Transport；不要重复调用 Runtime 已内置的 validated wrapper。
5. 将 Overlay 更新与 Public State Commit 分开；一个逻辑状态变化最多构造一次 Snapshot。
6. 消除 `render(); emit();` 导致的双重 `refreshChrome()`。
7. Snapshot 只执行一次 `structuredClone`，再 deepFreeze；不先单独 Clone task。
8. 可抽取 Browser Status Controller 和 UI Commit Coordinator，进一步减小 `mount.ts`。
9. 给高频操作增加可测试计数：一次 Task Mutation、Route Change、Toolbar Action 不重复 Commit。
10. 保持 PointerMove 只更新交互 Overlay，不 Commit 完整 Public Snapshot。
11. 删除完成后更新架构图和 Audit，禁止 legacy heartbeat/source endpoint 回归。

## 明确禁止

- 不改变公开 Task Schema。
- 不删除完整 Browser State Heartbeat。
- 不把 UI 简化成多 React Root。
- 不通过缓存可变 Snapshot 破坏 Extension 冻结边界。

## 必须新增或更新的测试

- Transport 单测：subscribe 不再产生空 Heartbeat。
- Vite 单测：空/{} Heartbeat 被拒绝，v2 正常。
- Audit/搜索测试：无 `/source` Route 和 legacy heartbeat。
- Runtime 单测：一次逻辑更新一次 Snapshot/Chrome Commit。
- Runtime 性能测试：PointerMove 不 Commit Public State。
- Packed E2E 全流程无回归。

## 验收标准

- **G09-001**：只剩一套 Browser Heartbeat。
- **G09-002**：`/source` 生产面物理删除。
- **G09-003**：Manual Transport 文档无双重包装。
- **G09-004**：每个逻辑更新只生成一次 Snapshot。
- **G09-005**：PointerMove 仍为轻量路径。
- **G09-006**：`mount.ts` 职责和体积有可见下降。
- **G09-007**：无兼容分支残留。

## 验收命令

先运行最小相关测试，修复后执行：

```bash
pnpm exec vitest run tests/server/transport.test.ts tests/server/vite.test.ts tests/client/runtime.test.ts tests/client/runtime-controllers.test.ts
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
pnpm check:docs
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
refactor(runtime): remove duplicate protocol paths
```

## 完成证据格式

最终回复必须包含：

```text
Goal 09: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Behavioral result:
Commands and exact results:
Acceptance criteria:
  G09-001 PASS/FAIL/BLOCKED — evidence
  ...
Remaining risks:
Commit:
```

## Progress

- [x] 检查实际 HEAD 和工作区：开始于 `d4ff943ca34d4adf04be736c560acfec9ac8a9ca`，工作区仅含本 Goal 变更。
- [x] 建立 AC → 文件 → 测试 → 证据映射。
- [x] 实现生产代码：删除空 heartbeat、`/source`，提取 browser-status/UI coordinator，合并 public commit。
- [x] 增加最小回归测试：transport/Vite strictness、audit、runtime public commit counter。
- [x] 运行当前 Goal 完整门禁。
- [x] 独立 Review：复查最终 diff、调用点、协议搜索和计数测试。
- [x] 更新 Outcomes。

## Surprises & Discoveries

- Vite 的 legacy heartbeat 测试在严格协议变更后按 Alpha 合同更新为 400；`/source` 物理删除后新增 404 断言。
- 诊断必须在 coordinator 初始化前安全记录，因此保留早期 no-op binding，并由 coordinator 初始化时捕获已记录诊断。

## Decision Log

- 使用 `ui-state.ts` 单一 coordinator：`commit()` 负责 overlay + 一次 snapshot/Chrome，`commitPublic()` 负责 diagnostics 等无 overlay 的 public 更新，`refreshChrome()` 只更新 pending/chrome revision。
- 保持 pointermove 的 `refreshInteractiveOverlays()` 路径，不触发 coordinator commit；toolbar pending 状态只走 `refreshChrome()`。
- Browser status 责任抽到 `browser-status.ts`，避免在 mount 中保留第二套 heartbeat/revision 逻辑。
- 删除 `HttpTaskTransport` 空 heartbeat 与 Vite `/source`，不保留兼容别名。

## Outcomes & Retrospective

- 完成：一套严格 Browser State v2 heartbeat；无 `/source` route；transport 文档直接传 custom transport；mount 从 1492 行降至 1363 行。
- 性能证据：新增 runtime 测试验证单次 mutation、route change、toolbar action 各增加 1 个 `data-public-commits`，100 次 pointermove 增量为 0。
- 相关测试 4 files / 186 tests、完整 `pnpm test` 37 files / 462 tests 均通过；architecture 31 tests、docs、typecheck、build 均通过。
- `check:package` 通过（publint/ATTW），`check:tarball` 通过（26 files, 116899 bytes）。
- 首次 packed E2E 暴露动态 iframe resolution 后 List 未刷新；修复为 resolution snapshot 变化时仅刷新 Chrome（不增加 public commit），重跑后 20/20 Playwright 场景通过。
- G09-001 PASS：transport 只轮询 `/task`，runtime controller 独占完整 heartbeat；focused transport/Vite tests 通过。
- G09-002 PASS：Vite `/source` route 删除，认证 POST 返回 404，audit 禁止 route literal 回归。
- G09-003 PASS：README manual transport 直接传入，runtime 仍统一验证边界。
- G09-004 PASS：单一 coordinator 只 clone/freeze 一次；mutation/route/toolbar 计数均为 +1。
- G09-005 PASS：100 次 pointermove public commit 增量为 0，packed browser flows 通过。
- G09-006 PASS：browser status 与 UI commit 职责抽取，`mount.ts` 减少 129 行。
- G09-007 PASS：空 body/`{}` heartbeat 均为 400，audit/search 无 legacy 分支。
