// One process-wide fetch/XHR failure patch shared by every mounted runtime:
// the first subscriber installs it (capturing the real functions), the last
// unsubscribe restores them identity-safely, and listeners only ever receive
// failures while they remain subscribed. Simultaneous or repeated mounts
// therefore never stack wrappers, and an unmounted runtime's callbacks are
// inert. Each entry keeps only method, origin+path, optional status, and the
// transport; bodies, headers, and auth never reach the listeners.
type NetworkFailure = {
  transport: "fetch" | "xhr";
  method: string;
  rawUrl: string;
  status: number | undefined;
  // A fixed, package-owned label ("network error" | "aborted" | "timeout");
  // arbitrary error text is never persisted because it could itself contain
  // a sensitive full URL or query.
  detail: string | null;
};
type NetworkFailureListener = (failure: NetworkFailure) => void;
const networkFailureListeners = new Set<NetworkFailureListener>();
// Per-XHR capture kept out of the application object: no observable property
// is ever added to XHR instances, and entries are GC'd with the instance.
const xhrCaptures = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

// Each surface (fetch, XHR open, XHR send) is owned independently: an owned
// surface is wrapped once and restored only while its own wrapper is still
// the current value. A surface replaced by a foreign wrapper stays owned (its
// own wrapper remains live underneath and keeps serving current subscribers)
// and is never wrapped again.
const networkPatchState = {
  fetch: {
    installed: false,
    original: null as typeof window.fetch | null,
    patched: null as typeof window.fetch | null,
  },
  open: {
    installed: false,
    original: null as (typeof XMLHttpRequest.prototype.open) | null,
    patched: null as (typeof XMLHttpRequest.prototype.open) | null,
  },
  send: {
    installed: false,
    original: null as (typeof XMLHttpRequest.prototype.send) | null,
    patched: null as (typeof XMLHttpRequest.prototype.send) | null,
  },
};
const installNetworkFailurePatch = (): void => {
  if (!networkPatchState.fetch.installed) {
    const originalFetch = window.fetch;
    const patchedFetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      // Only string/URL/Request are captured; an unknown input object is
      // left to native fetch untouched (never String()-converted here) and
      // simply yields no diagnostics.
      const rawUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : "";
      // init.method is only snapshotted when it is a real string; native
      // fetch handles anything else untouched.
      const method = typeof init?.method === "string"
        ? init.method.toUpperCase()
        : input instanceof Request
          ? input.method.toUpperCase()
          : "GET";
      // Snapshot the listeners at call time so a late async failure can only
      // reach the runtimes that were mounted when the request was made; it
      // can never leak into a later mount or fire after every subscriber left.
      const atCall = [...networkFailureListeners];
      const promise = originalFetch.apply(this, [input, init]);
      promise.then(
        (response) => {
          if (response.status >= 400) {
            for (const listener of atCall) {
              listener({ transport: "fetch", method, rawUrl, status: response.status, detail: null });
            }
          }
        },
        (_error: unknown) => {
          for (const listener of atCall) {
            listener({ transport: "fetch", method, rawUrl, status: undefined, detail: "network error" });
          }
        }
      );
      return promise;
    } as typeof window.fetch;
    window.fetch = patchedFetch;
    networkPatchState.fetch.installed = true;
    networkPatchState.fetch.original = originalFetch;
    networkPatchState.fetch.patched = patchedFetch;
  }
  if (!networkPatchState.open.installed) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const patchedOpen = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      // Native open runs first with the caller's exact arguments, so
      // exception/conversion count and order are unchanged. Only after it
      // succeeds is a safe bounded snapshot taken, and only for known
      // string/URL inputs and a string method.
      try {
        const result = originalOpen.apply(this, [method, url, ...rest] as Parameters<typeof XMLHttpRequest.prototype.open>);
        if (typeof method === "string" && (typeof url === "string" || url instanceof URL)) {
          xhrCaptures.set(this, {
            method: method.toUpperCase(),
            url: typeof url === "string" ? url : url.href,
          });
        }
        return result;
      } catch (error) {
        // A failed open must not leave a stale (or new) capture behind: a
        // reused instance can never diagnose a request it never opened.
        xhrCaptures.delete(this);
        throw error;
      }
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = patchedOpen;
    networkPatchState.open.installed = true;
    networkPatchState.open.original = originalOpen;
    networkPatchState.open.patched = patchedOpen;
  }
  if (!networkPatchState.send.installed) {
    const originalSend = XMLHttpRequest.prototype.send;
    const patchedSend = function (this: XMLHttpRequest, ...args: unknown[]) {
      const captured = xhrCaptures.get(this);
      // Snapshot at send time so late events are inert once this send's
      // subscribers have all unsubscribed.
      const listeners = [...networkFailureListeners];
      const report = (status: number | undefined, detail: string | null) => {
        if (!captured) return;
        for (const listener of listeners) {
          listener({ transport: "xhr", method: captured.method, rawUrl: captured.url, status, detail });
        }
      };
      // The package's own listeners are removed after the first terminal
      // event, so a reused XHR instance never retains old-request listeners
      // or double-reports.
      const terminal = (status: number | undefined, detail: string | null) => {
        report(status, detail);
        cleanup();
      };
      // loadend always removes this request's listeners (a successful request
      // must leave nothing behind for a reused instance); it only reports
      // failures.
      const onLoadEnd = () => {
        if (this.status >= 400) report(this.status, null);
        cleanup();
      };
      const onError = () => terminal(undefined, "network error");
      const onAbort = () => terminal(undefined, "aborted");
      const onTimeout = () => terminal(undefined, "timeout");
      const cleanup = () => {
        this.removeEventListener("loadend", onLoadEnd);
        this.removeEventListener("error", onError);
        this.removeEventListener("abort", onAbort);
        this.removeEventListener("timeout", onTimeout);
      };
      this.addEventListener("loadend", onLoadEnd);
      this.addEventListener("error", onError);
      this.addEventListener("abort", onAbort);
      this.addEventListener("timeout", onTimeout);
      try {
        return originalSend.apply(this, args as Parameters<typeof XMLHttpRequest.prototype.send>);
      } catch (error) {
        cleanup();
        throw error;
      }
    } as typeof XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = patchedSend;
    networkPatchState.send.installed = true;
    networkPatchState.send.original = originalSend;
    networkPatchState.send.patched = patchedSend;
  }
};
const uninstallNetworkFailurePatch = (): void => {
  // Restore each original independently, and only while that surface still
  // holds our own wrapper. A surface replaced by a foreign wrapper stays
  // owned (its own wrapper remains live underneath and keeps serving current
  // subscribers) and is never wrapped again on a later subscribe.
  if (networkPatchState.fetch.installed && window.fetch === networkPatchState.fetch.patched) {
    window.fetch = networkPatchState.fetch.original!;
    networkPatchState.fetch.installed = false;
    networkPatchState.fetch.original = null;
    networkPatchState.fetch.patched = null;
  }
  if (networkPatchState.open.installed && XMLHttpRequest.prototype.open === networkPatchState.open.patched) {
    XMLHttpRequest.prototype.open = networkPatchState.open.original!;
    networkPatchState.open.installed = false;
    networkPatchState.open.original = null;
    networkPatchState.open.patched = null;
  }
  if (networkPatchState.send.installed && XMLHttpRequest.prototype.send === networkPatchState.send.patched) {
    XMLHttpRequest.prototype.send = networkPatchState.send.original!;
    networkPatchState.send.installed = false;
    networkPatchState.send.original = null;
    networkPatchState.send.patched = null;
  }
};
export const subscribeNetworkFailures = (listener: NetworkFailureListener): (() => void) => {
  if (networkFailureListeners.size === 0) installNetworkFailurePatch();
  networkFailureListeners.add(listener);
  return () => {
    networkFailureListeners.delete(listener);
    if (networkFailureListeners.size === 0) uninstallNetworkFailurePatch();
  };
};
