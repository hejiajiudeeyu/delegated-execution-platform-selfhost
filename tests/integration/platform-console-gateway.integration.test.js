import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { createPlatformConsoleGatewayServer } from "../../apps/platform-console-gateway/src/server.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

describe("platform console gateway integration", () => {
  const cleanupDirs = [];

  afterEach(() => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.DELEXEC_HOME;
    delete process.env.PLATFORM_API_BASE_URL;
    delete process.env.PLATFORM_CONSOLE_BOOTSTRAP_SECRET;
  });

  it("stores admin credentials in the encrypted local secret store and proxies admin requests", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "platform-console-gateway-"));
    cleanupDirs.push(opsHome);
    process.env.DELEXEC_HOME = opsHome;

    const adminApiKey = "sk_admin_integration_test";
    const platformState = createPlatformState({ adminApiKey, bootstrapEnabled: true });
    const platformServer = createPlatformServer({
      serviceName: "platform-console-gateway-test",
      state: platformState
    });
    const platformUrl = await listenServer(platformServer);
    process.env.PLATFORM_API_BASE_URL = platformUrl;

    const gateway = createPlatformConsoleGatewayServer();
    const gatewayUrl = await listenServer(gateway);

    try {
      const consoleResponse = await fetch(`${gatewayUrl}/`);
      expect(consoleResponse.status).toBe(200);
      expect(await consoleResponse.text()).toContain("Platform Control");

      const sessionBefore = await jsonRequest(gatewayUrl, "/session");
      expect(sessionBefore.status).toBe(200);
      expect(sessionBefore.body.session.setup_required).toBe(true);

      const setup = await jsonRequest(gatewayUrl, "/session/setup", {
        method: "POST",
        body: { passphrase: "local-passphrase" }
      });
      expect(setup.status).toBe(201);
      const headers = {
        "X-Platform-Console-Session": setup.body.token
      };

      const saved = await jsonRequest(gatewayUrl, "/credentials/platform-admin", {
        method: "PUT",
        headers,
        body: {
          base_url: platformUrl,
          api_key: adminApiKey
        }
      });
      expect(saved.status).toBe(200);
      expect(saved.body.api_key_configured).toBe(true);

      const current = await jsonRequest(gatewayUrl, "/credentials/platform-admin", {
        headers
      });
      expect(current.status).toBe(200);
      expect(current.body.platform_url).toBe(platformUrl);
      expect(current.body.api_key_configured).toBe(true);

      const responders = await jsonRequest(gatewayUrl, "/proxy/v2/admin/responders", {
        headers
      });
      expect(responders.status).toBe(200);
      expect(Array.isArray(responders.body.items)).toBe(true);
      expect(responders.body.items.length).toBeGreaterThan(0);

      const logout = await jsonRequest(gatewayUrl, "/session/logout", {
        method: "POST",
        headers,
        body: {}
      });
      expect(logout.status).toBe(200);

      const denied = await jsonRequest(gatewayUrl, "/credentials/platform-admin");
      expect(denied.status).toBe(401);
    } finally {
      await closeServer(gateway);
      await closeServer(platformServer);
    }
  });

  it("requires a bootstrap secret for non-local initial setup and accepts it when provided", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "platform-console-gateway-secret-"));
    cleanupDirs.push(opsHome);
    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_CONSOLE_BOOTSTRAP_SECRET = "bootstrap-secret-test";

    const gateway = createPlatformConsoleGatewayServer();
    const gatewayUrl = await listenServer(gateway);

    try {
      const denied = await jsonRequest(gatewayUrl, "/session/setup", {
        method: "POST",
        headers: {
          "X-Forwarded-For": "203.0.113.10"
        },
        body: { passphrase: "public-passphrase" }
      });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("AUTH_BOOTSTRAP_FORBIDDEN");

      const allowed = await jsonRequest(gatewayUrl, "/session/setup", {
        method: "POST",
        headers: {
          "X-Forwarded-For": "203.0.113.10",
          "X-Platform-Console-Bootstrap-Secret": "bootstrap-secret-test"
        },
        body: { passphrase: "public-passphrase" }
      });
      expect(allowed.status).toBe(201);
      expect(typeof allowed.body.token).toBe("string");
    } finally {
      await closeServer(gateway);
    }
  });
});
