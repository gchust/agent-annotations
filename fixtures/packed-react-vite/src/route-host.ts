import { defineClientExtension } from "@gchust/agent-annotations/extension";

// Packed specs exercise the real Host locale API through an explicit window
// flag (defaulting to en-US); the document lang is overwritten by the fixture
// at mount time, so it cannot drive locale in this consumer.
declare global {
  interface Window {
    __AGENT_ANNOTATIONS_LOCALE?: string;
    __AGENT_ANNOTATIONS_IDENTITY_FAULT?: boolean;
  }
}

export default defineClientExtension({
  id: "route.host",
  apiVersion: 1,
  host: {
    pageContext: () => ({
      routeKey: `${location.pathname}${location.hash.split("?", 1)[0]}`,
    }),
    locale: () => window.__AGENT_ANNOTATIONS_LOCALE ?? "en-US",
    theme: () => "system",
    identity(element) {
      if (window.__AGENT_ANNOTATIONS_IDENTITY_FAULT && element.id === "target") {
        throw new Error("nocobase record identity failed");
      }
      const recordId = element.getAttribute("data-record-id");
      return recordId ? { recordId } : {};
    },
    navigate(routeKey) {
      history.pushState({}, "", routeKey);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
  },
});
