# Goal 02 — 修正 Revision 覆盖范围与 CLI 等待语义

## Goal Objective

```text
/goal 让 CSS、主题和配置等真实 HMR 通过 Browser Update Revision 验证；让引用源码 Revision 只表示已知文件，空集合返回 `null`；删除语义含混的旧 Wait 选项。
```

## 单一完成结果

让 CSS、主题和配置等真实 HMR 通过 Browser Update Revision 验证；让引用源码 Revision 只表示已知文件，空集合返回 `null`；删除语义含混的旧 Wait 选项。

## 问题背景

当前 `sourceRevision` 只 Hash Annotation Source Stack 中的文件。CSS 等依赖修改可能已经被浏览器应用但 Hash 不变；无可解析 Source 时又会生成空输入 SHA。现有 `--browser-source-revision` 混合了“浏览器更新 generation”和“引用源码 hash”两个概念。

## 前置依赖

- Goal 01 完成并通过。

## 必须先阅读

- `00-shared-contract.md`
- `CURRENT-REVIEW-BASELINE.md`
- 当前 Goal 中列出的相关生产代码与测试
- 实际仓库的 `AGENTS.md`、`package.json` 和当前 HEAD

## 主要修改范围

- `src/server/source-path.ts`
- `src/server/browser-state.ts`
- `src/cli/index.ts` 与 CLI 参数解析
- `src/core/handoff.ts`
- `src/client/runtime/mount.ts`
- `src/vite/index.ts`
- README/API/CHANGELOG 与 CLI/E2E 测试

实际文件名可以根据当前 HEAD 调整，但不得创建第二套平行协议或重复实现。

## 实现合同

1. `createSourcePathService.revision(task)` 在 Source File 集合为空时返回 `null`，不得返回 SHA256(empty)。
2. 公开字段统一使用 `referencedSourceRevision` 和 `referencedSourceFiles`，不再使用含混的 `sourceRevision/sourceFiles`。
3. CLI `revision` 输出 `taskRevision`、`referencedSourceRevision`、`referencedSourceFiles`；JSON 与人类输出一致。
4. 破坏性移除 `wait --source-revision` 和 `wait --browser-source-revision`，不保留别名。
5. 新增 `wait --browser-update-revision <integer>`：选择的 Browser Runtime 的 generation 大于 baseline 即成功。
6. 新增 `wait --referenced-source-revision <sha256>`：只监控已知引用文件；当前 Revision 为 null 时返回稳定的不可用结果，不伪造 SHA。
7. `status` 同时报告 Browser Update、磁盘 Referenced Revision 和 Browser Reported Referenced Revision。
8. 当引用文件为空时，`referencedSourceSynchronized` 为 `null`；它不得让健康检查失败，但必须清晰显示不可用。
9. Handoff 的主验证 Baseline 使用 `browserUpdateRevision`；Referenced Source Revision 仅作为补充证据。
10. CSS、主题、Locale 或配置模块的成功 HMR 必须推进 Browser Update Revision，即使 Referenced Source Revision 不变。
11. 更新所有文档、Help、测试和架构审计，禁止旧选项重新出现。

## 明确禁止

- 不自动扩展到整个 Vite Module Graph Hash。
- 不把所有项目文件加入 Revision。
- 不保留旧 CLI Flag 兼容别名。
- 不把 null 转成全零或空输入 SHA。

## 必须新增或更新的测试

- Source Path 单测：空文件集合返回 null。
- CLI 单测：旧 Wait Flags 返回 usage error 2。
- CLI 单测：新两个 Wait Mode 严格校验参数并使用不同数据源。
- E2E：只修改 CSS 文件，DOM 样式真实变化，Browser Update Wait 成功，Referenced Source Revision 可保持不变。
- E2E：无 Source Annotation 时 Handoff 写出 `referenced source revision unavailable`。
- E2E：TSX 修改同时推进 Browser Update，且引用 Hash 最终同步。

## 验收标准

- **G02-001**：空 Source 集合不生成 SHA。
- **G02-002**：CSS-only HMR 可被 Browser Update Wait 可靠观察。
- **G02-003**：旧 Wait 选项物理移除。
- **G02-004**：两个新 Wait 选项语义和输出清晰。
- **G02-005**：Handoff 不再依赖组件 Hash 才能验证页面更新。
- **G02-006**：`status --check` 对 null Referenced Revision 有明确且非误导性行为。
- **G02-007**：README、API、Help、CHANGELOG 不含旧命令。
- **G02-008**：Packed Consumer 真实执行两个新 Wait Mode。

## 验收命令

先运行最小相关测试，修复后执行：

```bash
pnpm exec vitest run tests/server/source-path.test.ts tests/cli/cli.test.ts tests/core/handoff.test.ts tests/server/browser-state.test.ts tests/server/vite.test.ts
```
```bash
pnpm typecheck
```
```bash
pnpm test
```
```bash
pnpm check:docs
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
feat(cli): separate browser updates from source revisions
```

## 完成证据格式

最终回复必须包含：

```text
Goal 02: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Behavioral result:
Commands and exact results:
Acceptance criteria:
  G02-001 PASS/FAIL/BLOCKED — evidence
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
