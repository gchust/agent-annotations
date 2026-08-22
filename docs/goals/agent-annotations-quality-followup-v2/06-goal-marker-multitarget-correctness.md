# Goal 06 — 修复 Marker 多目标、iframe 与动态页面刷新

## Goal Objective

```text
/goal 让一条 Multi/Region Annotation 的所有 Target 在 iframe、Shadow Root、滚动、Resize 和 DOM Mutation 后都获得一致的解析、Highlight 与 Summary。
```

## 单一完成结果

让一条 Multi/Region Annotation 的所有 Target 在 iframe、Shadow Root、滚动、Resize 和 DOM Mutation 后都获得一致的解析、Highlight 与 Summary。

## 问题背景

当前 iframe 未解析检测只检查第一个 Target。Marker、Summary 与 Highlight 多次独立解析，动态变化后可能不同步；Highlight 位置也可能停留在旧 Bounds。

## 前置依赖

- Goal 05 完成并通过。

## 必须先阅读

- `00-shared-contract.md`
- `CURRENT-REVIEW-BASELINE.md`
- 当前 Goal 中列出的相关生产代码与测试
- 实际仓库的 `AGENTS.md`、`package.json` 和当前 HEAD

## 主要修改范围

- `src/client/runtime/markers.ts`
- `src/client/runtime/overlays.ts`
- `src/client/runtime/mount.ts`
- `src/client/inspection-engine.ts`
- `src/types/index.ts`
- Marker/iframe/region/runtime E2E 与性能测试

实际文件名可以根据当前 HEAD 调整，但不得创建第二套平行协议或重复实现。

## 实现合同

1. 为一次 Marker Refresh 建立 per-annotation Resolution Snapshot；Marker Anchor、Summary、Highlight 与 iframe tracking 复用同一解析结果。
2. `hasUnresolvedFrameTarget` 遍历所有 Targets，不只第一个。
3. 一条 Annotation 的第一个可解析 Target 继续作为 Marker Anchor；其他可解析 Target 用于 Highlight 和 Summary。
4. Highlight 在 scroll、resize、Mutation、iframe load 和 target resize 后重新定位。
5. Resolution Summary 变化时触发一次 UI Snapshot 更新，使 List 与 Tooltip 同步。
6. 对 iframe 中动态创建的 Target 安装必要的 Mutation/Load 监听；cross-origin 保持 unsupported。
7. Region Target 与 Multi Target 使用相同解析合同。
8. 避免单次刷新对同一 Target 重复执行多次 `resolvePersistedTarget()`。
9. Observer 只在当前 Route、Open Annotation、Visible Marker、Editor 或 Composer 需要时启用。
10. 保留精确 Selector + Identity；不添加模糊 fallback。

## 明确禁止

- 不把所有 DOM Mutation 都转成同步完整 Render。
- 不扫描全 DOM。
- 不因后续 Target unresolved 隐藏可用 Marker。
- 不更改 Task Schema。

## 必须新增或更新的测试

- 单元测试：第一目标主文档、第二目标 iframe 动态出现。
- 单元测试：所有 Target 都参与 unresolved frame 检测。
- 单元测试：一次 Refresh 每 Target 只解析一次。
- E2E：Multi Annotation 跨主页面与 same-origin iframe；动态 load 后 Summary 从 1/2 变 2/2。
- E2E：滚动和 Resize 后所有 Highlight 对齐。
- E2E：第二 Target 在 iframe 内，Marker Tracking 正确安装和清理。

## 验收标准

- **G06-001**：Multi/Region 所有 Target 都被追踪。
- **G06-002**：Marker Anchor、Highlight 与 Summary 使用同一解析快照。
- **G06-003**：动态 iframe Target 可恢复。
- **G06-004**：Cross-origin 明确 unsupported。
- **G06-005**：滚动/Resize 后 Highlight 无漂移。
- **G06-006**：Observer 生命周期无泄漏。
- **G06-007**：现有 Marker Identity 安全无回归。

## 验收命令

先运行最小相关测试，修复后执行：

```bash
pnpm exec vitest run tests/client/inspection.test.ts tests/client/selector-locator.test.ts tests/client/runtime-controllers.test.ts tests/client/runtime.test.ts
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
fix(markers): synchronize all annotation targets
```

## 完成证据格式

最终回复必须包含：

```text
Goal 06: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Behavioral result:
Commands and exact results:
Acceptance criteria:
  G06-001 PASS/FAIL/BLOCKED — evidence
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
