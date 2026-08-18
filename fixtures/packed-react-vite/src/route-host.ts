import { defineClientExtension } from "@gchust/agent-annotations/extension";

export default defineClientExtension({
  id: "route.host",
  apiVersion: 1,
  host: {
    routeKey: () => `${location.pathname}${location.search}${location.hash}`,
    navigate(routeKey) {
      history.pushState({}, "", routeKey);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
  },
});
