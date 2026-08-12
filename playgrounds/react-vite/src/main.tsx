import { mountAgentFeedback, type MountedAgentFeedback } from "@gchust/agent-feedback";
import { MemoryTaskTransport } from "@gchust/agent-feedback/testing";
import React, { forwardRef, memo, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

declare global {
  interface Window {
    __agentFeedback?: MountedAgentFeedback;
    __agentFeedbackTransport?: MemoryTaskTransport;
    __unmountAgentFeedback?: () => void;
    __remountAgentFeedback?: () => Promise<void>;
  }
}

const MemoCard = memo(() => <article id="memo-card"><h2>Memo card</h2><p>Stable memoized content.</p></article>);
const ForwardButton = forwardRef<HTMLButtonElement>((_, ref) => <button id="forward-button" ref={ref}>Forward ref button</button>);

function PortalPopover() {
  const [open, setOpen] = useState(false);
  return <>
    <button id="popover-trigger" onClick={() => setOpen((value) => !value)}>Popover trigger</button>
    {open ? <div id="portal-popover" role="dialog"><button id="portal-action">Portal action</button></div> : null}
  </>;
}

function ShadowFixture() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current?.attachShadow({ mode: "open" });
    if (root) root.innerHTML = '<button id="shadow-button">Shadow button</button>';
  }, []);
  return <div id="shadow-fixture" ref={ref} />;
}

function App() {
  const forwarded = useRef<HTMLButtonElement>(null);
  return <main>
    <header><h1>Blank React/Vite playground</h1><p>No host framework is installed.</p></header>
    <section id="fixture-grid">
      <button id="plain-button">Plain button</button>
      <button id="svg-button" aria-label="SVG button"><svg viewBox="0 0 24 24" aria-hidden="true"><path id="svg-path" d="M4 12h16M12 4v16" /></svg></button>
      <button id="map-button">Map item {(["A", "B"] as const).map((item) => <span key={item}>{item}</span>)}</button>
      <MemoCard />
      <ForwardButton ref={forwarded} />
      <PortalPopover />
      <ShadowFixture />
      <canvas id="chart" width="240" height="90" aria-label="Chart canvas" />
    </section>
    <section id="long-scroll"><h2>Long scrolling page</h2>{Array.from({ length: 35 }, (_, index) => <p key={index}>Scrollable row {index + 1}</p>)}<button id="bottom-button">Bottom button</button></section>
  </main>;
}

const transport = new MemoryTaskTransport();
window.__agentFeedbackTransport = transport;
window.__remountAgentFeedback = async () => {
  window.__agentFeedback?.unmount();
  window.__agentFeedback = await mountAgentFeedback({ transport });
};
window.__unmountAgentFeedback = () => {
  window.__agentFeedback?.unmount();
  window.__agentFeedback = undefined;
};

createRoot(document.getElementById("root")!).render(<App />);
void window.__remountAgentFeedback();
