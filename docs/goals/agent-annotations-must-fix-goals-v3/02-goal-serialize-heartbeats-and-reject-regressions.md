# Goal 02 — 串行 Heartbeat 并阻止 Browser State 回退

## Goal Objective

```text
/goal 让每个 Runtime 的 Heartbeat 成为 single-flight latest-state 流，并在服务端拒绝较小 browserUpdateRevision 覆盖较大值。
```

## 单一完成结果

无论 Browser Runtime 在短时间内发生多少 Task、Route、Annotation Health 和 HMR 状态变化：

```text
同一时刻最多一个 Heartbeat 请求在途
中间状态可以合并，只发送最新快照
服务端持久化的 browserUpdateRevision 永不下降
```

## 问题背景

当前 `sendHeartbeat()` 可并发发出多个 Fetch；服务端收到后直接覆盖 Runtime JSON。较新的状态可能先到，较旧请求后到并覆盖新值，导致 `status`、`wait` 和 Handoff Verification 短暂读取回退状态。

## 前置依赖

- Goal 01 已完成并提交。
- Runtime ID 与 Revision 已能跨 HMR/Reload 连续。

## 必须先阅读

- `00-shared-contract.md`
- Goal 01 的最终 Outcomes 与 Commit
- `src/client/runtime/browser-status.ts`
- `src/server/browser-state.ts`
- `src/vite/index.ts`
- `src/client/runtime/mount.ts`
- 相关 browser-state、runtime、Vite 与 E2E 测试

## 主要修改范围

- `src/client/runtime/browser-status.ts`
- `src/server/browser-state.ts`
- `src/vite/index.ts`（仅错误映射或 Endpoint 响应需要时）
- 对应单元测试和 packed E2E

## 实现合同

### 1. Single-flight Latest-state Queue

在 Browser Status Controller 内集中实现 Heartbeat 队列：

```text
没有请求在途：立即发送当前快照
已有请求在途：用最新快照覆盖 pending
请求结束：若有 pending，立即发送最新 pending
```

要求：

- 同一 Runtime 同一时刻最多一个 POST `/heartbeat`。
- 不排队发送所有中间快照；只保留最新快照。
- Heartbeat 快照在入队时创建，必须通过现有 v2 字段构造和边界限制。
- 请求失败后不能抛出未处理 Promise；存在较新 pending 时继续发送该快照。
- 没有 pending 时由下一次周期 Heartbeat 或状态变化恢复。
- Unmount 后不得开始新的请求或发送 pending。
- `removeBrowserState()` 与 DELETE 生命周期保持独立，不通过 Heartbeat Queue 伪装删除。

### 2. 服务端 Monotonic 防线

`writeAgentAnnotationsBrowserState()` 或 Vite Endpoint 写入前：

- 读取同一 `runtimeId` 的已持久化有效 v2 状态。
- 若 Incoming `browserUpdateRevision` 小于 Existing，拒绝写入。
- 使用稳定错误码：

```text
stale_browser_state
```

- HTTP 建议返回 409；不得覆盖现有文件。
- 相同 `browserUpdateRevision` 的 Task/Route/Health/Heartbeat 更新仍允许，因为这些变化不代表 Browser Update。
- 更大的 Revision 正常写入。
- 现有严格 Parser、路径防护和多 Runtime 隔离保持不变。

### 3. Client 对 stale 响应的行为

- `stale_browser_state` 不应生成用户可见错误或无限 Diagnostic；它表示服务器已有更新状态。
- 队列继续处理最新 pending。
- 不为此降低本地 Revision，也不重读服务器 Revision 覆盖浏览器会话状态。

### 4. 不改变公开协议形态

- Browser State 保持 v2。
- CLI 字段和命令保持不变。
- 不新增 Heartbeat Sequence 字段、事件日志或兼容 Schema。

## 明确禁止

- 不引入 WebSocket、SSE、MessageChannel Server 或数据库。
- 不新增 Browser State v3。
- 不以 `lastHeartbeatAt` 替代 Revision 单调性。
- 不让服务端自动增加 Browser Update Revision。
- 不重试发送每个中间状态。
- 不开始 Release Evidence；Goal 03 负责。

## 必须新增或更新的测试

### Browser Status 单元测试

使用可控 Deferred Fetch 验证：

1. 发送 Revision 5，请求保持未完成。
2. 连续产生多个新状态，最终 Revision 6。
3. 在第一个请求完成前，不得出现第二个在途请求。
4. 第一个完成后，只发送最后一个最新快照。
5. 最终发送顺序为 5 → 6，不发送被覆盖的中间快照。
6. Unmount 后 pending 不再发送。
7. 失败请求后最新 pending 仍可继续。

### Server 单元测试

- 先写 Revision 6，再尝试写 Revision 5，返回 `stale_browser_state`，文件保持 6。
- 相同 Revision 的 Task Revision、Route、Annotation Health 更新可以写入。
- Revision 7 可以覆盖 6。
- 不同 Runtime 互不影响。
- 非法 Browser State 仍由严格 Parser 拒绝。

### Vite Endpoint 测试

- 回退 Heartbeat 返回稳定 409/错误码。
- 正常状态仍返回 200。
- 错误请求不能修改 Browser State 文件。

### Packed E2E

- 快速触发 Task Mutation、Route Change 和 HMR。
- 轮询持久化文件，观察到的 `browserUpdateRevision` 序列不得下降。
- `wait --browser-update-revision` 与 `status --check` 在压力场景下仍可靠。

## 验收标准

- **G02-001**：同一 Runtime 同时最多一个 Heartbeat POST 在途。
- **G02-002**：在途期间只保留最新 pending 快照。
- **G02-003**：服务端拒绝较小 `browserUpdateRevision`。
- **G02-004**：拒绝回退时原文件内容保持不变。
- **G02-005**：相同 Revision 的普通状态同步仍可工作。
- **G02-006**：Unmount 后没有新 Heartbeat 或 pending 泄漏。
- **G02-007**：压力 E2E 中持久化 Revision 从不下降。
- **G02-008**：CLI、Browser State v2、多 Runtime 和 Production Exclusion 无回归。

## 验收命令

```bash
pnpm exec vitest run \
  tests/server/browser-state.test.ts \
  tests/server/vite.test.ts \
  tests/client/runtime-controllers.test.ts \
  tests/client/runtime-evidence-status.test.ts
```

然后运行：

```bash
pnpm typecheck
pnpm test
pnpm check:architecture
pnpm check:docs
pnpm build
pnpm test:e2e
```

建议额外执行当前 packed E2E 连续三次，验证本问题不再 Flake：

```bash
for i in 1 2 3; do pnpm test:e2e || exit 1; done
```

## 建议 Conventional Commit

```text
fix(runtime): serialize browser heartbeats
```

## 完成证据格式

```text
Goal 02: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Queue behavior:
Server regression rule:
Commands and exact results:
Acceptance criteria:
  G02-001 PASS/FAIL/BLOCKED — evidence
  ...
Remaining risks:
Commit:
```

## Progress

- [ ] 核验 Goal 01 Commit 与当前 HEAD。
- [ ] 建立并发复现测试。
- [ ] 实现 single-flight latest-state Queue。
- [ ] 增加服务端单调性防线。
- [ ] 运行全部门禁和重复 E2E。
- [ ] 独立 Review 和 `git diff --check`。

## Surprises & Discoveries

- 执行时填写。

## Decision Log

- 执行时填写实际决策及原因。

## Outcomes & Retrospective

- 完成时填写。
