# Goal 05 — 完善 HostIntegration 与 TaskTransport 方法级边界

## Goal Objective

```text
/goal 让任意第三方 Host 回调故障只禁用自身能力并记录 Diagnostic；让 `mutate` 和 `writeEvidence` 成功结果必须遵守 Task ID 与 Revision 协议。
```

## 单一完成结果

让任意第三方 Host 回调故障只禁用自身能力并记录 Diagnostic；让 `mutate` 和 `writeEvidence` 成功结果必须遵守 Task ID 与 Revision 协议。

## 问题背景

Extension 的多数 Contribution 已隔离，但 Host 的 theme/locale/route/appRoot/navigate/identity 等仍可能直接抛错。Validated Transport 只验证 Schema，错误 Transport 仍可在 mutate 成功时返回另一 Task 或不推进 Revision。

## 前置依赖

- Goal 04 完成并通过。

## 必须先阅读

- `00-shared-contract.md`
- `CURRENT-REVIEW-BASELINE.md`
- 当前 Goal 中列出的相关生产代码与测试
- 实际仓库的 `AGENTS.md`、`package.json` 和当前 HEAD

## 主要修改范围

- `src/extension/index.ts`
- `src/types/index.ts`
- `src/client/runtime/host.ts`
- `src/client/inspection-engine.ts`
- `src/client/runtime/capture.ts`
- `src/client/validated-transport.ts`
- `src/core/transport.ts`
- `src/server/transport.ts`
- Extension、Transport、Runtime 与 E2E 测试

实际文件名可以根据当前 HEAD 调整，但不得创建第二套平行协议或重复实现。

## 实现合同

1. Registry 的 Host 结果必须保留来源 `extensionId`。
2. 建立统一 `createGuardedHostIntegration()` 或等价代理，覆盖 `theme`、`locale`、`pageContext/routeKey`、`appRoot`、`navigate`、`identity`、`messages` 与 `subscribe`。
3. 第三方 Host 回调抛错时记录一次结构化 Extension Diagnostic，并使用安全默认值；核心 Pick/List/Copy 继续工作。
4. `identity()` 对单个元素失败时返回空 identity，不让 Annotation 保存失败。
5. `navigate()` 失败时显示安全状态并记录 Diagnostic。
6. `subscribe()` 注册或 dispose 失败均被隔离；Builtin/Trusted Core 失败可继续 fail-fast。
7. 新增 `TaskTransportProtocolError`，包含 method、expected task id/revision 和实际结果。
8. `read` / `subscribe` 允许新的 Task ID，并使用共同 Task Identity Rule。
9. `mutate` 成功结果必须 taskId 等于 request.taskId，taskRevision 严格大于 expectedRevision。
10. `writeEvidence` 成功结果必须 taskId 等于 input.taskId、Revision 严格推进，且目标 Annotation 仍存在。
11. Conflict Payload 继续允许携带最新 Task Identity，但必须严格 Parse。
12. Runtime 只使用经过 Schema + 方法级协议包装的 Transport。
13. 文档准确区分输入验证、Mutation Redaction、最终持久化和成功响应协议。

## 明确禁止

- 不吞掉 Core/Builtin 的编程错误。
- 不允许错误 Transport 静默替换 Task。
- 不重新暴露原始 Transport 给 Extension。
- 不将 Host 错误字符串未经 Redaction 写入文件。

## 必须新增或更新的测试

- Host 单测：每个回调分别抛错，核心仍可用且 Diagnostic 去重。
- Host E2E：NocoBase 风格 identity 对某个元素抛错，仍可保存普通 Annotation。
- Transport 单测：mutate 返回不同 Task ID、相同 Revision、较小 Revision 均拒绝。
- Transport 单测：writeEvidence 返回错误 Task/删除 Annotation 均拒绝。
- Conflict 与 read/subscribe 新 Task ID 正常工作。

## 验收标准

- **G05-001**：所有 Host 回调都经过统一 guard。
- **G05-002**：Host 错误不导致 Studio Unmount。
- **G05-003**：Transport 成功结果遵守方法级协议。
- **G05-004**：非法成功结果有稳定错误类型。
- **G05-005**：现有 Revision Conflict Retry 无回归。
- **G05-006**：最终安全文档与实际行为一致。

## 验收命令

先运行最小相关测试，修复后执行：

```bash
pnpm exec vitest run tests/extension/registry.test.ts tests/client/runtime.test.ts tests/client/runtime-controllers.test.ts tests/client/validated-transport.test.ts tests/server/transport.test.ts
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
fix(extension): guard host and transport protocols
```

## 完成证据格式

最终回复必须包含：

```text
Goal 05: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Behavioral result:
Commands and exact results:
Acceptance criteria:
  G05-001 PASS/FAIL/BLOCKED — evidence
  ...
Remaining risks:
Commit:
```

## Progress

- [x] 检查实际 HEAD 和工作区：从 `0a59894ff74136d5b6ec4f4429f6652507caee78`、clean tree 开始。
- [x] 建立 AC → 文件 → 测试 → 证据映射：registry/runtime host paths、inspection identity、validated/server transports、packed fixture。
- [x] 实现生产代码：registered host source IDs, one guarded host proxy, method-level transport protocol checks。
- [x] 增加最小回归测试：host callback fault/disposer isolation; mutate ID/revision and evidence target invariants; read/subscribe replacement.
- [x] 运行当前 Goal 完整门禁。
- [x] 独立 Review：final diff reviewed after focused and full gates; `git diff --check` clean.
- [x] 更新 Outcomes。

Gate evidence (final working tree):

- `pnpm exec vitest run tests/extension/registry.test.ts tests/client/runtime.test.ts tests/client/runtime-controllers.test.ts tests/client/validated-transport.test.ts tests/server/transport.test.ts` — PASS, 5 files / 202 tests.
- `pnpm typecheck` — PASS.
- `pnpm test` — PASS, 37 files / 451 tests.
- `pnpm check:architecture` — PASS, 1 file / 29 tests.
- `pnpm check:docs` — PASS.
- `pnpm build` — PASS.
- `pnpm check:package` — PASS (`publint` and `attw`).
- `pnpm check:tarball` — PASS, 26 files / 113609 bytes.
- `pnpm test:e2e` — PASS, 18 Playwright tests plus shutdown coverage from a freshly packed consumer; the vertical flow injected a NocoBase-style `identity()` fault, saved the annotation, rendered two markers, copied the task, and persisted exactly one deduplicated `identity` diagnostic.
- `git diff --check` — PASS.

## Surprises & Discoveries

- Registry validation was invoking `theme()` and `appRoot()` during registration; removing those calls was required for registration fault isolation.
- The existing diagnostics server allowlist did not yet include `pageContext`; adding the already-used runtime phases to the server validator was required for persistence.
- Packed fault injection produced two markers (the original and the new annotation), confirming identity fallback did not suppress normal marker behavior.

## Decision Log

- Keep `getHostIntegration()` as the existing raw inspection/test API, and add `getHostRegistration()` for the runtime guard so the extension ID is never inferred from object identity.
- Use the existing diagnostics controller and deduplication key with a `host` phase and callback method as contribution ID; caught callback error text is replaced with a stable generic message before diagnostics redaction.
- Enforce transport invariants in the shared core helper after strict schema parsing. `mutate` requires the requested task identity and a forward revision; `writeEvidence` additionally requires the requested annotation to remain present. `read`/`subscribe` retain task replacement semantics.
- Keep the runtime's existing mutation Parse → Generic Redaction → Parse sequence unchanged; the validated transport remains the only transport passed to controllers.

## Outcomes & Retrospective

- Goal 05 implementation is complete and ready for its local commit. Host faults now fall back per callback and preserve core Pick/Marker/Copy flows; transport successes cannot silently replace task identity, reuse a revision, or drop the requested annotation/evidence target.
- Acceptance: G05-001 PASS (single guarded host proxy covers every callback and disposer); G05-002 PASS (focused fault tests and packed browser annotation flow remained mounted); G05-003 PASS (shared strict result validators cover custom and HTTP transports); G05-004 PASS (`TaskTransportProtocolError` is exported and asserted); G05-005 PASS (focused conflict-retry test and full suite); G05-006 PASS (API, README, and architecture docs checks).
- No Goal 06 work was started. No push, publish, or tag was performed.
- Residual risk: direct custom transports outside `createValidatedTaskTransport` remain caller-controlled; the runtime always wraps them before use.
