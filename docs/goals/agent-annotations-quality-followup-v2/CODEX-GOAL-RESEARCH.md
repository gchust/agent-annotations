# Codex Goal / ExecPlan 写法依据

本套件依据 OpenAI 官方资料整理：

- **Using Goals in Codex**：Goal 是有边界的完成合同，应定义 Outcome、Verification surface、Constraints、Boundaries、Iteration policy 和 Blocked stop condition。
- **Follow a goal**：一个 Goal 应大于普通单次任务，但小于开放式 backlog；需要明确“做成什么、不要改什么、怎样验证、何时停止”。
- **Using PLANS.md for multi-hour problem solving**：长任务使用可持续更新的 ExecPlan，维护 Progress、Surprises & Discoveries、Decision Log、Outcomes & Retrospective。
- **Codex best practices**：复杂任务先 `/plan`；`AGENTS.md` 保持短小，只放可复用仓库规则、构建命令和 Definition of Done。
- **Code migrations / refactors**：按小而可审查的里程碑迁移，每个 checkpoint 运行最小充分验证，避免最后一次性整合风险。

官方参考：

- https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex
- https://developers.openai.com/codex/use-cases/follow-goals/
- https://developers.openai.com/cookbook/articles/codex_exec_plans
- https://developers.openai.com/codex/learn/best-practices
- https://developers.openai.com/codex/use-cases/code-migrations
- https://developers.openai.com/codex/use-cases/refactor-your-codebase

## 本套件的结构原则

1. 每个 Goal 只有一个主要可演示结果。
2. 每个 Goal 有确定的禁止事项，防止低参数模型顺手扩大范围。
3. 每个 Goal 先给行为合同，再给建议文件；真实仓库结构优先。
4. 每条 AC 都能映射到测试、命令或制品。
5. 只有当前 Goal 的 AC 全部通过，才允许进入下一个 Goal。
6. 最终 Release Proof 与产品修改分离，避免自证循环。
