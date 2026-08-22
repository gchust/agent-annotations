# 最终验收矩阵

Goal 11 必须逐条提供证据。

## Browser Update 与 Revision

- **F-001** Task Mutation 不推进 Browser Update Revision。
- **F-002** 失败 HMR 不推进 Browser Update Revision。
- **F-003** Initial Mount / Full Reload / `vite:afterUpdate` 是唯一可信推进入口。
- **F-004** CSS-only HMR 可通过 Browser Update Revision 验证。
- **F-005** 无引用 Source File 时 Revision 为 null。
- **F-006** Referenced Source Revision 与 Browser Update Revision 语义分离。
- **F-007** 旧 Wait Flags 和 Browser State v1 无兼容入口。

## Privacy 与 Runtime Identity

- **F-008** 默认 Task URL/Route 无 Query。
- **F-009** Browser State/Handoff/Diagnostics 无 Query。
- **F-010** Host 可提供严格验证的安全 Page Context。
- **F-011** 多标签页状态文件互不覆盖。
- **F-012** CLI 多 Runtime 歧义明确失败。
- **F-013** Handoff 锁定 Runtime 和 Route。

## Extension 与 Transport

- **F-014** 所有 HostIntegration 回调故障被隔离。
- **F-015** Host identity 失败不阻止普通 Annotation。
- **F-016** mutate 成功必须同 Task ID 且 Revision 前进。
- **F-017** writeEvidence 成功必须同 Task、Annotation 存在、Revision 前进。
- **F-018** 所有 Task 输入输出严格 Schema Parse。
- **F-019** Mutation 进入 Custom Transport 前验证并脱敏。
- **F-020** FileTaskStore 最终持久化 Redaction 保持。

## Marker 与 Evidence

- **F-021** Multi/Region 所有 Target 参与 iframe 跟踪。
- **F-022** Marker/Highlight/Summary 使用同一解析快照。
- **F-023** 动态 iframe/Shadow Root 后可恢复。
- **F-024** Cross-origin 明确 unsupported。
- **F-025** 滚动/Resize 后 Highlight 对齐。
- **F-026** 自动 Screenshot 在 Unfreeze 前固定页面状态。
- **F-027** Screenshot 编码/上传不阻塞 Annotation 保存。
- **F-028** Screenshot 不泄漏表单值、媒体或凭据。

## Code Agent 闭环

- **F-029** status 可选择 Runtime、Route 与 Annotation。
- **F-030** status 可验证 Target Health。
- **F-031** status 可按时间 Baseline 失败于新 Diagnostic。
- **F-032** Handoff 使用 Browser Update Baseline。
- **F-033** Handoff 不把原始评论作为 Completion Summary。
- **F-034** `complete --summary-file` 跨平台工作。
- **F-035** 低参数 Agent 可按 Handoff 完成修改→等待→状态→完成闭环。

## 精简、包与发布

- **F-036** 只剩完整 Browser State Heartbeat。
- **F-037** `/source` Endpoint 已删除。
- **F-038** 每次逻辑状态更新只构造一次 Public Snapshot。
- **F-039** PointerMove 不 Commit 完整 Public State。
- **F-040** `/core` 无 React/Vite/Node 浏览器依赖回归。
- **F-041** Production Build 无 Runtime/API Marker。
- **F-042** Release Gate 只生成一个 exact tarball。
- **F-043** Package、Tarball、Consumers、E2E 复用同一 SHA256。
- **F-044** Ubuntu Node 20/24 远程 CI PASS。
- **F-045** Windows Node 20/24 远程 CI PASS。
- **F-046** Release Job 远程 CI PASS。
- **F-047** 五次 E2E 首轮全绿，无重跑。
- **F-048** Changelog、Version、publishConfig 和 Registry 事实一致。
- **F-049** 根目录无中间态实现过程文件。
- **F-050** Release Evidence 完整、可复现、未夸大。
