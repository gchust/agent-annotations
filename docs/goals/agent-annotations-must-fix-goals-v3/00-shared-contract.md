# Shared Contract — Agent Annotations 必须修复 v3

本合同适用于 Goal 01–03，优先级高于各 Goal 中的建议性实现细节。

## 产品边界

必须保留：

- React + Vite 独立 Library 定位；
- `react-grab/primitives` 作为唯一通用元素感知引擎；
- Extension Registry、Pick、Multi、Area、Marker、Annotation List；
- Task Schema v1、Revision Mutation、CLI、Diagnostics、Evidence；
- 多 Runtime Browser State v2；
- `validate-task`、`status`、`revision`、`wait` 等当前 CLI；
- 开发态自动注入与 Production Exclusion；
- NocoBase-neutral 核心，不新增 `@nocobase/*` 或 `data-nb-*` 硬编码。

## 本轮明确不做

- 不新增 MCP、WebSocket、SSE 或常驻事件总线；
- 不升级 Task Schema；
- 不恢复旧 Browser State v1 兼容；
- 不增加旧 Runtime ID / Revision 迁移表；
- 不新增模糊 Marker fallback；
- 不改 Toolbar 产品形态；
- 不重写 React Grab、FileTaskStore 或 Extension Registry；
- 不为了减少文件行数进行无行为收益的大重构；
- 不发布 NPM，不创建 Git tag，不修改用户凭据；
- 未经用户在当前会话明确授权，不执行 `git push`。

## 核心不变量

### Runtime 身份

- 每个浏览器标签页有且只有一个 Runtime ID。
- 同一标签页的 HMR 重挂载与完整 Reload 必须沿用该 ID。
- 独立标签页必须拥有不同 Runtime ID。
- Runtime ID 不能来自 URL、Task 或服务器 Last Writer Wins。

### Browser Update Revision

- `browserUpdateRevision` 是同一 Runtime 的单调递增整数。
- Initial Mount、成功 HMR、Full Reload 可以推进。
- Task Mutation、Comment、Complete、Reopen、Evidence、Poll、Heartbeat 不能自行推进。
- HMR/Reload 后不得回到 0 或较小值。

### Heartbeat

- 同一 Runtime 同一时刻最多一个 Heartbeat POST 在途。
- 在途期间的新状态只保留最新快照，不排队发送所有中间状态。
- 服务端不能让较小的 `browserUpdateRevision` 覆盖较大值。
- Browser State v2 保持严格解析；本轮不新增兼容协议。

### CLI

- `wait --browser-update-revision ... --runtime <id>` 在 Reload 的短暂断连期间继续等待，直到成功或超时。
- 明确的 `ambiguous_browser_runtime` 仍应立即失败。
- 所有 `--json` 输出必须只有一个可解析 JSON 值；错误只写 stderr。

### Release Evidence

- Release Proof 必须针对 Goal 02 完成后的产品候选 SHA。
- 所有 Package 检查和消费者测试必须使用同一个精确 tarball。
- 远程 CI 没有在候选 SHA 上运行或未全绿时，只能报告 `BLOCKED`。
- Release Evidence 必须在产品候选之后以 evidence-only commit 生成。

## 代码质量要求

- 优先修改现有 `browser-status.ts`、Vite 虚拟客户端、Browser State Store 与 CLI，不创建平行 Runtime 协议。
- 新 Helper 必须职责单一且有直接测试；不为“一致性”创建无调用抽象。
- 错误码、CLI 字段和文件格式必须稳定、可测试、可文档化。
- 所有新增定时器、Listener、请求队列必须在 Unmount 后停止。
- 测试禁止用固定长 `sleep` 掩盖竞争；使用可观测条件与有界轮询。
