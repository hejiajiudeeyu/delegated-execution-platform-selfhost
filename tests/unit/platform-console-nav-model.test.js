import { describe, expect, it } from "vitest";
import {
  CONSOLE_NAV,
  DEFAULT_PANEL,
  findNavLeaf,
  findNavLeafBySection,
  flattenNavLeaves,
  panelMeta,
  renderSidebarMarkup
} from "../../apps/platform-console/src/nav-model.js";

describe("platform-console nav model", () => {
  it("flattens grouped navigation leaves", () => {
    const leaves = flattenNavLeaves();
    expect(leaves.some((leaf) => leaf.panel === "responders")).toBe(true);
    expect(leaves.some((leaf) => leaf.panel === "session")).toBe(true);
    expect(leaves.length).toBeGreaterThan(CONSOLE_NAV.length);
  });

  it("resolves panel and section lookups", () => {
    expect(findNavLeaf("billing")?.label).toBe("Billing");
    expect(findNavLeafBySection("reviews")?.panel).toBe("reviews");
    expect(findNavLeaf(DEFAULT_PANEL)?.panel).toBe("overview");
  });

  it("renders sidebar markup with active and disabled states", () => {
    const markup = renderSidebarMarkup({
      activePanel: "reviews",
      expandedGroups: new Set(["operations"]),
      dataReady: false
    });
    expect(markup).toContain('data-nav-panel="reviews"');
    expect(markup).toContain("is-active");
    expect(markup).toContain('data-nav-panel="session"');
    expect(markup).not.toContain('data-nav-panel="session" is-disabled');
  });

  it("returns panel metadata", () => {
    expect(panelMeta("session").title).toBe("Session & Unlock");
    expect(panelMeta("unknown").title).toBe("Platform Console");
  });
});
