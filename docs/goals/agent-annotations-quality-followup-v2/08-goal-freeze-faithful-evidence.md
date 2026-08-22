# Goal 08 — 让自动 Screenshot 保留标注瞬间的页面状态

## Goal Objective

```text
/goal 在解除 React Grab Freeze 之前固定安全化 DOM Snapshot；随后立即恢复 UI，并在后台完成 SVG 解码、PNG 编码和 Evidence 写入。
```

## 单一完成结果

在解除 React Grab Freeze 之前固定安全化 DOM Snapshot；随后立即恢复 UI，并在后台完成 SVG 解码、PNG 编码和 Evidence 写入。

## 问题背景

当前自动 Evidence 非阻塞是正确的，但保存后先清除选择和 Unfreeze，再 setTimeout 捕获。Hover 菜单、Popover、动画状态可能在截图开始前消失，Evidence 与用户标注时看到的页面不一致。

## 前置依赖

- Goal 07 完成并通过。

## 必须先阅读

- `00-shared-contract.md`
- `CURRENT-REVIEW-BASELINE.md`
- 当前 Goal 中列出的相关生产代码与测试
- 实际仓库的 `AGENTS.md`、`package.json` 和当前 HEAD

## 主要修改范围

- `src/client/screenshot.ts`
- `src/client/runtime/evidence.ts`
- `src/client/runtime/overlays.ts`
- `src/client/runtime/capture.ts`
- `src/client/runtime/mount.ts`
- Screenshot/Evidence/Freeze/packed E2E 测试

实际文件名可以根据当前 HEAD 调整，但不得创建第二套平行协议或重复实现。

## 实现合同

1. 将 Screenshot 拆为两阶段：同步 `prepareViewportSnapshot()` 与异步 `renderPreparedSnapshotPng()`（名称可调整）。
2. Prepare 阶段在 Freeze 仍生效、Composer 清理前执行 DOM Clone、表单清理、媒体替换、样式内联、Scroll/Overlay 固定和序列化。
3. Prepare 成功或失败后立即 Unfreeze、关闭 Composer、显示 Annotation Saved；不等待 Image Decode、Canvas 或 Upload。
4. 异步阶段只处理已经安全化的不可变 Snapshot，不再访问活页面 DOM。
5. Prepare 失败不能回滚 Annotation；记录安全 Diagnostic。
6. Route 或 Task Identity 在异步阶段变化时继续放弃错误 Evidence。
7. Manual 模式可以在用户触发时临时冻结并执行同一两阶段管线；Off 不调用任何 Screenshot 逻辑。
8. 保持表单隐私、媒体占位、2MB Evidence 上限、Revision Conflict Retry。
9. Snapshot 数据必须有大小上限；过大时失败关闭而非截断成无效 SVG。

## 明确禁止

- 不恢复阻塞到 PNG Upload 完成才显示保存成功。
- 不在 Unfreeze 后重新 Clone 页面。
- 不引入未经审查的整页 Screenshot 依赖。
- 不捕获原始图片、Canvas 内容或表单值。

## 必须新增或更新的测试

- 单元测试：Prepare 在 Unfreeze 前被调用，异步 Render 在后。
- 单元测试：Prepare 后页面 DOM 改变不影响 Prepared Snapshot。
- 单元测试：Prepare 失败保存仍成功并记录 Diagnostic。
- E2E：Hover 菜单或临时 Popover 保存后消失，但 Screenshot 中仍存在。
- E2E：保存 UI 不等待延迟 5 秒的 Image Decode。
- E2E：scroll、scale、overlay 坐标继续正确。

## 验收标准

- **G08-001**：自动 Evidence 反映用户标注瞬间。
- **G08-002**：保存不等待 PNG 编码或上传。
- **G08-003**：异步阶段不读取活 DOM。
- **G08-004**：隐私边界无回归。
- **G08-005**：Manual/Off 模式语义清晰。
- **G08-006**：路由和 Task 变化不会把旧 Screenshot 写入新任务。

## 验收命令

先运行最小相关测试，修复后执行：

```bash
pnpm exec vitest run tests/client/screenshot.test.ts tests/client/freeze.test.ts tests/client/runtime-controllers.test.ts tests/client/runtime.test.ts tests/server/evidence.test.ts
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
fix(evidence): snapshot frozen annotation state
```

## 完成证据格式

最终回复必须包含：

```text
Goal 08: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Behavioral result:
Commands and exact results:
Acceptance criteria:
  G08-001 PASS/FAIL/BLOCKED — evidence
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
