// Complete en-US/zh-CN dictionary for all user-visible runtime and builtin
// UI text. Host `messages` and extension registry messages override per key
// (merged before the dictionary); the dictionary is the base resolved against
// the current host locale, so locale switching re-renders in place and never
// remounts the Studio or loses an open draft.
export const MESSAGES = {
  // Toolbar / tooltips.
  "Pick": { "en-US": "Pick", "zh-CN": "拾取" },
  "Multi": { "en-US": "Multi", "zh-CN": "多选" },
  "Area": { "en-US": "Area", "zh-CN": "区域" },
  "Copy": { "en-US": "Copy", "zh-CN": "复制" },
  "Clear all annotations": { "en-US": "Clear all annotations", "zh-CN": "清除所有标注" },
  "Clear": { "en-US": "Clear", "zh-CN": "清除" },
  "Markers": { "en-US": "Markers", "zh-CN": "标记" },
  "Shortcut help": { "en-US": "Shortcut help", "zh-CN": "快捷键帮助" },
  "Annotations": { "en-US": "Annotations", "zh-CN": "标注" },
  "Collapse toolbar": { "en-US": "Collapse toolbar", "zh-CN": "折叠工具栏" },
  "Expand toolbar": { "en-US": "Expand toolbar", "zh-CN": "展开工具栏" },
  "Drag toolbar": { "en-US": "Drag toolbar", "zh-CN": "拖动工具栏" },
  "Annotation list": { "en-US": "Annotation list", "zh-CN": "标注列表" },
  "Route": { "en-US": "Route", "zh-CN": "路由" },
  // Composer.
  "Annotation composer": { "en-US": "Annotation composer", "zh-CN": "标注输入" },
  "Annotation comment": { "en-US": "Annotation comment", "zh-CN": "批注" },
  "Describe the requested change": { "en-US": "Describe the requested change", "zh-CN": "描述所需的变更" },
  "Annotation": { "en-US": "Annotation", "zh-CN": "标注" },
  "edit": { "en-US": "edit", "zh-CN": "编辑" },
  "Cancel": { "en-US": "Cancel", "zh-CN": "取消" },
  "Save annotation": { "en-US": "Save annotation", "zh-CN": "保存标注" },
  "Pick annotation": { "en-US": "Pick annotation", "zh-CN": "拾取标注" },
  "Multi annotation": { "en-US": "Multi annotation", "zh-CN": "多选标注" },
  "sampled targets": { "en-US": "sampled targets", "zh-CN": "个采样目标" },
  "Annotation saved": { "en-US": "Annotation saved", "zh-CN": "标注已保存" },
  "Save failed": { "en-US": "Save failed", "zh-CN": "保存失败" },
  // Multi finish chip.
  "Finish": { "en-US": "Finish ({count})", "zh-CN": "完成 ({count})" },
  "Complete selection": { "en-US": "Complete selection ({count})", "zh-CN": "完成选择 ({count})" },
  // Editor.
  "Annotation editor": { "en-US": "Annotation editor", "zh-CN": "标注编辑器" },
  "Save comment": { "en-US": "Save comment", "zh-CN": "保存评论" },
  "Complete": { "en-US": "Complete", "zh-CN": "完成" },
  "Reopen": { "en-US": "Reopen", "zh-CN": "重新打开" },
  "Delete": { "en-US": "Delete", "zh-CN": "删除" },
  "Close": { "en-US": "Close", "zh-CN": "关闭" },
  "Comment saved": { "en-US": "Comment saved", "zh-CN": "评论已保存" },
  "Capture screenshot": { "en-US": "Capture screenshot", "zh-CN": "截图" },
  "Screenshot captured": { "en-US": "Screenshot captured", "zh-CN": "截图已保存" },
  "Screenshot failed": { "en-US": "Screenshot failed", "zh-CN": "截图失败" },
  "Manual copy fallback": { "en-US": "Manual copy fallback", "zh-CN": "手动复制后备" },
  "Copied open annotations": { "en-US": "Copied open annotations", "zh-CN": "已复制开放标注" },
  "Annotation not found": { "en-US": "Annotation not found", "zh-CN": "未找到标注" },
  "Annotation is on another route": { "en-US": "Annotation is on another route", "zh-CN": "标注在其他路由" },
  "Navigating to annotation route": { "en-US": "Navigating to annotation route", "zh-CN": "正在跳转到标注路由" },
  "Panel failed to render": { "en-US": "Panel failed to render", "zh-CN": "面板渲染失败" },
  // List filters, statuses, kinds, and confirmations.
  "Open": { "en-US": "Open", "zh-CN": "开放" },
  "All": { "en-US": "All", "zh-CN": "全部" },
  "open": { "en-US": "open", "zh-CN": "开放" },
  "completed": { "en-US": "completed", "zh-CN": "已完成" },
  "element": { "en-US": "element", "zh-CN": "元素" },
  "multi": { "en-US": "multi", "zh-CN": "多选" },
  "region": { "en-US": "region", "zh-CN": "区域" },
  "Edit annotation": { "en-US": "Edit annotation", "zh-CN": "编辑标注" },
  "Remove completed": { "en-US": "Remove completed ({count})", "zh-CN": "移除已完成 ({count})" },
  "Remove": { "en-US": "Remove", "zh-CN": "移除" },
  "Confirm remove completed one": { "en-US": "Remove 1 completed annotation?", "zh-CN": "移除 1 条已完成标注？" },
  "Confirm remove completed": { "en-US": "Remove {count} completed annotations?", "zh-CN": "移除 {count} 条已完成标注？" },
  "Confirm clear one": { "en-US": "Clear 1 annotation?", "zh-CN": "清除 1 条标注？" },
  "Confirm clear all": { "en-US": "Clear all {count} annotations?", "zh-CN": "清除全部 {count} 条标注？" },
  // Resolution statuses.
  "unresolved": { "en-US": "unresolved", "zh-CN": "未解析" },
  "identity mismatch": { "en-US": "target changed", "zh-CN": "目标已变化" },
  "identity unverifiable": { "en-US": "identity unverifiable", "zh-CN": "身份不可验证" },
  "iframe unsupported": { "en-US": "iframe unsupported", "zh-CN": "iframe 不支持" },
  // Templates.
  "targets": { "en-US": "{resolved}/{total} targets", "zh-CN": "{resolved}/{total} 个目标" },
  "openAnnotations": { "en-US": "{count} open annotations", "zh-CN": "{count} 条开放标注" },
  "evidence": { "en-US": "{count} evidence", "zh-CN": "{count} 条证据" },
} as const satisfies Record<string, Record<"en-US" | "zh-CN", string>>;

export type AgentAnnotationsMessages = typeof MESSAGES;
export type AgentAnnotationsMessageKey = keyof AgentAnnotationsMessages;

// The builtin dictionary resolved for one locale. Fallback is explicit:
// exact locale ("zh-CN"), then the base language ("zh"), then zh-CN when the
// locale is a zh variant, then en-US. The runtime merges this as the BASE
// layer (registry, then host messages on top), so host overrides always win.
export const localeMessages = (locale: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, dict] of Object.entries(MESSAGES)) {
    const table = dict as Record<string, string>;
    out[key] = table[locale]
      ?? table[locale.split("-")[0]!]
      ?? (locale.startsWith("zh") ? table["zh-CN"] : undefined)
      ?? table["en-US"];
  }
  return out;
};
