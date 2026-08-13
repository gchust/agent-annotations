import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <main>
      <h1>External Extension Demo</h1>
      <button id="demo-target" data-demo-kind="primary">Demo target</button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
