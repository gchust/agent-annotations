import React, { forwardRef, memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

import { RouteA } from "./route-a/RouteA";
import { RouteB } from "./route-b/RouteB";
import { DuplicateA } from "./duplicate-a/Card";
import { DuplicateB } from "./duplicate-b/Card";

export const MemoCard = memo(() => <button id="memo-card">Memo source</button>);
export const ForwardCard = forwardRef<HTMLButtonElement>((_, ref) => <button id="forward-card" ref={ref}>Forward source</button>);

function RealmFixtures() {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const setup = () => {
      const outer = frame.current?.contentDocument;
      if (!outer?.body) return;
      outer.body.innerHTML = '<iframe id="nested-frame" srcdoc="<button id=\'nested-target\'>Nested target</button>"></iframe><div id="frame-shadow"></div>';
      outer.querySelector("#frame-shadow")!.attachShadow({ mode: "open" }).innerHTML =
        '<button id="frame-shadow-target">Frame shadow target</button>';
      const nested = outer.querySelector<HTMLIFrameElement>("#nested-frame")!;
      const ready = () => { frame.current!.dataset.ready = "true"; };
      if (nested.contentDocument?.readyState === "complete") ready();
      else nested.addEventListener("load", ready, { once: true });
    };
    const element = frame.current;
    element?.addEventListener("load", setup, { once: true });
    setup();
    return () => element?.removeEventListener("load", setup);
  }, []);
  return <section id="realm-fixtures"><iframe id="same-origin-frame" ref={frame} srcDoc="<!doctype html><body></body>" />
    <iframe id="cross-origin-frame" src="data:text/html,%3Cbutton%3ECross-origin%3C/button%3E" />
  </section>;
}

function ReliabilityFixtures() {
  const [dynamic, setDynamic] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setDynamic((value) => value + 1), 100);
    return () => window.clearInterval(timer);
  }, []);
  return <>
    <style>{"@keyframes fixture-pulse { from { opacity: .7 } to { opacity: 1 } }"}</style>
    <div id="spacer" style={{ height: 1400 }} />
    <article id="screenshot-card" style={{ backgroundColor: "rgb(12, 34, 56)", color: "white", font: "700 22px/1.4 sans-serif", padding: 24, border: "3px solid rgb(200, 80, 30)" }}>
      <img id="screenshot-image" width="32" height="24" alt="fixture" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='24'/%3E" />
      <canvas id="screenshot-canvas" width="32" height="24" />
      <iframe id="screenshot-frame" title="Screenshot media" width="48" height="24" srcDoc="<span>Frame media</span>" />
      <span id="after-media">After media</span>
    </article>
    <button id="popover-toggle" popoverTarget="fixture-popover">Open popover</button>
    <div id="fixture-popover" popover="auto">Popover content</div>
    <div id="animated-target" style={{ animation: "fixture-pulse 100ms infinite alternate" }}>Animated target</div>
    <button id="dynamic-target">Dynamic {dynamic}</button>
    <div id="wrapper-fixture" style={{ position: "relative", width: 400, height: 240 }}>
      {Array.from({ length: 70 }, (_, index) => <div className="wrapper" key={index} style={{ position: "absolute", inset: 0 }} />)}
      <button id="semantic-region-target" aria-label="Semantic target" style={{ position: "absolute", inset: 0, margin: "auto", width: 120, height: 44 }}>Save</button>
    </div>
  </>;
}

// Static fixture kept outside the re-rendering ReliabilityFixtures so the capture
// sanitization never mutates the live DOM during the dynamic marker refresh window.
function PrivacyFixtures() {
  return <div id="privacy-fixture" style={{ display: "flex", gap: 12, padding: 16, background: "rgb(240, 240, 240)" }}>
    <input id="privacy-input" defaultValue="SENTINEL_INPUT" style={{ width: 160, height: 32, background: "rgb(220, 40, 40)" }} />
    <input id="privacy-password" type="password" defaultValue="SENTINEL_PASSWORD" style={{ width: 160, height: 32, background: "rgb(40, 180, 40)" }} />
    <textarea id="privacy-textarea" defaultValue="SENTINEL_AREA" style={{ width: 200, height: 64, background: "rgb(40, 40, 220)" }} />
    <div id="privacy-editable" contentEditable style={{ width: 160, height: 48, background: "rgb(220, 180, 40)" }} dangerouslySetInnerHTML={{ __html: "SENTINEL_EDITABLE" }} />
    <button id="privacy-capture-target" style={{ width: 120, height: 48, background: "rgb(200, 200, 200)" }}>Capture</button>
  </div>;
}

function Home() {
  const [portal, setPortal] = useState(false);
  return <main>
    <h1>Packed fixture</h1>
    <button id="target" data-demo-kind="packed">Target button</button>
    <DuplicateA />
    <DuplicateB />
    <MemoCard />
    <ForwardCard />
    <button id="portal-toggle" onClick={() => setPortal(true)}>Open Portal target</button>
    {portal ? createPortal(<button id="portal-target">Portal target</button>, document.body) : null}
    <RealmFixtures />
    <PrivacyFixtures />
    <ReliabilityFixtures />
  </main>;
}

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onChange = () => setPath(location.pathname);
    window.addEventListener("popstate", onChange);
    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("popstate", onChange);
      window.removeEventListener("hashchange", onChange);
    };
  }, []);
  if (path === "/route-a") return <RouteA />;
  if (path === "/route-b") return <RouteB />;
  return <Home />;
}

createRoot(document.getElementById("root")!).render(<App />);
