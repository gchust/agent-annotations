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

- [x] 2026-08-22：确认起始 HEAD 为 `e0654a0357ddd3b64d1e34581feb5293347675b1`，工作区干净，Goal 02 已提交。
- [x] 2026-08-22：检查全部 Page Context producer/parser，并建立 G03-001～G03-007 到 Runtime、Host、Task Schema、Browser State、Diagnostics、Evidence、Handoff 和 packed E2E 的映射。
- [x] 2026-08-22：实现唯一 `createSafePageContext()` 规则与 Host `pageContext()` override；Annotation、route state、Browser State 和 Evidence 共享安全 route identity。
- [x] 2026-08-22：增加默认/Host/Schema/Browser State/Registry 测试及 OAuth/reset/signedUrl sentinel packed-browser 覆盖。
- [x] 2026-08-22：运行全部 Goal 03 门禁；required focused suite 为 5 files / 180 tests，full unit suite 为 37 files / 441 tests，architecture 为 29 tests，packed E2E 为 17 Playwright tests 加 shutdown cleanup。
- [x] 2026-08-22：独立检查最终生产、测试和文档 diff，运行 producer/parser 搜索与 `git diff --check`；未发现 Goal 04、默认 query allowlist、NocoBase coupling 或阻断问题。
- [x] 2026-08-22：更新 Outcomes 并准备单一 Conventional Commit。

## Surprises & Discoveries

- 首轮 focused tests 暴露 `redaction.test.ts` 仍用 query-bearing URL 作为合法输入。严格 Task Parser 正确地在 Redaction 前拒绝该 fixture；测试改为用安全 URL 和敏感 title 验证 Redaction，未放宽 parser。
- URL API 会把尾部空 `?` / `#` 规范化为空；为了执行“不得包含 query/fragment”的字面合同，最终验证同时检查原始字符串分隔符，而非只检查 parsed `search` / `hash`。
- Host 抛出的 Error message 本身可能包含原始 query。Page Context 隔离诊断因此只持久化固定的 package-owned 错误文本，不复制第三方异常内容。
- Packed sentinel 场景在同一 evidence-bearing annotation 上证明 Task、Browser State、Handoff、Diagnostics 和 Screenshot Metadata 均不含 sentinel，同时 `/#/customers` 保留。

## Decision Log

- Decision：在现有 `runtime/annotated.ts` 中建立唯一 `createSafePageContext()`，不增加平行协议；原因是 element/region annotation、Host route controller 和 Browser State 都已汇聚到 Runtime mount。
- Decision：默认 URL 使用 `origin + pathname`，默认 route 使用 `pathname + hash`，并移除 hash 内的 query suffix；原因是保留 Hash Router identity，同时不让 query-like payload 穿过最终 parser。
- Decision：新增 Host `pageContext()`，当它存在时成为 Host page identity 的唯一来源；旧 `routeKey()` 仅在 `pageContext()` 缺失时作为现有 route-only API 使用，避免两个返回值冲突。
- Decision：Host override 只接受 `url` / `routeKey` / `title`，完整验证后整体采用；任何 throw、未知字段或非法值均整体回退并记录一次 `pageContext` extension diagnostic。
- Decision：Task Schema 最终拒绝非 HTTP(S)、credentials、query、fragment、control characters；Browser State Parser 最终拒绝 query/control characters。客户端清理不代替持久化边界验证。

## Outcomes & Retrospective

- Outcome：G03-001～G03-007 全部通过。默认 Task URL/Route、Browser State、Handoff、Diagnostics 和 evidence-bearing task 均无 Search Params；Host 可提供有界、安全业务 route key；非法 Host 不影响 Studio；Hash Router 保持 `/#/customers`。
- Sentinel：fresh packed consumer 访问 `/?code=G03_OAUTH_RESET_SIGNED_URL_SENTINEL&reset=...&signedUrl=...#/customers`，真实创建 annotation 和 screenshot evidence，并断言 Task、Browser State、Copy Handoff、network Diagnostics 及完整 evidence-bearing task 都不含 sentinel。
- Gates：required focused `pnpm exec vitest run tests/client/runtime.test.ts tests/client/runtime-controllers.test.ts tests/server/browser-state.test.ts tests/core/handoff.test.ts tests/core/redaction.test.ts` PASS（5 files / 180 tests）；扩展 focused suite PASS（7 files / 208 tests）；`pnpm typecheck` PASS；`pnpm test` PASS（37 files / 441 tests）；`pnpm check:architecture` PASS（1 file / 29 tests）；`pnpm check:docs` PASS；`pnpm build` PASS；`pnpm test:e2e` PASS（fresh packed external consumer, 17 Playwright tests + shutdown cleanup）；附加 `pnpm check:package` 与 `pnpm check:tarball` PASS（26 files / 109591 bytes）。
- Review：最终 producer/parser 搜索只保留 Diagnostics URL parsing 和 Vite HMR URL resolution 对 `location.href` 的非持久化使用；Page Context 不再读取 `location.href` / `location.search`。剩余风险限于 Goal 04 计划处理的 multi-runtime Browser State，不属于 Goal 03。
