export const AGENT_FEEDBACK_STYLES = `
:host { all: initial; color-scheme: dark; --af-accent:#7c3aed; font:13px/1.4 Inter,ui-sans-serif,system-ui,sans-serif; }
*,*::before,*::after { box-sizing:border-box; }
button,textarea { font:inherit; }
.af-dock { position:fixed; left:calc(50vw - 210px); bottom:20px; z-index:2147483000; display:flex; align-items:center; gap:4px; padding:6px; color:#fafafa; background:#18181b; border:1px solid #3f3f46; border-radius:14px; box-shadow:0 10px 35px #0008; }
.af-dock[data-collapsed=true] .af-action:not([data-toggle=true]) { display:none; }
.af-grip,.af-action,.af-marker,.af-button { border:1px solid transparent; border-radius:8px; color:inherit; background:transparent; min-width:34px; min-height:34px; cursor:pointer; }
.af-grip { cursor:grab; color:#a1a1aa; }
.af-action:hover,.af-button:hover { background:#3f3f46; }
.af-action[aria-pressed=true],.af-action[aria-expanded=true] { background:var(--af-accent); }
button:focus-visible,textarea:focus-visible { outline:2px solid #a78bfa; outline-offset:2px; }
.af-panel,.af-composer,.af-editor,.af-copy-fallback,.af-tooltip { position:fixed; z-index:2147483010; padding:12px; color:#fafafa; background:#18181b; border:1px solid #3f3f46; border-radius:12px; box-shadow:0 12px 36px #0009; }
.af-copy-fallback { inset:12px; margin:auto; width:min(640px,calc(100vw - 24px)); height:min(460px,calc(100vh - 24px)); display:grid; gap:8px; grid-template-rows:1fr auto; }
.af-copy-fallback .af-textarea { min-height:0; resize:none; }
.af-panel { left:12px; bottom:78px; width:min(360px,calc(100vw - 24px)); max-height:60vh; overflow:auto; }
.af-panel h2,.af-panel p { margin:0 0 8px; }
.af-help-list,.af-list { list-style:none; margin:0; padding:0; display:grid; gap:7px; }
.af-help-row,.af-list-item { display:flex; gap:8px; justify-content:space-between; align-items:flex-start; padding:6px; border-radius:8px; background:#27272a; }
.af-chip { display:inline-grid; place-items:center; min-width:22px; height:22px; padding:0 5px; border-radius:999px; background:var(--af-accent); color:white; font-weight:700; }
.af-marker { position:fixed; z-index:2147483005; min-width:28px; min-height:28px; border-radius:999px; background:var(--af-accent); color:white; font-weight:700; }
.af-marker[data-status=completed] { background:#16a34a; }
.af-outline { position:fixed; z-index:2147483003; border:2px solid #a78bfa; background:#7c3aed22; pointer-events:none; }
.af-outline[data-region=true] { border-style:dashed; border-color:#22d3ee; background:#22d3ee22; }
.af-composer,.af-editor { width:min(310px,calc(100vw - 16px)); display:grid; gap:8px; }
.af-composer { right:8px; top:8px; }
.af-editor { left:8px; top:8px; }
.af-textarea { width:100%; min-height:74px; padding:8px; resize:vertical; color:#fafafa; background:#27272a; border:1px solid #52525b; border-radius:8px; }
.af-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; }
.af-button { min-height:30px; padding:4px 10px; border-color:#52525b; }
.af-primary { background:var(--af-accent); border-color:var(--af-accent); }
.af-danger { color:#f87171; }
.af-tooltip { padding:5px 8px; pointer-events:none; font-size:11px; white-space:nowrap; }
.af-status { position:fixed; left:50%; bottom:76px; transform:translateX(-50%); z-index:2147483020; padding:7px 12px; border-radius:999px; color:#86efac; background:#18181b; }
.af-area { position:fixed; z-index:2147482999; border:2px dashed #22d3ee; background:#22d3ee22; pointer-events:none; }
.af-muted { color:#a1a1aa; font-size:11px; }
.af-filter { display:flex; gap:6px; margin-bottom:8px; }
`;
