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

- [x] 2026-08-22：从 clean HEAD `91d6e9017fd62f934ad7c5508f6bb8cdd3491833` 检查工作区、Goal 合同、全部 pack/build/consumer/E2E caller、CI、公开文档和 runtime 测试结构。
- [x] 建立 G10-001～G10-008 到 release orchestrator、exact-mode scripts、CI、测试拆分、package/docs smoke 和 packed browser evidence 的映射。
- [x] 实现单候选 release orchestrator、exact tarball audits/consumers、同 consumer repeat gate、Windows matrix、发布元数据和公开仓库清理。
- [x] 增加 release path/hash 传播与 browser-consumer failure artifact 保留测试；将 271401-byte runtime suite 按职责拆分并保留小型 integration 文件。
- [x] 运行全部 Goal 10 门禁，包括一个 SHA-256 的 packed browser consumer 和五次不重装/不 repack 的 repeat E2E。
- [x] 独立复查最终 diff、failure path、tarball metadata/logs、测试数量、文档禁项和 git cleanliness。
- [x] 更新 Outcomes；远程 CI 明确留给 Goal 11，未宣称已运行。

## Surprises & Discoveries

- `pnpm test` 的 release consumer tests 会自行 pack，用它作为单候选 orchestrator 内部测试会制造额外 tarball；因此 release path 使用 `test:release` 排除三个专门验证独立 pack 生命周期的测试，而验收仍单独实际运行完整 `pnpm test`（42 files / 478 tests）。
- 机械拆分暴露了原单文件测试对前序 `history` 路由的隐式依赖；为每个需要 `/settings` 的用例显式设置路由，并在各拆分文件 afterEach 恢复 `/`，没有修改生产行为。
- packed status coverage 故意制造一次 Vite syntax-error HMR 并恢复；日志中的 parser error 是测试输入，最终 Playwright suite 和 repeat run 均 PASS。
- 首次最终 `release:verify` 暴露了拆分后 evidence suite 的异步断言竞争：完整 suite 中渲染 Promise 可能尚未启动。断言改为等待既有异步边界后，该 suite 连续 5 次（每次 39 tests）、完整 suite 和 release suite 均通过；生产代码未改变。
- 本地 release candidate 是 `32d4c33b2e3abc3a54fb8715ced90dff1ba7db047ee7f258510b1dfb5ff3a759`、117244 bytes、26 files。用户提供的 2026-08-22 registry E404 证据支持保留 `0.1.0-alpha.0`；本 Goal 未重新查询或发布 registry。

## Decision Log

- 使用一个 `scripts/release-candidate.mjs` 共享候选常量、SHA 校验、步骤清单和 metadata loading；`release-verify.mjs` 仅负责编排，现有 audit/consumer scripts 增加 exact 参数/环境模式，不建立第二套发布框架。
- candidate 固定保存在 ignored `artifacts/release-candidate/`。成功也保留 metadata、manifest、tarball、两个 consumer 和每步日志，使后续 `test:e2e:repeat` 能复用相同安装；任一步失败同样不清理。
- 普通 `pnpm test:e2e` 保留原 build/pack/fresh-consumer 便利路径；仅 candidate mode 禁止 build/pack/reinstall。Repeat 每轮只删除 `.agent-annotations`，Playwright 原配置继续负责每个 server 的 runtime reset。
- `pnpm pack --config.ignore-scripts=true` 在 orchestrator 的唯一显式 build 后执行，避免 `prepack` 再 build；publint、ATTW、tarball audit、Node 20/24 smoke 和 browser consumer 都接收同一路径与 SHA。
- 按真实职责拆为 `runtime-markers-capture`、`runtime-diagnostics-extensions`、`runtime-evidence-status`、`runtime-host-ui`，`runtime.test.ts` 仅保留跨 controller integration；不抽生产 controller framework。
- 远程 workflow 只改为 ready：Windows Node 20/24 加入指定 filesystem/Vite/CLI tests，release job 顺序执行 exact `release:verify` 和 repeat。当前远程 CI 未运行，不能作为 G10-008 的当前运行证据。

## Outcomes & Retrospective

- G10-001 PASS：`release:verify` 输出一次 build、一次 pack 和一个 candidate metadata；release test 验证固定九步清单，pack lifecycle tests 不在 orchestrator 内重复执行。
- G10-002 PASS：publint、ATTW、tarball audit、Node 20/24 core/CLI smoke、首次 packed browser 和 5 次 repeat 均使用 SHA-256 `32d4c33b2e3abc3a54fb8715ced90dff1ba7db047ee7f258510b1dfb5ff3a759`；repeat 未 install 或 pack。
- G10-003 PASS：Windows Node 20/24 workflow 包含 store/file-lock、diagnostics、evidence、source-path、Vite、CLI arguments/paths tests。此为 workflow source 证据，不是远程 CI 运行结果。
- G10-004 PASS：原 `runtime.test.ts` 5955 lines / 271401 bytes 变为 269 lines / 9859 bytes integration，加四个职责 suite；focused 6 files / 177 tests 和完整 42 files / 478 tests PASS，覆盖数未下降。
- G10-005 PASS：版本保持 `0.1.0-alpha.0`，Changelog 合并为单个 `2026-08-22` 条目；依据用户提供的 registry E404，不声称本地重新查询。
- G10-006 PASS：`publishConfig.access` 为 `public`，docs smoke 强制验证。
- G10-007 PASS：migration baseline 移至 `docs/historical/migration-baseline.md`；README/API/architecture/security/contributing 更新单候选合同，docs smoke 验证根文件缺失、版本、旧 wait flags、旧 Browser State、依赖耦合与公开 exports。
- G10-008 PASS（workflow ready）：release job 可执行 exact candidate gate 后复用 consumer 的 repeat gate；remote CI `NOT RUN`，实际 candidate SHA 的远程矩阵属于 Goal 11。
- Failure path PASS：`tests/release/release-candidate.test.ts` 注入 browser-consumer exit 7，命令抛错且 tarball 与逐步日志保留；现有 packed failure test 继续证明单个 Playwright failure 非零且保留 consumer。
- 完整本地门禁：`pnpm typecheck` PASS；`pnpm test` PASS（42 files / 478 tests）；`pnpm check:architecture` PASS（31 tests）；`pnpm check:docs` PASS；`pnpm build` PASS；`pnpm check:package` PASS；`pnpm check:tarball` PASS（26 files / 117244 bytes）；`pnpm release:verify` PASS（39 non-repacking files / 470 tests、publint/ATTW、26-file tarball audit、Node 20/24、packed 19 browser tests）；`pnpm test:e2e:repeat` PASS（同 consumer 5×19 tests）；evidence suite 在竞争修复后连续 5×39 tests PASS；`git diff --check` PASS。
- 未解决风险：当前 workflow 的 Ubuntu/Windows Node 20/24 与 release job 远程执行仍未发生；Goal 10 只证明 workflow source 和本地 Linux/Chromium，Goal 11 才能记录远程 CI。
