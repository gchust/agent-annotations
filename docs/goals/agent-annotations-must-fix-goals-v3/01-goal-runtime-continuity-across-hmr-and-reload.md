# Goal 01 — 保持 Runtime 身份与 Browser Update Revision 连续

## Goal Objective

```text
/goal 让同一浏览器标签页在 Studio HMR 重挂载和完整页面 Reload 后继续使用同一个 runtimeId，并让 browserUpdateRevision 永远单调递增；旧 Handoff 在 Reload 期间仍可等待并恢复。
```

## 单一完成结果

同一标签页经历：

```text
普通业务 HMR
→ Client Extension HMR 导致 Studio 重挂载
→ 完整页面 Reload
```

之后必须同时满足：

```text
runtimeId 不变
browserUpdateRevision 严格大于旧基线
wait --runtime <原 id> 不因短暂断连提前失败
```

## 问题背景

当前 Vite 虚拟客户端仅在 `window` Symbol 中保存 Runtime ID，而 `createBrowserStatusController()` 每次创建都从 `browserUpdateRevision = 0` 开始。HMR 重挂载或完整 Reload 可能导致同一 Runtime 的 Revision 回退；完整 Reload 还会删除旧 Browser State，使已经复制给 Code Agent 的 `--runtime <id>` 立即失效。

## 前置依赖

- 无。
- 基线应为 `7d53c9a...` 或其后仅包含无关修改的 HEAD。

## 必须先阅读

- `00-shared-contract.md`
- `src/client/runtime/browser-status.ts`
- `src/client/runtime/mount.ts`
- `src/vite/index.ts`
- `src/server/browser-state.ts`
- `src/cli/index.ts`
- `fixtures/packed-react-vite/tests/status.spec.ts`
- `fixtures/packed-react-vite/tests/vertical.spec.ts`
- 相关 browser-state、runtime、Vite 与 CLI 测试

## 主要修改范围

优先范围：

- `src/client/runtime/browser-status.ts`
- `src/vite/index.ts`
- `src/cli/index.ts`
- `src/types/index.ts`（仅在现有内部配置类型需要最小调整时）
- 对应单元测试与 packed Playwright E2E

允许新增一个职责单一的浏览器会话状态 Helper，例如：

```text
src/client/runtime/browser-session.ts
```

不得建立第二套 Browser State 协议。

## 实现合同

### 1. Session-scoped Runtime State

实现版本化、严格校验、best-effort 的浏览器会话状态：

```ts
{
  runtimeId: string;
  browserUpdateRevision: number;
}
```

要求：

- 使用标签页会话级存储；Reload 后保留，新标签页默认隔离。
- Storage Key 必须版本化，并避免同一 Origin 下不同 Agent Annotations Endpoint 相互覆盖。
- 非法 JSON、非法 ID、负数、非安全整数必须忽略并重建，不能阻止页面启动。
- Storage 不可用时不能抛错；但正常浏览器环境必须满足连续性验收。

### 2. Runtime ID Ownership

- 将 Runtime ID 的创建和恢复集中到一个入口。
- Vite 虚拟客户端不得继续只依赖 `window[Symbol]` 作为 Reload 持久化。
- 同一标签页 HMR 重挂载与 Full Reload 使用同一个 Runtime ID。
- 两个独立 Playwright Page/Browser Context 必须得到不同 Runtime ID。

### 3. Monotonic Browser Update Revision

- Browser Status Controller 从持久化 Revision 恢复，而不是固定从 0 开始。
- 每次可信 `reportBrowserUpdate()` 先递增，再立即持久化最新值。
- HMR 重挂载后下一次更新必须大于重挂载前的 Baseline。
- Task Mutation、Task Subscription、Evidence 和 Heartbeat 不得推进 Revision。
- 不因 Browser State 文件暂时缺失而重置浏览器本地 Revision。

### 4. Reload 生命周期

- `pagehide` 与 Vite HMR dispose 不得立即物理删除当前 Runtime State。
- 关闭标签页后的旧状态由现有 Freshness/Cleanup 机制过期清理。
- 显式调用 Library 的最终 `unmount()` 仍可按当前公开合同删除状态；若调整默认参数，必须更新 API 文档并有测试。
- 不引入 `beforeunload` 阻塞、同步 XHR 或 unload Beacon 兼容逻辑。

### 5. Reload-tolerant CLI Wait

对于：

```bash
agent-annotations wait \
  --browser-update-revision <baseline> \
  --runtime <runtime-id> \
  --timeout-ms <n> \
  --json
```

规则：

- 指定 Runtime 暂时不存在时，不立即 `browser_runtime_not_found`；继续有界等待。
- Runtime 重新出现并 Revision 大于 Baseline 时返回 `changed: true`。
- 超时仍未出现时返回 `changed: false`，并通过稳定字段说明 Runtime 未连接。
- `ambiguous_browser_runtime` 仍立即失败，因为它不是 Reload 短暂断连。
- `status --runtime` 的现有即时语义保持不变；只调整 `wait`。

## 明确禁止

- 不升级 Browser State v2 Schema。
- 不新增 Runtime Alias、Server Session 映射表或迁移数据库。
- 不新增 WebSocket/SSE。
- 不通过 Task Revision 推算 Browser Update Revision。
- 不让每个 HMR Module 拥有自己的 Revision。
- 不使用固定 sleep 作为核心验收。
- 不开始 Heartbeat single-flight；Goal 02 负责。

## 必须新增或更新的测试

### 单元测试

- Session State 正常读写、非法值恢复、Storage 异常不崩溃。
- Controller 从已有 Revision `N` 恢复，第一次可信报告后为 `N + 1`。
- Task-only `setTask()` 不改变 Revision。
- HMR 重建 Controller 后 Revision 不回退。
- `wait --runtime` 在 Runtime 缺失后继续等待；超时输出稳定 JSON。

### Vite 虚拟客户端测试

- 生成代码不再仅依赖 `window` Symbol 保存 Runtime ID。
- HMR dispose 保留 Session State。
- `pagehide` 不立即删除 Runtime State。
- 显式最终 Unmount 的清理行为符合文档。

### Packed Playwright E2E

至少覆盖：

1. 初始记录 `{ runtimeId, revision: N }`。
2. 修改普通业务组件，等待 Revision 大于 N。
3. 修改 Client Extension，触发 Studio HMR 重挂载。
4. Runtime ID 不变，Revision 继续大于前值。
5. 启动 `wait --runtime <id>`，触发完整页面 Reload，再触发一次成功更新。
6. Wait 不提前失败，最终返回 `changed: true`。
7. 新开独立 Page 后存在不同 Runtime ID。

## 验收标准

- **G01-001**：同一标签页 HMR 重挂载后 `runtimeId` 不变。
- **G01-002**：同一标签页完整 Reload 后 `runtimeId` 不变。
- **G01-003**：新标签页获得不同 Runtime ID。
- **G01-004**：`browserUpdateRevision` 在 HMR 重挂载后严格单调递增。
- **G01-005**：`browserUpdateRevision` 在 Full Reload 后严格单调递增。
- **G01-006**：Task-only Mutation 不推进 Revision。
- **G01-007**：`wait --runtime` 能跨越 Reload 短暂断连。
- **G01-008**：关闭标签页后的状态仍由现有过期清理控制，没有永久文件泄漏。
- **G01-009**：现有多 Runtime 选择、Status、Pick/Multi/Area 与 Production Exclusion 无回归。

## 验收命令

先运行最小相关测试：

```bash
pnpm exec vitest run \
  tests/server/browser-state.test.ts \
  tests/client/runtime-controllers.test.ts \
  tests/client/runtime-evidence-status.test.ts \
  tests/server/vite.test.ts \
  tests/cli/cli.test.ts
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

任何命令失败都不能标记 Goal 完成。

## 建议 Conventional Commit

```text
fix(runtime): preserve browser update continuity
```

## 完成证据格式

```text
Goal 01: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Session-state design:
Commands and exact results:
Acceptance criteria:
  G01-001 PASS/FAIL/BLOCKED — evidence
  ...
Remaining risks:
Commit:
```

## Progress

- [x] 核验 HEAD、工作区和现有 Runtime 生命周期：基线 HEAD `1f780e4f87f32f89ab6ade3106109f958927ba44`；保留并审查 handoff 前已有的 `src/vite/index.ts` 与 `tests/server/vite.test.ts` 修改。
- [x] 建立 AC → 文件 → 测试 → 证据映射：session/controller 覆盖 G01-001～006，CLI 覆盖 G01-007，Store cleanup 覆盖 G01-008，完整 packed/browser gates 覆盖 G01-009。
- [x] 实现 Session-scoped Runtime State：endpoint-scoped、严格校验、storage failure best-effort。
- [x] 修复 HMR/Reload 生命周期：HMR dispose 与 `pagehide` 保留状态，显式最终 `unmount()` 清理状态。
- [x] 修复 CLI Wait 的短暂断连行为：仅 pinned `--runtime` 的 not-found 继续等待；Status 与 ambiguity 语义不变。
- [x] 运行全部门禁：focused、typecheck、unit、architecture、docs、build、packed E2E 全部 PASS。
- [x] 独立 Review 和 `git diff --check`：最终 scope、lifecycle、CLI output、测试隔离与 Goal 02/03 未修改均已复核。

## Surprises & Discoveries

- handoff 前的两个 tracked 修改把虚拟客户端的 ID 生成从 `crypto.randomUUID()` 换成共享 `createAgentAnnotationsId()`，校验/生成方向正确，但仍由 window Symbol 持有，无法跨 reload。本 Goal 保留共享 generator 的意图，将 ownership 移到 browser-session helper，并相应重写原测试断言。
- Goal bundle 审计基线是 `7d53c9a...`，实际 HEAD 已到 `1f780e4...`；现有 Browser State v2、多 Runtime selector、15 秒 freshness 与 24 小时 cleanup 可直接复用，无需 alias 或服务端会话表。
- Vite generated client 的公开 wrapper 已有 `preserveBrowserState` teardown 参数；因此不需修改 `MountedAgentAnnotations.unmount()` 的公开签名，普通 library `unmount()` 仍保持最终清理语义。
- 首次 required `pnpm test:e2e` 因 test child 使用 `pnpm exec agent-annotations` 而 FAIL：环境中的颜色配置 warning 写到 stderr，产品行为断言未失败。改为直接用 Node 调用已安装 tarball 的公开 CLI entry 后，stdout/stderr 合同可精确断言且不改变产品代码；最终完整命令 PASS。
- 最终 packed 场景必须在 reload 后再触发一次普通业务 HMR，才能证明 pinned Wait 真正跨过断连并等待后续成功更新，而不是仅由 reload mount 自身立即满足。

## Decision Log

- 使用版本化 key `agent-annotations.browser-session.v1:<endpoint>` 存储 `{ runtimeId, browserUpdateRevision }`；浏览器原生 `sessionStorage` 提供 reload persistence 与 tab isolation，endpoint 后缀避免同源实例碰撞。
- Session parser 拒绝非法 JSON、未知字段、非法 ID、负数、非整数与非 safe integer；storage 读写删除均为 best-effort。显式 `runtimeId` 保持现有校验与覆盖合同。
- `reportBrowserUpdate()` 在可信调用时先递增并立即持久化，再发送 heartbeat/revision 请求；task subscription、mutation、evidence 与 heartbeat 继续只发送当前值。
- Safe-integer ceiling 保持当前最大值，不生成 Browser State v2 无法表示的数；协议扩容留给明确的 schema 变更。
- CLI 只吞掉 pinned `--runtime` 的 `browser_runtime_not_found`；无 selector/route ambiguity 仍立即失败，`status --runtime` 仍即时返回 selection error。Wait JSON 增加稳定 `browserConnected` 字段区分 timeout disconnection。
- `pagehide` 与 HMR dispose 调用内部 preserve teardown；Page close 不再依赖 unload DELETE，旧文件按现有 15 秒 freshness/24 小时 cleanup 机制退出选择并清理。

## Outcomes & Retrospective

- 行为结果：同一 tab 的 initial mount、普通 HMR、client-extension HMR remount 与 full reload 共享一个 Runtime ID，revision 从 session 恢复且每次可信更新严格增加；新 tab 使用独立 session。
- `wait --browser-update-revision ... --runtime ...` 可在状态文件暂时缺失时保持运行，重连且 revision 超过 baseline 后返回 `changed: true`；超时返回 `changed: false`、`browserConnected: false` 与 null revision。
- Focused gate PASS：5 files / 103 tests。`pnpm typecheck` PASS。`pnpm test` PASS：42 files / 484 tests。Architecture PASS：31 tests。Docs smoke PASS。Build PASS。
- 最终 `pnpm test:e2e` PASS：exact packed tarball 的 vertical 1、source 1、reliability 9、route 1、UX 2、polish 3、relative-base 1、shutdown cleanup 与 status 3 tests 全部通过；status 场景真实覆盖普通 HMR、Studio remount、full reload、pinned Wait 和 tab isolation。
- G01-001 PASS：packed client-extension HMR 后 exact runtime selector 仍命中原 Runtime ID。
- G01-002 PASS：packed full reload 前后 `selectedRuntimeId` 相等。
- G01-003 PASS：同一 Browser Context 新 Page 的 Runtime ID 与原 Page 不同。
- G01-004 PASS：controller remount unit test 从 8 增到 9；packed extension remount 后 revision 大于 remount 前值。
- G01-005 PASS：packed reload 后 revision 大于 reload baseline，随后业务 HMR 再次严格增加。
- G01-006 PASS：controller `setTask()` 与 packed task-only `complete` 均保持 revision 不变。
- G01-007 PASS：unit child-process 与 packed public CLI 均在状态缺失期间保持运行并在重连更新后返回单一 JSON success；timeout/Status/ambiguity 语义另有断言。
- G01-008 PASS：Page close 保留文件供 freshness 机制处理；Store test 证明超过 24 小时 threshold 会清理，Vite shutdown cleanup 仍通过。
- G01-009 PASS：完整 484-test suite、31-test architecture gate 与 packed Pick/Multi/Area、多 Runtime、Status、Production Exclusion/shutdown paths 无回归。
- Remaining risk：`sessionStorage` 被浏览器策略禁用时按合同降级为不抛错，但无法跨 full reload 保连续性；正常 Chromium packed consumer 已证明主路径。
- 未开始 Goal 02 或 Goal 03；未 push、publish、tag 或 release。
