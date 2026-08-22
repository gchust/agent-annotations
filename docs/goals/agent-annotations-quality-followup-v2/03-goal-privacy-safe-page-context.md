# Goal 03 — 建立默认不保存 Query 的 Page Context 合同

## Goal Objective

```text
/goal 让 Task、Browser State、Handoff 和 Diagnostics 的默认页面标识都不包含 Search Params；需要业务级路由区分时只能由 Host 返回显式白名单后的安全值。
```

## 单一完成结果

让 Task、Browser State、Handoff 和 Diagnostics 的默认页面标识都不包含 Search Params；需要业务级路由区分时只能由 Host 返回显式白名单后的安全值。

## 问题背景

当前 Annotation `pageContext.url` 使用 `location.href`，默认 `routeKey` 包含 `location.search`。OAuth Code、重置票据、Signed URL、邮箱和业务 PII 可能进入 Task 与 Handoff，通用正则脱敏无法覆盖所有参数。

## 前置依赖

- Goal 02 完成并通过。

## 必须先阅读

- `00-shared-contract.md`
- `CURRENT-REVIEW-BASELINE.md`
- 当前 Goal 中列出的相关生产代码与测试
- 实际仓库的 `AGENTS.md`、`package.json` 和当前 HEAD

## 主要修改范围

- `src/client/runtime/annotated.ts`
- `src/client/runtime/host.ts`
- `src/client/runtime/mount.ts`
- `src/types/index.ts`
- `src/core/redaction.ts`
- `src/server/browser-state.ts`
- Page Context、Runtime、Handoff、E2E 与文档测试

实际文件名可以根据当前 HEAD 调整，但不得创建第二套平行协议或重复实现。

## 实现合同

1. 默认 `pageContext.url` 为 `origin + pathname`，不包含 query、fragment、credentials。
2. 默认 `routeKey` 为 `pathname + hash`，不包含 query。
3. 抽取唯一的 `createSafePageContext()` 或等价 helper，Annotation 与 Browser State 使用同一规则。
4. 为 HostIntegration 增加可选 `pageContext()`，返回经过宿主白名单处理的 `url` / `routeKey` / `title`。
5. Host 返回值必须是有界字符串；`url` 必须为 http(s) 且无 credentials/query/fragment；`routeKey` 不得包含 `?`、控制字符或超长内容。
6. Host 不提供 pageContext 时使用安全默认值。
7. 现有 `routeKey()` 可以保留或被 pageContext 统一替代，但只保留一个最终事实来源；避免两个 Host 方法互相冲突。
8. Task Parser 和 Browser State Parser 对 Query 进行最终拒绝，而不是只依赖客户端清理。
9. Handoff 只能读取已经安全化的 Page Context。
10. 文档明确：需要 tenant/filter 区分时，Host 应生成不含原始 Query 的安全业务键。

## 明确禁止

- 不保存原始 `location.href`。
- 不通过保留“已知安全参数列表”来默认允许 Query。
- 不把 Query 先写入 Task 再依赖 Redaction。
- 不添加 NocoBase 专用 Page Context。

## 必须新增或更新的测试

- 单元测试：默认 URL/Route 去除 Query。
- 单元测试：Host 安全 override 可工作，非法 override 被隔离并回退。
- Schema/Browser State 测试：持久化 Query 被拒绝。
- E2E：访问 OAuth、reset、signedUrl 风格 Query，Task、Browser State、Handoff、Diagnostics 和 Screenshot Metadata 均不包含 Sentinel。
- Hash Router 的 `#/customers` 继续被保留。

## 验收标准

- **G03-001**：默认 Task 中无 Search Params。
- **G03-002**：默认 Browser State 中无 Search Params。
- **G03-003**：Handoff 中无原始 Query 或 Sentinel。
- **G03-004**：Host 可提供安全业务 Route Key。
- **G03-005**：非法 Host Page Context 不破坏 Studio。
- **G03-006**：Hash Route 无回归。
- **G03-007**：所有安全边界都有服务端或 Schema 最终验证。

## 验收命令

先运行最小相关测试，修复后执行：

```bash
pnpm exec vitest run tests/client/runtime.test.ts tests/client/runtime-controllers.test.ts tests/server/browser-state.test.ts tests/core/handoff.test.ts tests/core/redaction.test.ts
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
fix(privacy): remove query data from page context
```

## 完成证据格式

最终回复必须包含：

```text
Goal 03: PASS | FAIL | BLOCKED
HEAD before:
HEAD after:
Changed files:
Behavioral result:
Commands and exact results:
Acceptance criteria:
  G03-001 PASS/FAIL/BLOCKED — evidence
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
