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

- [x] 核验 Goal 01 Commit 与当前 HEAD `2e905e92a6c28abcdf9bd5eedb8c3b9464adea7e`。
- [x] 用可控 Deferred Fetch 建立并发、失败和 Unmount 复现测试。
- [x] 实现 per-controller single-flight latest-state Queue。
- [x] 增加服务端 Revision 单调性防线和稳定 409 映射。
- [x] 运行全部门禁和最终 fresh packed E2E。
- [x] 独立 Review 和 `git diff --check`。

## Surprises & Discoveries

- 首次完整 `pnpm test` 暴露两个 Architecture Audit 失败：初始变量名 `heartbeatInFlight` 命中了禁止旧协议字面量的审计。改为准确描述当前队列状态的 `requestActive` 后，完整套件通过；没有放宽审计。
- 首次新增 packed 压力场景在并发 Task Mutation 后立即断言 Source Hash，同一次 HMR 的 Hash 合法地对应 mutation 前 Task，因此失败。测试改为先等待 Task 同步，再触发一次 settling HMR 后验证 Source Hash；修正后压力场景和 fresh 完整 packed run 均通过。
- 独立 Review 发现新增 E2E runtime poll 的 `not.toBeNull()` 会接受 `undefined`；收紧为 `toBeDefined()` 后重新运行最终完整 packed E2E，仍全部通过。
- 新的 read-before-write 单调检查若直接读取 symlink 会扩大原有文件边界；写入前使用 `lstatSync` 拒绝 symlink/非普通文件，并用独立 symlink 回归测试验证外部目标不变。
- 一次直接在仓库 fixture 运行 Playwright 使用了旧 checked-in tarball，旧 CLI shape 因此失败；该诊断运行不是产品候选证据。最终证据全部来自 `pnpm test:e2e` fresh pack/install 的同一 tarball consumer。

## Decision Log

- Queue 只保留一个已序列化 JSON pending snapshot：idle 时立即 POST，active 时覆盖 pending，请求 resolve/reject 后只 drain 最新 pending。这样直接满足 single-flight/latest-state，不新增通用队列抽象或协议字段。
- `409 stale_browser_state` 与网络失败都视为当前请求完成；若有更新 pending 则继续发送。客户端不降低 revision、不读取服务端状态覆盖 session，也不产生用户可见 Diagnostic。
- Unmount 先永久停止 controller heartbeat 并清空 pending；DELETE 仍由 `removeBrowserState()` 独立发送，不进入 heartbeat Queue。
- Store 在同一 Runtime 文件上比较严格解析后的 Browser State v2：lower revision 抛出 code/message 均为 `stale_browser_state`，equal 和 greater revision 继续写入。Vite 只增加该错误到既有 409 映射。
- 保持 Browser State v2、CLI shape、多 Runtime 隔离和 Goal 01 session/reload 行为；未增加 intermediate retry、WebSocket/SSE 或 Goal 03 Release Evidence。

## Outcomes & Retrospective

- 行为结果：每个 Browser Status Controller 同时最多一个 heartbeat POST；active 期间重复状态变化只覆盖一个 pending snapshot；成功、409 和 rejection 都 drain 最新 pending；Unmount 清空 pending 且不再开始 POST。
- 服务端结果：Revision 6 后写 Revision 5 返回 `stale_browser_state`，Vite endpoint 返回 exact `409 {"error":"stale_browser_state"}`，原文件字节保持不变；equal Revision 的 Route/Task/Health 更新、Revision 7 和另一 Runtime 均正常写入。
- Focused gate PASS：4 files / 77 tests。`pnpm typecheck` PASS。`pnpm test` PASS：42 files / 489 tests。Architecture PASS：31 tests。Docs smoke PASS。Build PASS。`git diff --check` PASS。
- 最终 `pnpm test:e2e` PASS，无 retry masking：fresh tarball/consumer 的 vertical 1、source 1、reliability 9、route 1、UX 2、polish 3、relative-base 1、shutdown cleanup 与 status 4 tests 全部通过；压力场景实际采样 `heartbeat-revisions observed=[1,2,3]`，CLI Wait 和 `status --check` 均成功。
- G02-001 PASS：Deferred Fetch 记录 `maxInFlight === 1`，Revision 5 未完成前无第二个 POST。
- G02-002 PASS：多个中间更新最终只发送 Revision 5 → 6，第二个 body 为最新 `/latest` / Task Revision 2 snapshot。
- G02-003 PASS：Store unit 与 Vite endpoint 都拒绝 6 → 5，稳定错误码 `stale_browser_state`。
- G02-004 PASS：Store 与 endpoint 在 stale write 前后比较 exact file bytes，相等。
- G02-005 PASS：equal Revision 的 Route、Task Revision 和 Annotation Health 更新均成功持久化。
- G02-006 PASS：controller stop 和实际 mount `unmount()` 测试均证明 active request 完成后 pending 不发送，POST count 保持 1。
- G02-007 PASS：fresh packed 压力 E2E 采样 revision `[1,2,3]`，逐样本均不下降。
- G02-008 PASS：489-test full suite、31-test Architecture、Build 和完整 fresh packed consumer 覆盖 CLI、Browser State v2、多 Runtime、Goal 01 reload continuity 与 Production Exclusion/shutdown，无回归。
- Remaining risk：Store 防线针对本 Vite server 的同步文件写入路径；绕过产品直接并发修改 runtime 文件不在支持合同内。
- 未开始 Goal 03；未 push、publish、tag 或 release。
