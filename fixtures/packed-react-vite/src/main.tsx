import React, { forwardRef, memo, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

import { DuplicateA } from "./duplicate-a/Card";
import { DuplicateB } from "./duplicate-b/Card";

export const MemoCard = memo(() => <button id="memo-card">Memo source</button>);
export const ForwardCard = forwardRef<HTMLButtonElement>((_, ref) => <button id="forward-card" ref={ref}>Forward source</button>);

function App() {
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
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
