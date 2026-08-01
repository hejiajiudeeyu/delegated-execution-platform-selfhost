import { describe, expect, it } from "vitest";

import { gatewayApiUrl, resolveGatewayBase } from "../../apps/platform-console/src/lib/gateway-url";

function loc(origin, pathname, port = "") {
  return { origin, pathname, port };
}

describe("resolveGatewayBase", () => {
  it("uses the origin root when served directly from the gateway port", () => {
    expect(resolveGatewayBase(loc("http://127.0.0.1:8085", "/", "8085"))).toBe("http://127.0.0.1:8085/");
  });

  it("uses the /gateway/ subpath behind an edge serving /console/", () => {
    expect(resolveGatewayBase(loc("https://callanything.xyz", "/console/", ""))).toBe(
      "https://callanything.xyz/gateway/"
    );
  });

  it("falls back to the default gateway url with a trailing slash", () => {
    expect(resolveGatewayBase(loc("http://localhost:5173", "/", ""), "http://127.0.0.1:8085")).toBe(
      "http://127.0.0.1:8085/"
    );
  });
});

describe("gatewayApiUrl", () => {
  it("keeps the /gateway prefix for leading-slash API paths", () => {
    expect(gatewayApiUrl("https://callanything.xyz/gateway/", "/session/setup").toString()).toBe(
      "https://callanything.xyz/gateway/session/setup"
    );
  });

  it("keeps proxy paths under the subpath base", () => {
    expect(
      gatewayApiUrl("https://callanything.xyz/gateway/", "/proxy/v1/admin/billing/tenants").toString()
    ).toBe("https://callanything.xyz/gateway/proxy/v1/admin/billing/tenants");
  });

  it("resolves against the origin root in direct mode", () => {
    expect(gatewayApiUrl("http://127.0.0.1:8085/", "/session/login").toString()).toBe(
      "http://127.0.0.1:8085/session/login"
    );
  });

  it("normalizes a base without a trailing slash", () => {
    expect(gatewayApiUrl("https://callanything.xyz/gateway", "/session/status").toString()).toBe(
      "https://callanything.xyz/gateway/session/status"
    );
  });

  it("supports query strings in API paths", () => {
    expect(
      gatewayApiUrl("https://callanything.xyz/gateway/", "/proxy/v2/hotlines?status=pending").toString()
    ).toBe("https://callanything.xyz/gateway/proxy/v2/hotlines?status=pending");
  });

  // The dev path used to pass a bare "/" as the base. `new URL()` rejects a
  // relative base, the throw was caught and classified as gateway_down, and so
  // the dev server reported "gateway unreachable" no matter what was running
  // behind it — through two console rebuilds. The base must be absolute.
  it("rejects a relative base, which is why the dev base must be an absolute origin", () => {
    expect(() => gatewayApiUrl("/", "/session")).toThrow();
    expect(gatewayApiUrl("http://127.0.0.1:5199/", "/session").toString()).toBe("http://127.0.0.1:5199/session");
  });
});
