# 共享产品与工程合同

本文件是 Goal 01～11 的共同权威合同。当前 Goal 与本文件冲突时，以本文件为准；若真实仓库事实要求调整实现路径，只能调整文件位置和内部结构，不得改变产品边界。

## 1. 执行方式

- 必须先检查实际 `git status`、当前 HEAD、相关文件和现有测试。
- 不要只输出计划、伪代码或建议；`/goal` 阶段必须实际修改仓库。
- 每个 Goal 只实现自己的范围，不得提前开始后续 Goal。
- 每个 `PASS` 必须有实际运行的命令或浏览器证据。
- 失败后先定位最小原因，修复后重跑最小测试，再跑当前 Goal 完整门禁。
- 不得通过跳过测试、增加重试、延长固定 sleep、放宽断言或捕获异常来伪造通过。
- 不得声称未执行的远程 CI、浏览器测试或平台矩阵已经通过。

## 2. 保留的产品能力

必须保留：

- React + Vite 开发态自动注入。
- `react-grab/primitives` 作为唯一通用感知引擎。
- Pick / Multi / Area。
- Annotation、Marker、List、Open/Completed/Reopen。
- 可扩展 Toolbar / Panel / Enricher / Exporter / Redactor / Host。
- Task Schema、Revision、Mutation、Redaction。
- Screenshot Evidence、Diagnostics。
- 普通 CLI Code Agent 交接；不恢复 MCP。
- Production Build 完全剔除。
- `/core` 纯入口和 packed tarball consumer。

## 3. 明确禁止

- 不恢复 MCP。
- 不恢复已删除的 `verify` 命令；合法命令仍为 `validate-task`。
- 不引入 React Fiber 私有访问、`element-source` 直连、自研源码猜测或旧感知 fallback。
- 不引入 basename 猜文件。
- 不引入浏览器源码写入、Shell、Git 或模型调用。
- 不添加 NocoBase 硬编码；NocoBase 只能通过外部 Extension 集成。
- 不为当前预发布中间态保留 Browser State 或 CLI Wait 兼容别名。
- 不静默接受非法 Task、非法 Browser State 或非法 Transport 成功响应。
- 不用模糊 Selector 或近似文本重新绑定 Marker。
- 不把用户 Query、Cookie、Header、Body、表单值写入任务、诊断或浏览器状态。

## 4. 允许的破坏性变更

当前仍为预发布 Alpha，以下变更允许破坏旧中间态：

- Browser State v1 → v2。
- 单文件 Browser State → per-runtime Browser State。
- `wait --source-revision` / `--browser-source-revision` 重命名为语义准确的新选项。
- Handoff 输出合同变化。
- `complete` 增加 `--summary-file`。
- 内部 Runtime Controller API 调整。

不要为这些旧中间态添加兼容层。旧 Browser State 应被拒绝或安全清理。

## 5. 安全不变量

- Vite API 默认仅允许 loopback，随机 Token 必须验证。
- Runtime 文件权限保持私有。
- Task 最终持久化必须执行 Parse → Generic Redaction → Parse。
- 自定义 Transport 前的 Mutation 必须验证、脱敏并重新验证。
- Screenshot 不采集表单值、凭据和原始媒体内容。
- Diagnostics 不采集 Query、Headers、Bodies、Auth。
- Page Context 默认不持久化 Search Params。
- Browser State 不包含 Token。
- Evidence、Diagnostics 和 Browser State 路径不得逃逸 Runtime Root。
- 第三方 Extension 视为可信页面代码，但其注册表面故障必须被隔离。

## 6. 测试不变量

每个 Goal 至少运行：

```bash
pnpm typecheck
pnpm test
pnpm check:architecture
```

涉及 Browser/Vite/CLI/Package 时，还必须运行对应的：

```bash
pnpm build
pnpm check:docs
pnpm check:package
pnpm check:tarball
pnpm test:e2e
```

不要在每个小修复后无条件跑最重门禁；先运行最小相关测试，Goal 结束前再跑完整门禁。

## 7. ExecPlan 记录要求

每个 Goal 文件中的以下章节必须持续更新：

- `Progress`
- `Surprises & Discoveries`
- `Decision Log`
- `Outcomes & Retrospective`

最终报告必须列出：

- 修改文件；
- 行为变化；
- 精确测试命令和结果；
- 每条 AC 的 PASS / FAIL / BLOCKED；
- 未解决风险；
- 最终 Commit SHA（若已提交）。

## 8. 停止条件

仅在以下情况下允许停止为 `BLOCKED`：

- 上游 `react-grab` 公共 API 无法满足已确认合同，且没有不违反边界的实现路径；
- 操作系统或浏览器缺失使要求的真实门禁无法运行；
- 没有远程仓库写权限，无法获得 Goal 11 要求的远程 CI；
- 所需外部发布凭据不存在。

阻塞报告必须包含：

- 已尝试路径；
- 命令和错误；
- 为什么继续会违反合同；
- 解除阻塞所需的最小输入。

## 9. 默认 Conventional Commit

每个 Goal 给出建议 Commit。除非仓库规则另有要求，保持一个 Goal 一个主提交；当前 Goal 内为修复门禁而追加的小提交可以 squash。
