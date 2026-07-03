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
      const consoleHtml = await consoleResponse.text();
      expect(consoleHtml).toContain("Platform Console");
      expect(consoleHtml).toContain('id="app"');
      expect(consoleHtml).toContain('src="./src/main.js"');
      expect(consoleHtml).not.toContain("/src/main.tsx");

      const mainJsResponse = await fetch(`${gatewayUrl}/src/main.js`);
      expect(mainJsResponse.status).toBe(200);
      expect(mainJsResponse.headers.get("content-type")).toContain("javascript");

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

  it("recovers a lost gateway passphrase through bootstrap secret without preserving admin credentials", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "platform-console-gateway-recover-"));
    cleanupDirs.push(opsHome);
    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_CONSOLE_BOOTSTRAP_SECRET = "recover-bootstrap-secret";

    const gateway = createPlatformConsoleGatewayServer();
    const gatewayUrl = await listenServer(gateway);

    try {
      const setup = await jsonRequest(gatewayUrl, "/session/setup", {
        method: "POST",
        headers: {
          "X-Platform-Console-Bootstrap-Secret": "recover-bootstrap-secret"
        },
        body: { passphrase: "original-passphrase" }
      });
      expect(setup.status).toBe(201);
      const originalHeaders = {
        "X-Platform-Console-Session": setup.body.token
      };

      const saved = await jsonRequest(gatewayUrl, "/credentials/platform-admin", {
        method: "PUT",
        headers: originalHeaders,
        body: {
          base_url: "http://127.0.0.1:8080",
          api_key: "sk_admin_recovery_test"
        }
      });
      expect(saved.status).toBe(200);
      expect(saved.body.api_key_configured).toBe(true);

      const missingSecret = await jsonRequest(gatewayUrl, "/session/recover", {
        method: "POST",
        headers: {
          "X-Forwarded-For": "203.0.113.10"
        },
        body: {
          passphrase: "replacement-passphrase",
          confirm_reset: true
        }
      });
      expect(missingSecret.status).toBe(403);
      expect(missingSecret.body.error.code).toBe("AUTH_BOOTSTRAP_FORBIDDEN");

      const missingConfirmation = await jsonRequest(gatewayUrl, "/session/recover", {
        method: "POST",
        headers: {
          "X-Forwarded-For": "203.0.113.10",
          "X-Platform-Console-Bootstrap-Secret": "recover-bootstrap-secret"
        },
        body: {
          passphrase: "replacement-passphrase"
        }
      });
      expect(missingConfirmation.status).toBe(400);
      expect(missingConfirmation.body.error.code).toBe("AUTH_RESET_CONFIRMATION_REQUIRED");

      const recovered = await jsonRequest(gatewayUrl, "/session/recover", {
        method: "POST",
        headers: {
          "X-Forwarded-For": "203.0.113.10",
          "X-Platform-Console-Bootstrap-Secret": "recover-bootstrap-secret"
        },
        body: {
          passphrase: "replacement-passphrase",
          confirm_reset: true
        }
      });
      expect(recovered.status).toBe(200);
      expect(recovered.body.recovered).toBe(true);
      expect(typeof recovered.body.token).toBe("string");
      expect(recovered.body.session.authenticated).toBe(true);
      expect(recovered.body.session.admin_api_key_configured).toBe(false);

      const oldTokenDenied = await jsonRequest(gatewayUrl, "/credentials/platform-admin", {
        headers: originalHeaders
      });
      expect(oldTokenDenied.status).toBe(401);

      const oldPassphrase = await jsonRequest(gatewayUrl, "/session/login", {
        method: "POST",
        body: { passphrase: "original-passphrase" }
      });
      expect(oldPassphrase.status).toBe(401);

      const newHeaders = {
        "X-Platform-Console-Session": recovered.body.token
      };
      const current = await jsonRequest(gatewayUrl, "/credentials/platform-admin", {
        headers: newHeaders
      });
      expect(current.status).toBe(200);
      expect(current.body.api_key_configured).toBe(false);
    } finally {
      await closeServer(gateway);
    }
  });
});
