/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { pruneRegionTargets, REGION_CANDIDATE_LIMIT, REGION_TARGET_LIMIT } from "../../src/client/inspection-engine.js";

describe("Region semantic pruning", () => {
  it("keeps semantic descendants after collecting wrapper-heavy candidates", () => {
    const candidates: Element[] = [];
    for (let index = 0; index < REGION_CANDIDATE_LIMIT / 2; index += 1) {
      const wrapper = document.createElement("div");
      const child = document.createElement("button");
      child.textContent = `Action ${index}`;
      wrapper.append(child);
      candidates.push(wrapper, child);
    }
    const started = performance.now();
    const result = pruneRegionTargets(candidates.slice(0, REGION_CANDIDATE_LIMIT)).slice(0, REGION_TARGET_LIMIT);
    console.log(`region-prune-200 durationMs=${(performance.now() - started).toFixed(3)}`);
    expect(result).toHaveLength(REGION_TARGET_LIMIT);
    expect(result.every((element) => element.tagName === "BUTTON")).toBe(true);
  });
});
