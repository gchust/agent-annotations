# 当前 Review 基线

核验基线：

```text
main
6651cff4d970fd3ddf23f414d08f56149d3709ab
chore(release): prove high-quality alpha candidate
```

## 已确认做得好的部分

- 单一 React Grab 感知引擎。
- 独立 `/core` 入口。
- Stable React Root 与 Controller 拆分。
- Marker 身份校验。
- Screenshot 坐标与表单清理。
- Network Diagnostics。
- `validate-task`、`status` 与 Agent Handoff。
- 服务端最终 Redaction、Revision Conflict 与 File Lock。
- Packed Consumer、Package Audit 和 Open Source 治理文件。

## 本轮仍需解决的问题

### 正确性

1. Task Mutation 会触发 `refreshAppliedSourceRevision()`，可能把未成功 HMR 的磁盘内容报告为浏览器已应用。
2. Revision 只覆盖组件源码；CSS、主题、配置等 HMR 无法验证。
3. 无引用 Source File 时仍生成空输入 SHA，而不是 `null`。
4. Task `pageContext.url` 和默认 `routeKey` 仍保存 Query。
5. 多标签页争用同一个 `browser-state.json`。
6. HostIntegration 运行时调用未完全隔离。
7. Custom Transport 的 `mutate` / `writeEvidence` 成功结果缺少方法级协议验证。
8. Marker iframe 未解析检测只看第一个 Target；Highlight 和 Summary 刷新仍有边界。
9. `status --check` 未验证具体 Annotation、Route、Target 和新 Diagnostics。
10. Handoff 使用原始评论作为 Completion Summary，且命令引用偏 POSIX。
11. Screenshot 在 Unfreeze 后才固定 DOM，瞬时 Hover/Popover 可能丢失。

### 精简与维护

1. HttpTaskTransport 空 Heartbeat 与完整 Browser State Heartbeat 重复。
2. `/source` Endpoint 看起来没有生产调用方。
3. README 对 Manual Runtime 重复包装 Validated Transport。
4. `render()` + `emit()` 重复 Snapshot、Clone、Freeze 和 Chrome 更新。
5. Release Gate 多次 Build/Pack，证据需要区分多个 tarball。
6. `tests/client/runtime.test.ts` 仍过于集中。
7. 当前 Release Candidate 尚无实际远程 CI。
8. Version、Changelog、`publishConfig` 和根目录历史文件还需收口。
