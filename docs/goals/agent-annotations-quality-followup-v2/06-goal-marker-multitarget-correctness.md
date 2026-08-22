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

- [x] 2026-08-22：确认起始 HEAD 为 `5b1384a39c7a92f062e97a4b656574b723f8c629`，工作区起始干净。
- [x] 2026-08-22：建立 G06-001～G06-007 到 Marker Controller、Overlay、Mount、unit/E2E 的证据映射。
- [x] 2026-08-22：实现 per-annotation Resolution Snapshot，并统一 Anchor、Summary、Highlight、Tooltip/List 与 Observer 的刷新输入。
- [x] 2026-08-22：增加多目标动态 iframe、open Shadow Root、单次解析缓存、scroll/resize Highlight 和 packed browser 回归测试。
- [x] 2026-08-22：运行 focused、typecheck、full test、architecture、build、docs、package、tarball、packed E2E 与 diff-check 全部门禁。
- [x] 2026-08-22：独立 Review 最终 diff；修复 live Tooltip、零 resolved marker tracking、Shadow Root app-root membership 三个边界后重跑门禁。
- [x] 2026-08-22：更新 Outcomes 与逐条验收证据。

## Surprises & Discoveries

- Packed browser 首次运行准确暴露测试 locator 歧义：List 打开后 Marker 与 List Item 都有 `data-annotation-id`；限定 `.aa-marker` 后，真实 `1/2 → 2/2` 行为通过。
- Hover 在页面滚动后会自然离开 Marker 并清除 Highlight；真实位置验证改用 keyboard focus，持续覆盖 scroll/resize 后两个 Highlight 的 bounds 对齐。
- 独立 Review 发现 open Shadow Root 内元素虽然可被精确 Selector 解析，但旧 `isInAppRoot()` 不会从 Shadow Root 回走到 host；共享 membership walk 修复后，动态 Shadow Target 可恢复。
- 最终 packed reliability suite 的动态 DOM 压测记录 `markerRefreshes10s=13`，保持 rAF bounded，隐藏 Marker 后 Observer 停止。

## Decision Log

- 2026-08-22：保留 `resolvePersistedTarget()` 作为唯一 Selector + Identity 校验路径；不增加 fuzzy fallback 或第二套 resolver。
- 2026-08-22：Snapshot 以 Annotation ID 缓存并在每次 full render/Marker refresh 开始时清空；同一 generation 内 Anchor、Summary、Highlight 与 unresolved tracking 复用同一 TargetResolution。
- 2026-08-22：Realm tracking 只遍历当前 Route 的 Open Annotation 中已持久化的 `>>iframe>>` / `>>>` selector boundary；不扫描全 DOM。
- 2026-08-22：Summary 变化只触发一次 UI snapshot emit，同时直接刷新已显示的 Marker tooltip/editor 文本；不把每次 Mutation 转为同步 full render。
- 2026-08-22：Observer 仅在 visible current-route Marker、Editor 或 element Composer 需要时存在；所有 Mutation/Resize/frame-load 回调继续通过现有 rAF coalescing。

## Outcomes & Retrospective

- 行为结果：Multi/Region 的所有 Target 现在由一个 resolution snapshot 驱动；第一个可解析 Target 仍是 Anchor，全部可解析 Target 同步进入 Summary、Highlight、Resize/Mutation/realm tracking。
- G06-001 PASS：unit Multi recovery 与 packed cross-frame Multi E2E 验证主文档和 iframe 两个 Target 都被追踪。
- G06-002 PASS：controller cache test 验证重复读取 snapshot/iframe health 不重复执行 identity resolution；Overlay/Marker/Editor/List 均消费该 snapshot。
- G06-003 PASS：unit nested iframe 与 packed browser 均验证第二 Target 动态移除后 `1/2`、重新加入后 `2/2`。
- G06-004 PASS：现有 selector-locator/inspection cross-origin unsupported 测试及 packed cross-origin case 均通过。
- G06-005 PASS：unit scroll/resize bounds 与 packed Chromium 两个 Target/Highlight 几何比较均通过。
- G06-006 PASS：packed Chromium 隐藏 Marker 后 500ms 内 refresh count 不再变化；runtime teardown tests 通过。
- G06-007 PASS：focused inspection/selector tests、完整 453 tests 与 exact identity controller regression 均通过。
- 精确门禁：`pnpm exec vitest run tests/client/inspection.test.ts tests/client/selector-locator.test.ts tests/client/runtime-controllers.test.ts tests/client/runtime.test.ts` → 4 files、185 tests PASS；`pnpm typecheck` → PASS；`pnpm test` → 37 files、453 tests PASS；`pnpm check:architecture` → 29 tests PASS；`pnpm build` → PASS；`pnpm check:docs` → docs smoke PASS；`pnpm check:package` → publint/attw PASS；`pnpm check:tarball` → PASS（26 files、114352 bytes）；`pnpm test:e2e` → 8 sequential Playwright suites、19 tests PASS；`git diff --check` → PASS。
- Remaining risks：关闭的 Shadow Root 仍按合同明确 unsupported；未增加模糊重绑、Task Schema、CLI status/handoff 或 Goal 07 范围改动。
- Goal 07 未开始；未执行 push、publish 或 tag。
