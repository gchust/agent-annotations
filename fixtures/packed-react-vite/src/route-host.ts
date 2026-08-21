import { defineClientExtension } from "@gchust/agent-annotations/extension";

// Packed specs exercise the real Host locale API through an explicit window
// flag (defaulting to en-US); the document lang is overwritten by the fixture
// at mount time, so it cannot drive locale in this consumer.
declare global {
  interface Window {
    __AGENT_ANNOTATIONS_LOCALE?: string;
  }
}

export default defineClientExtension({
  id: "route.host",
  apiVersion: 1,
  host: {
    routeKey: () => `${location.pathname}${location.search}${location.hash}`,
    locale: () => window.__AGENT_ANNOTATIONS_LOCALE ?? "en-US",
    theme: () => "system",
    navigate(routeKey) {
      history.pushState({}, "", routeKey);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
  },
});
