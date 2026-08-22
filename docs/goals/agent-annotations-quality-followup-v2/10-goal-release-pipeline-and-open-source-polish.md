# Goal 10 — 收口发布流水线、远程 CI、版本与测试结构

## Goal Objective

```text
/goal 让一次 Build 产生一个精确候选 tarball，所有 package/tarball/consumer/E2E 证据复用该制品；补齐 Windows 关键测试并收口公开仓库文档。
```

## 单一完成结果

让一次 Build 产生一个精确候选 tarball，所有 package/tarball/consumer/E2E 证据复用该制品；补齐 Windows 关键测试并收口公开仓库文档。

## 问题背景

当前门禁会多次 Build/Pack，Release Evidence 需要区分临时制品与候选制品。远程 CI 尚未跑当前候选，Windows Job 未覆盖 File Lock、Store、Diagnostics、Evidence 和 CLI Path。版本与 Changelog 也未完全收口，综合 Runtime 测试仍约 258KB。

## 前置依赖

- Goal 09 完成并通过。

## 必须先阅读

- `00-shared-contract.md`
- `CURRENT-REVIEW-BASELINE.md`
- 当前 Goal 中列出的相关生产代码与测试
- 实际仓库的 `AGENTS.md`、`package.json` 和当前 HEAD

## 主要修改范围

- `package.json`
- `scripts/release-*.mjs`、`packed-e2e.mjs`、tarball/package audit scripts
- `.github/workflows/ci.yml`
- `tests/client/runtime.test.ts` 与模块化测试
- `CHANGELOG.md`、`README.md`、`MIGRATION-BASELINE.md`
- Release/Package/Docs 测试

实际文件名可以根据当前 HEAD 调整，但不得创建第二套平行协议或重复实现。

## 实现合同

1. 建立单一 Release Candidate Orchestrator：Build 一次、Pack 一次，输出 tarball 路径、SHA256、大小和文件清单。
2. `publint`、`attw`、tarball audit、core consumer、browser consumer 和重复 E2E 必须检查同一个 tarball。
3. 普通 `pnpm test:e2e` 可保留开发便捷 Pack；`release:verify` 必须使用 exact tarball 模式。
4. 失败时保留 consumer 与日志；成功时可清理。
5. CI Release Job 运行完整 exact-tarball `release:verify`。
6. Windows Node 20/24 至少运行 File Lock、FileTaskStore、DiagnosticsStore、Evidence、Source Path、CLI Path/Vite Path 测试。
7. 把 `tests/client/runtime.test.ts` 按 Controller/职责拆分；保留一个小型 integration 文件。
8. Architecture Audit 继续验证 Runtime 无环、单 React Root 和层级边界。
9. 查询 npm registry：若 `0.1.0-alpha.0` 从未发布，保留该版本并把全部实际内容归入一个正式条目；若已发布，升级 `0.1.0-alpha.1`。
10. 增加 `publishConfig.access = public`。
11. 将 `MIGRATION-BASELINE.md` 移入 `docs/historical/` 或删除；根目录只留公开用户需要的文件。
12. 更新 Changelog、README、API、Architecture 和 Security，移除已过期中间态。
13. 不在本 Goal 发布 npm。

## 明确禁止

- 不让 Release Evidence 引用多个不同 tarball。
- 不通过 Playwright retries 掩盖失败。
- 不把远程 CI 未运行写成 PASS。
- 不为拆测试改变生产行为。

## 必须新增或更新的测试

- Release script 单测：所有后续步骤收到同一 tarball path/hash。
- Failure test：任一 consumer/E2E 失败，release 命令非零且保留制品。
- Windows 路径和 File Lock 测试可在 Windows runner 运行。
- Docs smoke 检查版本、旧 Wait Flags、旧 Browser State、MCP、NocoBase 和根目录历史文件。
- 五次 E2E 使用一个安装完成的 exact tarball consumer，每次重置 runtime data，不 reinstall/repack。

## 验收标准

- **G10-001**：Release 只生成一个候选 tarball。
- **G10-002**：所有门禁复用同一 SHA256。
- **G10-003**：Windows 关键文件系统测试进入 CI。
- **G10-004**：Runtime 测试按模块拆分且覆盖不下降。
- **G10-005**：版本和 Changelog 与 registry 事实一致。
- **G10-006**：`publishConfig.access=public`。
- **G10-007**：公开仓库根目录收口。
- **G10-008**：当前 Workflow 可在 push 后完整运行。

## 验收命令

先运行最小相关测试，修复后执行：

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
pnpm release:verify
```
```bash
pnpm test:e2e:repeat
```

任何命令失败都不能标记 Goal 完成。

## 建议 Conventional Commit

```text
chore(release): unify candidate verification
```

## 完成证据格式

最终回复必须包含：

```text
Goal 10: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Behavioral result:
Commands and exact results:
Acceptance criteria:
  G10-001 PASS/FAIL/BLOCKED — evidence
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
