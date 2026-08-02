import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { createPlatformConsoleGatewayServer } from "../../apps/platform-console-gateway/src/server.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const consoleDistIndex = path.join(repoRoot, "apps/platform-console/dist/index.html");

describe("platform console gateway integration", () => {
  const cleanupDirs = [];

  // the gateway serves the built SPA; a fresh checkout (CI) has no dist yet
  beforeAll(() => {
    if (!fs.existsSync(consoleDistIndex)) {
      execSync("npm run build --workspace @delexec/platform-console", { cwd: repoRoot, stdio: "inherit" });
    }
  }, 120_000);

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
      // built SPA: index.html references a content-fingerprinted bundle
      const assetMatch = consoleHtml.match(/src="\.\/(assets\/index-[^"]+\.js)"/);
      expect(assetMatch).toBeTruthy();
      expect(consoleResponse.headers.get("cache-control")).toContain("no-cache");

      const bundleResponse = await fetch(`${gatewayUrl}/${assetMatch[1]}`);
      expect(bundleResponse.status).toBe(200);
      expect(bundleResponse.headers.get("content-type")).toContain("javascript");
      expect(bundleResponse.headers.get("cache-control")).toContain("immutable");

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

  // A failed unlock always fails inside AES-GCM, and Node words that as
  // "Unsupported state or unable to authenticate data". Returning that
  // verbatim made a correct rejection read as a broken gateway, and cost real
  // debugging time chasing a verifier that was working.
  it("explains a failed unlock instead of leaking the decryption error", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "platform-console-gateway-unlock-"));
    cleanupDirs.push(opsHome);
    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_CONSOLE_BOOTSTRAP_SECRET = "deploy-key-not-a-passphrase";

    const gateway = createPlatformConsoleGatewayServer();
    const gatewayUrl = await listenServer(gateway);

    try {
      const created = await jsonRequest(gatewayUrl, "/session/setup", {
        method: "POST",
        headers: { "X-Platform-Console-Bootstrap-Secret": "deploy-key-not-a-passphrase" },
        body: { passphrase: "the-real-passphrase" }
      });
      expect(created.status).toBe(201);

      const wrong = await jsonRequest(gatewayUrl, "/session/login", {
        method: "POST",
        body: { passphrase: "some-other-passphrase" }
      });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe("AUTH_INVALID_PASSPHRASE");
      expect(wrong.body.error.message).not.toMatch(/unable to authenticate data/i);

      // The deployment key in the passphrase box is a predictable mix-up —
      // both are long opaque strings and the reset link sits right below the
      // unlock field — so it gets its own answer rather than "wrong password".
      const mixedUp = await jsonRequest(gatewayUrl, "/session/login", {
        method: "POST",
        body: { passphrase: "deploy-key-not-a-passphrase" }
      });
      expect(mixedUp.status).toBe(401);
      expect(mixedUp.body.error.code).toBe("AUTH_BOOTSTRAP_SECRET_IS_NOT_PASSPHRASE");
      expect(mixedUp.body.error.message).not.toMatch(/unable to authenticate data/i);

      const right = await jsonRequest(gatewayUrl, "/session/login", {
        method: "POST",
        body: { passphrase: "the-real-passphrase" }
      });
      expect(right.status).toBe(200);
      expect(typeof right.body.token).toBe("string");
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
