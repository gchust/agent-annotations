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

- [x] 检查实际 HEAD 和工作区：从 clean `2d7cb914ab936850acd53c07b955fb339d4849f4` 开始。
- [x] 建立 AC → 文件 → 测试 → 证据映射：Store/路径（G04-001/006/007）、CLI Selector（G04-002/003/005）、Handoff（G04-004）、Packed Browser Lifecycle（G04-001/005）。
- [x] 实现生产代码：per-runtime Store、共享 Selector、CLI flags、Handoff pin、Unmount/Shutdown cleanup。
- [x] 增加最小回归测试：Store、CLI、Vite、Handoff、Client 和 packed 双页 Browser coverage。
- [x] 运行当前 Goal 完整门禁：全部 PASS，证据见 Outcomes。
- [x] 独立 Review：检查最终 diff、旧单文件引用、路径边界、HMR runtime identity、`git diff --check`。
- [x] 更新 Outcomes。

## Surprises & Discoveries

- 初次 focused gate 的失败只来自旧测试仍读取 `browser-state.json`；重建公开 CLI 并改为 per-runtime fixture 后 47/47 通过。
- 第一次 packed E2E 暴露真实生命周期问题：Vite virtual client HMR 重挂载会生成新 `runtimeId`，导致已经带 `--runtime` 的 Wait 在 CSS HMR 中报告 `browser_runtime_not_found`。最终让每个 Page 的 runtime ID 跨 HMR 保持稳定，且 HMR-only teardown 保留状态；普通 Page close 与 Vite shutdown 仍删除所属状态。修复后的完整 packed E2E 通过。
- 同时运行 `build`、`check:package`、`check:tarball` 会因多个命令清理同一个 `dist/` 产生一次非产品并发失败；随后串行重跑 `check:package` 通过。Required gates 均按串行最终状态记录。

## Decision Log

- Browser State 固定存储为 `<runtimeRoot>/browser-states/<runtimeId>.json`；不读取、不迁移旧 `browser-state.json`。
- 复用 `AGENT_ANNOTATIONS_ID_PATTERN` 校验 Runtime ID，并对目录、文件名、真实目录和 containment 同时校验；非法/过期文件安全清理，合法 stale 文件保留到固定 24 小时 cleanup threshold。Freshness 仍为 15 秒。
- `selectAgentAnnotationsBrowserState()` 是 `status` 与 browser-update `wait` 的唯一选择逻辑：精确 runtime/route、一个 fresh runtime 自动选择、零个 disconnected、多个明确 `ambiguous_browser_runtime`；不看 mtime。
- `status --json` 返回确定排序的 `runtimes`、`selectedRuntimeId` 和 `runtimeSelectionError`。`--runtime`/`--route` 严格、互斥，不添加兼容 alias。
- Handoff 记录生成时的安全 route 和 runtime，并给 Wait/Status 命令加 `--runtime`，避免后续页面切换或并发标签页改变目标。
- Page close 用 authenticated DELETE 只删除自己的文件；Vite shutdown 删除该 session 已接受的 runtime 集合；HMR 保持同一 Page runtime identity 且不做删除，避免 pinned Wait 在热更新中失去目标。

## Outcomes & Retrospective

- 行为结果：单文件 Last Writer Wins 已移除；并行 Page 各自持久化、选择、等待、交接和清理自己的 Browser State。
- `pnpm exec vitest run tests/server/browser-state.test.ts tests/cli/cli.test.ts tests/server/vite.test.ts`：PASS，3 files / 47 tests。
- `pnpm typecheck`：PASS。
- `pnpm test`：PASS，37 files / 444 tests（含 build pretest）。
- `pnpm check:architecture`：PASS，1 file / 29 tests。
- `pnpm check:docs`：PASS，`docs smoke PASS`。
- `pnpm build`：PASS，三组 ESM/declaration outputs 完成。
- `pnpm test:e2e`：PASS；fresh packed tarball consumer 中 18 个 Playwright tests 加 shutdown fixture 全部通过，其中双页 `/customers` + `/orders` 验证隔离 HMR/Wait/Page close。
- 额外证据：串行 `pnpm check:package` PASS（publint + ATTW），`pnpm check:tarball` PASS（26 files, 111508 bytes）。
- G04-001 PASS：Store 并行写测试和 packed 双页测试证明两个 Runtime 稳定共存、不覆盖。
- G04-002 PASS：CLI 单测覆盖零个、一个、多个 runtime，以及精确 `--runtime`/`--route`；摘要按 runtime ID 排序。
- G04-003 PASS：CLI 单测证明 ambiguity 返回 `ambiguous_browser_runtime`，`status --check` 与 `wait` 均 exit 1。
- G04-004 PASS：Core/Client/packed vertical tests 证明 Handoff 记录 runtime/route 且 Wait/Status 带发起 runtime 的 `--runtime`。
- G04-005 PASS：packed `/orders` route-specific HMR 只满足 orders runtime wait，customers wait 保持原 generation。
- G04-006 PASS：生产代码、测试、公开文档均无单文件读写路径；旧文件仅在历史问题说明中出现并被忽略。
- G04-007 PASS：Store/CLI 单测拒绝 traversal、separator、dot、超长 Runtime ID、query route 和互斥 selector；真实目录 containment 受校验。
- Remaining risk：authenticated DELETE 是 browser unload 的 best-effort keepalive；未送达时状态会在 15 秒后失去 fresh 资格，并在 24 小时 cleanup threshold 后清理，不会被默认选择。
