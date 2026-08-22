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
