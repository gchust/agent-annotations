# Goal 03 — 为当前产品候选生成可信 Release Proof

## Goal Objective

```text
/goal 对 Goal 02 完成后的产品候选 SHA 使用同一个精确 tarball 完成本地 clean-room、五次 E2E 和真实远程 CI 验证，并以 evidence-only commit 更新 Release Candidate Evidence。
```

## 单一完成结果

仓库根目录的 `RELEASE-CANDIDATE-EVIDENCE.md` 必须只证明当前产品候选，而不是历史 SHA，并包含：

```text
精确 Product Candidate SHA
同一个 tarball 的 SHA-256、大小、文件清单
本地 clean-room 门禁
Core/CLI Consumer
Browser Consumer 5 次首轮通过
Production Exclusion
当前候选 SHA 的真实远程 CI 结果
```

## 前置依赖

- Goal 01 与 Goal 02 已完成、独立 Review 并提交。
- 产品代码工作区干净。
- 本 Goal 不再修改产品代码。

## 必须先阅读

- `00-shared-contract.md`
- Goal 01、02 的最终 Outcomes
- `scripts/release-candidate.mjs`
- `scripts/release-verify.mjs`
- `scripts/repeat-e2e.mjs`
- `.github/workflows/ci.yml`
- 当前 `RELEASE-CANDIDATE-EVIDENCE.md`
- `package.json`

## 主要修改范围

本 Goal 最终允许的仓库改动仅限：

- 将旧 `RELEASE-CANDIDATE-EVIDENCE.md` 移入 `docs/historical/`；
- 新建当前候选的 `RELEASE-CANDIDATE-EVIDENCE.md`；
- 若证据生成脚本本身存在与产品无关的确定性 Bug，可先停止并报告，不得在本 Goal 顺手修产品。

最终 Evidence Commit 不得包含 `src/`、`tests/`、`fixtures/`、`scripts/`、`package.json` 等产品或门禁实现改动。

## 实现合同

### 1. 固定 Product Candidate

- 在任何 Evidence 文件改动前记录当前 HEAD，作为：

```text
PRODUCT_CANDIDATE_SHA
```

- `git status --short` 必须为空。
- 后续所有本地门禁、tarball 和远程 CI 都必须对应这个 SHA。
- 测试失败时，不得在本 Goal 修改产品代码后继续沿用原 Candidate；应停止 `BLOCKED`，回到新的修复 Goal。

### 2. 本地精确候选验证

至少执行：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm check:architecture
pnpm check:docs
pnpm release:verify
pnpm test:e2e:repeat
```

要求：

- `release:verify` 只生成一个精确候选 tarball。
- Publint、ATTW、Tarball Audit、Core Consumer、Browser Consumer 使用同一个 SHA-256。
- Repeat Gate 在同一个已安装 Consumer 与同一个 tarball 上运行。
- 不允许 Playwright Retry 或失败后手工重跑来覆盖 Flake。

### 3. 远程 CI

目标 Candidate SHA 必须有真实 GitHub Actions 结果：

```text
ubuntu-latest / node 20
ubuntu-latest / node 24
windows-latest / node 20
windows-latest / node 24
release verify (ubuntu / node 20)
```

规则：

- 未经用户当前会话明确授权，不执行 `git push`。
- 如果 Candidate 尚未推送或远程 CI 未运行，报告 `BLOCKED`，列出准确 SHA 和用户需要执行的最小动作。
- 不得把本地 Linux 结果写成 Windows 或远程 CI PASS。
- 远程任一必要 Job 失败，不能生成“通过”的 Release Evidence。
- Evidence 中记录 Workflow Run URL/ID、Head SHA、结论与检查时间。

### 4. Evidence-only Commit

所有验证通过后：

1. 将旧根 Evidence 移到明确的历史文件，例如：

```text
docs/historical/release-candidate-evidence-2026-08-22-pre-runtime-continuity.md
```

2. 新建根 `RELEASE-CANDIDATE-EVIDENCE.md`，证明 `PRODUCT_CANDIDATE_SHA`。
3. Evidence 必须说明其自身 Commit 是后续 evidence-only commit，产品候选是其 Parent。
4. Evidence 不得包含本机 Token、用户名、敏感路径或不可访问的“私有日志即证明”。
5. 可以记录外部日志位置作为补充，但关键命令、Exit Code、摘要与 SHA 必须写入文档。
6. 明确记录：

```text
git push 是否执行
npm publish 未执行
Git tag 未创建
```

### 5. 发布不在本 Goal 内

- 不运行 `npm publish`。
- 不创建 Tag/Release。
- 只证明候选，不执行发布。

## 明确禁止

- 不修改产品代码让测试变绿。
- 不重新 Pack 多个 tarball 后挑选通过者。
- 不对失败 E2E 使用 Retry 或“第二次通过”作为最终证据。
- 不伪造远程 CI、Windows 或 Node 版本结果。
- 不将旧 Evidence 留在根目录继续冒充当前候选。
- 不自动 Push、Publish 或 Tag。

## 验收标准

- **G03-001**：记录了干净的 Product Candidate SHA。
- **G03-002**：本地全部门禁在 Candidate 上首轮通过。
- **G03-003**：所有 Package/Consumer Gate 使用同一个 tarball SHA-256。
- **G03-004**：同一 Browser Consumer 连续 5 次 E2E 首轮通过。
- **G03-005**：Production Build 中不存在 Agent Annotations Runtime 注入。
- **G03-006**：Candidate SHA 的 Linux/Windows、Node 20/24 与 Release Job 真实全绿。
- **G03-007**：旧 Evidence 已历史归档，新根 Evidence 只证明当前 Candidate。
- **G03-008**：最终 Commit 是 evidence-only，不含产品代码。
- **G03-009**：没有执行 NPM Publish、Tag 或未经授权的 Push。

## 验收命令

```bash
git status --short
git rev-parse HEAD
```

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm check:architecture
pnpm check:docs
pnpm release:verify
pnpm test:e2e:repeat
```

远程 CI（示例，按实际 GitHub CLI 能力执行）：

```bash
gh run list --workflow ci --commit "$PRODUCT_CANDIDATE_SHA"
gh run view <run-id> --json headSha,status,conclusion,jobs,url
```

最终 Diff：

```bash
git diff --check
git diff --name-status "$PRODUCT_CANDIDATE_SHA"..HEAD
```

最终 Diff 只能包含 Evidence 归档和新 Evidence 文件。

## 建议 Conventional Commit

```text
chore(release): prove runtime continuity candidate
```

## 完成证据格式

```text
Goal 03: PASS | FAIL | BLOCKED
Product candidate SHA:
Evidence commit SHA:
Exact tarball SHA-256:
Local gates:
Remote CI jobs:
Five E2E runs:
Changed files:
Acceptance criteria:
  G03-001 PASS/FAIL/BLOCKED — evidence
  ...
Push performed: yes/no
Publish performed: no
Tag created: no
Remaining risks:
```

## Progress

- [ ] 核验 Goal 01、02 Commit 和干净工作区。
- [ ] 固定 Product Candidate SHA。
- [ ] 运行本地 exact-candidate 门禁。
- [ ] 核验当前 Candidate 的远程 CI。
- [ ] 归档旧 Evidence。
- [ ] 生成当前 Evidence。
- [ ] 确认 Evidence-only Diff。

## Surprises & Discoveries

- 执行时填写。

## Decision Log

- 执行时填写实际决策及原因。

## Outcomes & Retrospective

- 完成时填写。
