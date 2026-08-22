# Agent Annotations 高质量开源库后续修复：Codex Goal 套件 v2

本套件基于 `gchust/agent-annotations` 的 `main` 分支提交：

```text
6651cff4d970fd3ddf23f414d08f56149d3709ab
chore(release): prove high-quality alpha candidate
```

目标不是增加更多功能，而是把当前 Alpha 收口成一个语义可信、安全边界清晰、可扩展、可维护、可公开发布的 React/Vite 开源库。

## 为什么拆成多个 Goal

Codex Goal 应是一个可审计的完成合同，而不是一个更长的 backlog。每个 Goal 只定义一个主要终态、一个停止条件和一组能直接运行的验证证据。本套件将后续工作拆成 11 个严格串行阶段：

| 顺序 | Goal | 单一可演示结果 |
|---:|---|---|
| 01 | 可信浏览器更新协议 | Task 变化再也不能伪装成浏览器已应用源码 |
| 02 | Revision 覆盖与 CLI 语义 | CSS/主题等 HMR 可验证；空 Source 不再生成无意义 SHA |
| 03 | 隐私安全 Page Context | 默认任务、浏览器状态和 Handoff 不持久化 URL Query |
| 04 | 多浏览器 Runtime 状态 | 多标签页不再互相覆盖；CLI 可确定选择 Runtime |
| 05 | Host 与 Transport 边界 | Host 回调故障被隔离；Transport 方法级协议被强制 |
| 06 | Marker 多目标正确性 | iframe/多目标 Marker、Highlight、Summary 在动态页面中持续正确 |
| 07 | Status 与 Agent Handoff | Code Agent 获得可验证、跨平台、逐批注完成的闭环合同 |
| 08 | 冻结态 Evidence | 自动截图保留用户标注瞬间，同时不阻塞保存 |
| 09 | Runtime 与协议精简 | 删除重复 Heartbeat、无调用 Endpoint 和重复 UI Snapshot 工作 |
| 10 | 发布工程与仓库收口 | 同一 tarball 完成全部发布门禁；CI、版本、文档和测试结构收口 |
| 11 | Clean-room Release Proof | 当前产品提交在干净环境、同一 tarball、远程 CI 下获得最终证据 |

## 使用方式

将整个目录放入仓库，例如：

```text
docs/goals/agent-annotations-quality-followup-v2/
```

每次只交给 Agent：

```text
00-shared-contract.md
+ 当前一个 Goal 文件
```

推荐流程：

```text
/plan 当前 Goal
→ 检查当前 HEAD 和实际代码
→ 输出 AC 到文件/命令/证据的映射
→ 不改代码

/goal 当前 Goal
→ 实际修改
→ 逐项运行验证
→ 修复失败
→ 更新 Goal 中的 Progress / Decisions / Outcomes
→ 独立 Review
→ checkpoint commit
→ 再进入下一个 Goal
```

不要一次把 11 个 Goal 全部交给低参数模型。不要并行让多个 Agent 修改同一个工作区。

## 文件说明

- `OVERVIEW.md`：整体架构、依赖顺序与最终状态。
- `00-shared-contract.md`：所有 Goal 的不可变合同。
- `CURRENT-REVIEW-BASELINE.md`：本轮问题基线。
- `CODEX-GOAL-RESEARCH.md`：Goal/ExecPlan 写法依据。
- `01`～`11`：串行实施 Goal。
- `FINAL-ACCEPTANCE-MATRIX.md`：最终统一验收矩阵。
- `launchers.md`：可直接复制给 Codex 的 `/plan`、`/goal`、独立 Review 提示词。
- `AGENTS-snippet.md`：建议加入仓库 `AGENTS.md` 的短规则。
- `MANIFEST.md`：文件清单与校验值。
