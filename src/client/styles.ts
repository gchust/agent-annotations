export const AGENT_FEEDBACK_STYLES = `
:host { all:initial; color-scheme:light; --af-accent:#6d28d9; --af-bg:#fff; --af-muted-bg:#f4f4f5; --af-border:#d4d4d8; --af-text:#18181b; --af-muted:#71717a; color:var(--af-text); font:13px/1.4 Inter,ui-sans-serif,system-ui,sans-serif; pointer-events:none; }
*,*::before,*::after { box-sizing:border-box; }
button,textarea { font:inherit; }
.af-dock { position:fixed; left:calc(50vw - 210px); bottom:20px; z-index:2147483000; display:flex; align-items:center; gap:4px; padding:6px; color:var(--af-text); background:var(--af-bg); border:1px solid var(--af-border); border-radius:14px; box-shadow:0 10px 35px #18181b26; pointer-events:auto; }
.af-dock[data-collapsed=true] .af-action:not([data-toggle=true]) { display:none; }
.af-grip,.af-action,.af-marker,.af-button { display:inline-grid; place-items:center; border:1px solid transparent; border-radius:8px; color:inherit; background:transparent; min-width:34px; min-height:34px; cursor:pointer; }
.af-grip { cursor:grab; color:var(--af-muted); }
.af-action:hover,.af-button:hover { background:var(--af-muted-bg); }
.af-action[aria-pressed=true],.af-action[aria-expanded=true] { color:#fff; background:var(--af-accent); }
.af-action:disabled,.af-button:disabled { cursor:not-allowed; opacity:.55; }
button:focus-visible,textarea:focus-visible { outline:2px solid #8b5cf6; outline-offset:2px; }
.af-icon-slot,.af-icon { display:block; }
.af-panel,.af-composer,.af-editor,.af-copy-fallback,.af-tooltip { position:fixed; z-index:2147483010; padding:12px; color:var(--af-text); background:var(--af-bg); border:1px solid var(--af-border); border-radius:12px; box-shadow:0 12px 36px #18181b2e; pointer-events:auto; }
.af-copy-fallback { inset:12px; margin:auto; width:min(640px,calc(100vw - 24px)); height:min(460px,calc(100vh - 24px)); display:grid; gap:8px; grid-template-rows:1fr auto; }
.af-copy-fallback .af-textarea { min-height:0; resize:none; }
.af-panel { left:12px; bottom:78px; width:min(360px,calc(100vw - 24px)); max-height:60vh; overflow:auto; }
.af-panel h2,.af-panel p { margin:0 0 8px; }
.af-help-list,.af-list { list-style:none; margin:0; padding:0; display:grid; gap:7px; }
.af-help-row,.af-list-item { display:flex; gap:8px; justify-content:space-between; align-items:flex-start; padding:6px; border-radius:8px; background:var(--af-muted-bg); }
.af-chip { display:inline-grid; place-items:center; min-width:22px; height:22px; padding:0 5px; border-radius:999px; background:var(--af-accent); color:white; font-weight:700; }
.af-marker { position:fixed; z-index:2147483005; min-width:28px; min-height:28px; border-radius:999px; background:var(--af-accent); color:white; font-weight:700; pointer-events:auto; }
.af-marker[data-status=completed] { background:#16a34a; }
.af-outline { position:fixed; z-index:2147483003; border:2px solid #8b5cf6; background:#7c3aed22; pointer-events:none; }
.af-outline[data-region=true] { border-style:dashed; border-color:#22d3ee; background:#22d3ee22; }
.af-composer,.af-editor { left:8px; top:8px; width:min(310px,calc(100vw - 16px)); display:grid; gap:8px; }
.af-textarea { width:100%; min-height:74px; padding:8px; resize:vertical; color:var(--af-text); background:var(--af-bg); border:1px solid var(--af-border); border-radius:8px; }
.af-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; }
.af-button { min-height:30px; padding:4px 10px; border-color:var(--af-border); }
.af-icon-button { min-width:30px; padding:4px; }
.af-primary { color:#fff; background:var(--af-accent); border-color:var(--af-accent); }
.af-primary:hover { background:#5b21b6; }
.af-danger { color:#dc2626; }
.af-danger:hover { background:#fef2f2; }
.af-tooltip { padding:5px 8px; color:#fafafa; background:#18181b; border-color:#18181b; pointer-events:none; font-size:11px; white-space:nowrap; }
.af-status { position:fixed; left:50%; bottom:76px; transform:translateX(-50%); z-index:2147483020; padding:7px 12px; border:1px solid #bbf7d0; border-radius:999px; color:#166534; background:#f0fdf4; }
.af-area { position:fixed; z-index:2147482999; border:2px dashed #22d3ee; background:#22d3ee22; pointer-events:none; }
.af-muted { color:var(--af-muted); font-size:11px; }
.af-filter { display:flex; gap:6px; margin-bottom:8px; }
`;
