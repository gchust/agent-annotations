# Goal 04 — 让多标签页拥有独立 Browser Runtime 状态

## Goal Objective

```text
/goal 用 per-runtime Browser State 取代单文件 Last Writer Wins；CLI 在多 Runtime 时必须确定选择或明确报歧义。
```

## 单一完成结果

用 per-runtime Browser State 取代单文件 Last Writer Wins；CLI 在多 Runtime 时必须确定选择或明确报歧义。

## 问题背景

当前所有标签页写入同一个 `browser-state.json`。两个页面会互相覆盖 route、task 和 update revision，CLI 可能等待或验证错误标签页。

## 前置依赖

- Goal 03 完成并通过。

## 必须先阅读

- `00-shared-contract.md`
- `CURRENT-REVIEW-BASELINE.md`
- 当前 Goal 中列出的相关生产代码与测试
- 实际仓库的 `AGENTS.md`、`package.json` 和当前 HEAD

## 主要修改范围

- `src/server/browser-state.ts`
- `src/vite/index.ts`
- `src/client/runtime/mount.ts`
- `src/cli/index.ts` 与参数解析
- `src/core/handoff.ts`
- `src/types/index.ts`
- Status/Wait/Handoff/Browser State E2E 与文档

实际文件名可以根据当前 HEAD 调整，但不得创建第二套平行协议或重复实现。

## 实现合同

1. Browser State 存储改为 `<runtimeRoot>/browser-states/<runtimeId>.json`。
2. 每个 Runtime 只能更新自己的文件；Shutdown/Unmount 只删除自己的状态。
3. 读取 API 返回所有通过严格 Parser 的状态，并安全忽略/清理过期或非法文件。
4. 定义固定新鲜度和更长的垃圾清理阈值；不得删除仍新鲜的其他 Runtime。
5. CLI `status`、`wait` 新增 `--runtime <runtimeId>` 和 `--route <routeKey>`，两者互斥。
6. 无 selector 且恰好一个新鲜 Runtime 时自动选择；零个时报告 disconnected；多个时报告 `ambiguous_browser_runtime`。
7. `status --json` 必须返回 `runtimes` 摘要和 `selectedRuntimeId`。
8. `status --check` 在 Runtime 歧义时退出 1。
9. `wait` 在 Runtime 歧义时必须失败，不得选最后写入者。
10. 浏览器生成 Handoff 时加入自己的 `runtimeId` 和安全 Route，并在命令中带 `--runtime`。
11. Server 对 Runtime ID、文件名和目录边界执行严格校验。
12. 不再维护单文件 `browser-state.json`；旧文件安全忽略或移除，不迁移。

## 明确禁止

- 不使用文件 mtime 直接选择“最后一个”作为默认。
- 不让两个 Runtime 写同一状态文件。
- 不在 Browser State 中保存 Token。
- 不保留 v1 单文件兼容。

## 必须新增或更新的测试

- Browser State Store 单测：并行写两个 Runtime 不互相覆盖。
- CLI 单测：一个、零个、多个 Runtime 的选择规则。
- CLI 单测：`--runtime`、`--route`、歧义和不存在 Runtime。
- E2E：同时打开 `/customers` 与 `/orders` 两个 Page，两个状态稳定存在。
- E2E：对 `/customers` 的 Wait 不能被 `/orders` HMR 满足。
- E2E：关闭一个 Page 只移除自己的状态。

## 验收标准

- **G04-001**：多标签页状态互不覆盖。
- **G04-002**：CLI 默认选择规则确定且可解释。
- **G04-003**：多 Runtime 歧义不能伪装健康。
- **G04-004**：Handoff 命令锁定发起标注的 Runtime。
- **G04-005**：Wait 不会被其他 Runtime 的 HMR 误触发。
- **G04-006**：旧单文件 Browser State 已删除。
- **G04-007**：路径与文件名不可逃逸。

## 验收命令

先运行最小相关测试，修复后执行：

```bash
pnpm exec vitest run tests/server/browser-state.test.ts tests/cli/cli.test.ts tests/server/vite.test.ts
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
feat(runtime): isolate browser states per runtime
```

## 完成证据格式

最终回复必须包含：

```text
Goal 04: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Behavioral result:
Commands and exact results:
Acceptance criteria:
  G04-001 PASS/FAIL/BLOCKED — evidence
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
