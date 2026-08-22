import { flushSync } from "react-dom";
import type { StudioPublicSnapshot } from "../../types/index.js";

export type UiChromeSnapshot = Readonly<{
  revision: number;
  snapshot: StudioPublicSnapshot;
}>;

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as object)) deepFreeze(entry);
  }
  return value;
};

export const createUiCommitCoordinator = (b: {
  payload(): StudioPublicSnapshot;
  refreshOverlays(): void;
  notifyChrome(): void;
  listeners: Set<(snapshot: StudioPublicSnapshot) => void>;
  destroyed(): boolean;
  committed(count: number): void;
}) => {
  const snapshot = (): StudioPublicSnapshot => deepFreeze(structuredClone(b.payload()));
  let current = snapshot();
  let chrome: UiChromeSnapshot = { revision: 0, snapshot: current };
  let commits = 0;
  b.committed(commits);

  const refreshChrome = (): void => {
    if (b.destroyed()) return;
    chrome = { revision: chrome.revision + 1, snapshot: current };
    flushSync(b.notifyChrome);
  };
  const commit = (): void => {
    if (b.destroyed()) return;
    b.refreshOverlays();
    current = snapshot();
    commits += 1;
    b.committed(commits);
    refreshChrome();
    for (const listener of b.listeners) listener(current);
  };
  const commitPublic = (): void => {
    if (b.destroyed()) return;
    current = snapshot();
    commits += 1;
    b.committed(commits);
    for (const listener of b.listeners) listener(current);
  };

  return {
    commit,
    commitPublic,
    refreshChrome,
    getSnapshot: () => current,
    getChromeSnapshot: () => chrome,
  };
};
