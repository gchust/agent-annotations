# Goal 11 — 为最终候选生成不可伪造的 Clean-room Release Proof

## Goal Objective

```text
/goal 在不修改产品代码的前提下，从干净归档构建一个 exact tarball，完成本地全门禁、五次首轮 E2E 和当前 HEAD 的真实远程 CI，并提交最终证据。
```

## 单一完成结果

在不修改产品代码的前提下，从干净归档构建一个 exact tarball，完成本地全门禁、五次首轮 E2E 和当前 HEAD 的真实远程 CI，并提交最终证据。

## 问题背景

最终发布证据必须独立于产品修改，且不能引用旧提交、临时 tarball、重跑后的结果或未执行的远程平台。

## 前置依赖

- Goal 10 完成并通过，产品工作区 clean。

## 必须先阅读

- `00-shared-contract.md`
- `CURRENT-REVIEW-BASELINE.md`
- 当前 Goal 中列出的相关生产代码与测试
- 实际仓库的 `AGENTS.md`、`package.json` 和当前 HEAD

## 主要修改范围

- `RELEASE-CANDIDATE-EVIDENCE.md`
- 只允许为了证据修正明显拼写；任何产品/测试/脚本修改都必须返回 Goal 10。
- GitHub Actions 当前 HEAD

实际文件名可以根据当前 HEAD 调整，但不得创建第二套平行协议或重复实现。

## 实现合同

1. 记录产品候选 SHA；证据文件提交本身不能作为被审计产品 SHA。
2. 从 `git archive <product-sha>` 创建无 `.git`、无 dist、无 node_modules 的 clean source。
3. 在 clean source 运行 frozen install、typecheck、test、architecture/docs、build 和 exact-tarball release verify。
4. 只 Pack 一次最终候选 tarball，记录 SHA256、大小和完整文件列表。
5. 在无 React 的 Core/CLI Consumer 验证 `/core` 和 CLI。
6. 在 Browser Consumer 安装同一 tarball，一次 install 后连续运行 5 次 E2E；不得 retry、repack 或 reinstall。
7. 运行生产 Build，并扫描所有 Runtime/API Marker。
8. 推送产品候选并等待当前 SHA 的 Ubuntu Node 20/24、Windows Node 20/24 与 Release Job 全部完成。
9. 若无推送权限或远程 CI 未运行，Goal 必须为 BLOCKED；不得写 PASS。
10. 证据逐条映射 `FINAL-ACCEPTANCE-MATRIX.md`。
11. 不执行 npm publish，不创建 Release Tag，除非用户另行明确要求。

## 明确禁止

- 不在本 Goal 修复产品代码。
- 不把第二次重跑成功替代第一次失败。
- 不引用旧 SHA 的 CI。
- 不把本地 Linux 证据当成 Windows 证据。
- 不在证据中写无法复现的口头结论。

## 必须新增或更新的测试

- 检查产品工作树 clean。
- Clean archive full gates。
- Exact tarball core consumer。
- Exact tarball browser consumer 5× first-pass。
- Production exclusion scan。
- GitHub Actions 当前产品 SHA 全矩阵。
- Evidence 文件自检：SHA、命令、退出码、日志路径、tarball hash、限制。

## 验收标准

- **G11-001**：产品 SHA 与证据 SHA 分离。
- **G11-002**：Clean install 全门禁首轮通过。
- **G11-003**：同一 tarball 通过所有 consumer 和 E2E。
- **G11-004**：五次 E2E 无重跑、无重新安装。
- **G11-005**：Production Bundle 无 Runtime Marker。
- **G11-006**：当前产品 SHA 的远程 CI 全绿。
- **G11-007**：所有最终 Acceptance Matrix 项有证据。
- **G11-008**：证据诚实记录环境和限制。

## 验收命令

先运行最小相关测试，修复后执行：

```bash
git status --short
```
```bash
pnpm release:verify
```
```bash
pnpm test:e2e:repeat
```
```bash
gh run list --workflow ci --limit 20
```

任何命令失败都不能标记 Goal 完成。

## 建议 Conventional Commit

```text
chore(release): record final alpha evidence
```

## 完成证据格式

最终回复必须包含：

```text
Goal 11: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Behavioral result:
Commands and exact results:
Acceptance criteria:
  G11-001 PASS/FAIL/BLOCKED — evidence
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


## 特殊规则

若任何本地或远程门禁失败：

1. 不修改证据把它描述为已知限制后继续。
2. 返回对应产品 Goal 修复。
3. 产生新的产品候选 SHA。
4. 从头执行 Goal 11。
