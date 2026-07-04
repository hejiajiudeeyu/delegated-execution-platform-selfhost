import { describe, expect, it } from "vitest";

import { classify, derivePhase } from "../../apps/platform-console/src/lib/api";

describe("api result classification", () => {
  it("classifies 401/403 as auth failures", () => {
    expect(classify(401, { error: { code: "AUTH_UNAUTHORIZED", message: "API key is missing or invalid" } }, "x").failure).toBe("auth");
    expect(classify(403, { error: {} }, "x").failure).toBe("auth");
  });

  it("classifies gateway-layer outages as gateway_down", () => {
    for (const status of [0, 502, 503, 504]) {
      expect(classify(status, null).failure).toBe("gateway_down");
    }
  });

  it("classifies other 4xx/5xx as http_error and extracts the human message", () => {
    const result = classify(400, { error: { code: "VALIDATION_FAILED", message: "Type RESET to confirm the destructive reset." } }, "x");
    expect(result.failure).toBe("http_error");
    expect(result.message).toContain("RESET");
    expect(result.ok).toBe(false);
  });

  it("treats 2xx as ok with no failure", () => {
    const result = classify(200, { items: [] }, "x");
    expect(result.ok).toBe(true);
    expect(result.failure).toBe("none");
  });
});

describe("session phase derivation (gateway /session envelope)", () => {
  const wrap = (status, body) => classify(status, body, "x");
  const fakeStorage = () => {
    const store = new Map();
    globalThis.sessionStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear()
    };
    return store;
  };

  it("maps gateway outage to unreachable", () => {
    expect(derivePhase(wrap(503, null))).toBe("unreachable");
  });

  it("maps setup_required to setup", () => {
    expect(derivePhase(wrap(200, { ok: true, session: { setup_required: true } }))).toBe("setup");
  });

  it("maps unauthenticated (or token-less) sessions to locked", () => {
    fakeStorage();
    expect(derivePhase(wrap(200, { ok: true, session: { setup_required: false, authenticated: false } }))).toBe("locked");
    // authenticated by the gateway but no local token -> still locked
    expect(derivePhase(wrap(200, { ok: true, session: { setup_required: false, authenticated: true } }))).toBe("locked");
  });

  it("maps authenticated + local token to unlocked", () => {
    const store = fakeStorage();
    store.set("platform.console.session", "tok_x");
    expect(derivePhase(wrap(200, { ok: true, session: { setup_required: false, authenticated: true } }))).toBe("unlocked");
  });
});
