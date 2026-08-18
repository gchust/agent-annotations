export const AGENT_ANNOTATIONS_STYLES = `
:host { all:initial; color-scheme:light; --aa-accent:#6d28d9; --aa-accent-hover:#5b21b6; --aa-bg:#ffffff; --aa-muted-bg:#f4f4f5; --aa-border:#d4d4d8; --aa-text:#18181b; --aa-muted:#6b6b74; --aa-danger:#b91c1c; --aa-danger-bg:#fef2f2; --aa-tooltip-bg:#18181b; --aa-tooltip-text:#fafafa; --aa-status-bg:#f0fdf4; --aa-status-border:#bbf7d0; --aa-status-text:#166534; color:var(--aa-text); font:13px/1.4 Inter,ui-sans-serif,system-ui,sans-serif; pointer-events:none; }
:host([data-theme=dark]) { color-scheme:dark; --aa-bg:#18181b; --aa-muted-bg:#27272a; --aa-border:#3f3f46; --aa-text:#fafafa; --aa-muted:#a1a1aa; --aa-danger:#f87171; --aa-danger-bg:#450a0a; --aa-tooltip-bg:#fafafa; --aa-tooltip-text:#18181b; --aa-status-bg:#052e16; --aa-status-border:#166534; --aa-status-text:#bbf7d0; }
*,*::before,*::after { box-sizing:border-box; }
button,textarea { font:inherit; }
.aa-dock { position:fixed; left:calc(50vw - 210px); bottom:20px; z-index:2147483000; display:flex; align-items:center; gap:4px; padding:6px; color:var(--aa-text); background:var(--aa-bg); border:1px solid var(--aa-border); border-radius:14px; box-shadow:0 10px 35px #18181b26; pointer-events:auto; }
.aa-dock[data-collapsed=true] .aa-action:not([data-toggle=true]) { display:none; }
.aa-grip,.aa-action,.aa-marker,.aa-button { display:inline-grid; place-items:center; border:1px solid transparent; border-radius:8px; color:inherit; background:transparent; min-width:34px; min-height:34px; cursor:pointer; }
.aa-grip { cursor:grab; color:var(--aa-muted); }
.aa-action:hover,.aa-button:hover { background:var(--aa-muted-bg); }
.aa-action[aria-pressed=true],.aa-action[aria-expanded=true] { color:#fff; background:var(--aa-accent); }
.aa-action:disabled,.aa-button:disabled { cursor:not-allowed; opacity:.55; }
button:focus-visible,textarea:focus-visible { outline:2px solid #8b5cf6; outline-offset:2px; }
.aa-icon-slot,.aa-icon { display:block; }
.aa-panel,.aa-composer,.aa-editor,.aa-copy-fallback,.aa-tooltip { position:fixed; z-index:2147483010; padding:12px; color:var(--aa-text); background:var(--aa-bg); border:1px solid var(--aa-border); border-radius:12px; box-shadow:0 12px 36px #18181b2e; pointer-events:auto; }
.aa-copy-fallback { inset:12px; margin:auto; width:min(640px,calc(100vw - 24px)); height:min(460px,calc(100vh - 24px)); display:grid; gap:8px; grid-template-rows:1fr auto; }
.aa-copy-fallback .aa-textarea { min-height:0; resize:none; }
.aa-panel { left:12px; bottom:78px; width:min(360px,calc(100vw - 24px)); max-height:60vh; overflow:auto; }
.aa-panel h2,.aa-panel p { margin:0 0 8px; }
.aa-help-list,.aa-list { list-style:none; margin:0; padding:0; display:grid; gap:7px; }
.aa-help-row,.aa-list-item { display:flex; gap:8px; justify-content:space-between; align-items:flex-start; padding:6px; border-radius:8px; background:var(--aa-muted-bg); }
.aa-chip { display:inline-grid; place-items:center; min-width:22px; height:22px; padding:0 5px; border-radius:999px; background:var(--aa-accent); color:white; font-weight:700; }
.aa-marker { position:fixed; z-index:2147483005; min-width:28px; min-height:28px; border-radius:999px; background:var(--aa-accent); color:white; font-weight:700; pointer-events:auto; }
.aa-marker[data-status=completed] { background:#16a34a; }
.aa-outline { position:fixed; z-index:2147483003; border:2px solid #8b5cf6; background:#7c3aed22; pointer-events:none; }
.aa-outline[data-region=true] { border-style:dashed; border-color:#22d3ee; background:#22d3ee22; }
.aa-composer,.aa-editor { left:8px; top:8px; width:min(310px,calc(100vw - 16px)); display:grid; gap:8px; }
.aa-textarea { width:100%; min-height:74px; padding:8px; resize:vertical; color:var(--aa-text); background:var(--aa-bg); border:1px solid var(--aa-border); border-radius:8px; }
.aa-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; }
.aa-button { min-height:30px; padding:4px 10px; border-color:var(--aa-border); }
.aa-icon-button { min-width:30px; padding:4px; }
.aa-primary { color:#fff; background:var(--aa-accent); border-color:var(--aa-accent); }
.aa-primary:hover { background:var(--aa-accent-hover); }
.aa-danger { color:var(--aa-danger); }
.aa-danger:hover { background:var(--aa-danger-bg); }
.aa-tooltip { padding:5px 8px; color:var(--aa-tooltip-text); background:var(--aa-tooltip-bg); border-color:var(--aa-tooltip-bg); pointer-events:none; font-size:11px; white-space:nowrap; }
.aa-status { position:fixed; left:50%; bottom:76px; transform:translateX(-50%); z-index:2147483020; padding:7px 12px; border:1px solid var(--aa-status-border); border-radius:999px; color:var(--aa-status-text); background:var(--aa-status-bg); }
.aa-area { position:fixed; z-index:2147482999; border:2px dashed #22d3ee; background:#22d3ee22; pointer-events:none; }
.aa-muted { color:var(--aa-muted); font-size:11px; }
.aa-filter { display:flex; gap:6px; margin-bottom:8px; }
`;
