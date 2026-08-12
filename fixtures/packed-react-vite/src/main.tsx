import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main><h1>Packed fixture</h1><button id="target">Target button</button></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
