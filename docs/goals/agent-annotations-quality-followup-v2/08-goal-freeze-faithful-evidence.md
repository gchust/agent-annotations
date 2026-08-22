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

- [x] 2026-08-22：确认 clean HEAD `60feecd4959826b4e4cccaeb8cf8b28c2d93d1d0`，并追踪 Screenshot、Evidence、Freeze、Overlay 和 packed fixture 的实际调用链。
- [x] 2026-08-22：建立 AC → `screenshot.ts` / `runtime/evidence.ts` / `runtime/overlays.ts` → unit / packed browser 证据映射。
- [x] 2026-08-22：把现有 Screenshot 管线拆成同步安全化 Prepare 与异步 Render，自动保存改为 Unfreeze 前 Prepare，Manual 复用同一管线。
- [x] 2026-08-22：增加 Prepare 顺序、DOM 隔离、失败非回滚、Manual/Off、大小上限及 packed popover/5 秒 decode 回归测试。
- [x] 2026-08-22：运行 Goal 08 focused、typecheck、full test、architecture、build、docs、package、tarball 和 packed E2E 门禁，全部通过。
- [x] 2026-08-22：逐文件独立检查最终 diff、`git diff --check`、范围和隐私边界；未发现遗漏。
- [x] 2026-08-22：更新 Outcomes 和逐条 AC 证据。

## Surprises & Discoveries

- 根因比预期更集中：旧 `scheduleScreenshotEvidence()` 把 DOM Clone 本身放进 `setTimeout(0)`；保存路径在调度前已执行 `clearTransientSelection()` 和 Unfreeze，因此无需修改 Freeze 引擎即可修复。
- 浏览器 `Image` load/decode 是实际的慢边界。packed fixture 注入 5 秒 decode 延迟后，保存状态仍在 2 秒断言内出现，Evidence 在 decode 完成后写入（实测 `decodeDurationMs=5002`）。
- Prepared SVG 必须单独限制大小；仅依赖服务器 2 MB PNG 限制会让过大的序列化 DOM 进入异步解码。新 2 MB UTF-8 上限在 Prepare 阶段 fail closed。

## Decision Log

- 2026-08-22：保留现有 `captureViewportPng()` 作为两阶段函数的薄组合，避免第二条 Screenshot 管线并保留现有内部测试调用方式。
- 2026-08-22：Prepared Snapshot 仅包含序列化 SVG、输出尺寸、scale、复制并 freeze 的 overlays 和起始时间；异步 Render 不再 Clone 或读取活页面内容。
- 2026-08-22：Image load 后显式等待现有浏览器 `decode()`，并把后台 watchdog 设为 10 秒，使要求的 5 秒 decode 场景可完成且仍有严格上限；保存 UI 不等待该边界。
- 2026-08-22：自动 Prepare 失败沿用 `record("console", ...)` 安全 Diagnostic，仍立即清理 Composer 并显示保存成功；不回滚已持久化 Annotation。
- 2026-08-22：Manual capture 对已解析目标临时调用现有 `setInspectionFrozen(true/false)`，在 `finally` 中立即 Unfreeze，然后才等待 Render/Upload；Off 模式不调用任何阶段。
- 2026-08-22：不新增依赖、兼容层、截图协议或独立 Evidence 写入路径；Route/Task guard 和单次 Revision Conflict retry 保持在现有 Evidence Controller。

## Outcomes & Retrospective

- 行为结果：自动 Evidence 在 Freeze 与 Composer 仍存在时同步固定安全化页面状态，UI 随即恢复；SVG decode、Canvas/PNG 和上传继续在 tracked timer 后台执行。Manual 复用同一 Prepare/Render，Off 完全跳过。
- G08-001 PASS：packed Chromium 在 popover 保存后隐藏的情况下，PNG 像素采样为 `[234,213,101]`，证明保存瞬间的黄色 popover 被保留。
- G08-002 PASS：packed Chromium 注入 5 秒 decode，`Annotation saved` 在 2 秒上限内可见且 decode 实测 5002 ms；unit test 也在 Render promise 未完成时确认 Annotation 已持久化、Composer 已关闭。
- G08-003 PASS：`renderPreparedSnapshotPng()` 只消费 immutable Prepared Snapshot；unit test 在 Prepare 后把活 DOM `Before` 改成 `After`，Render 数据仍只包含 `Before`。
- G08-004 PASS：原有 form/contenteditable 清理、媒体 placeholder、scroll/scale/overlay 测试全部通过；packed privacy 像素保持 `input=[220,40,40]`、`password=[40,180,40]`、`textarea=[40,40,220]`、`editable=[220,180,40]`。
- G08-005 PASS：unit test 证明 Manual 先 Freeze、Prepare、finally Unfreeze 后 Render；Off 模式 Prepare/Render 均为 0 次。
- G08-006 PASS：既有 route/task replacement、unmount、conflict retry 测试在两阶段管线下通过，旧 Screenshot 不写入新 route/task。
- 精确门禁：focused Vitest `5 files / 182 tests passed`；`pnpm typecheck` PASS；`pnpm test` `37 files / 459 tests passed`；architecture `1 file / 29 tests passed`；`pnpm build` PASS；docs smoke PASS；publint/ATTW PASS；tarball audit PASS（26 files，116743 bytes）；packed E2E PASS（20 tests，含 reliability 9/9）；`git diff --check` PASS。
- 剩余风险：Screenshot 仍是既有 best-effort SVG `foreignObject` 渲染，浏览器不支持或超出 2 MB Prepared Snapshot 时会安全失败并记录 Diagnostic，不影响 Annotation 保存。
