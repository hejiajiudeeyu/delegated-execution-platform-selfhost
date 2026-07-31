// Every service must actually serve its observed build facts: the workspace
// drift validator (FR-082/FR-083) probes these endpoints, so a missing or
// renamed route silently blinds release certification.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { createRelayServer } from "@delexec/transport-relay";
// the gateway package declares no entry point; existing tests import by path
import { createPlatformConsoleGatewayServer } from "../../apps/platform-console-gateway/src/server.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const consoleDistIndex = path.join(repoRoot, "apps/platform-console/dist/index.html");

const BUILD_ENV = {
  DELEXEC_BUILD_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  DELEXEC_RELEASE_ID: "v0.2.0-test",
  DELEXEC_RELEASE_MANIFEST_SHA256: "a".repeat(64)
};

describe("observed build facts", () => {
  const cleanup = [];

  beforeAll(() => {
    if (!fs.existsSync(consoleDistIndex)) {
      execSync("npm run build --workspace @delexec/platform-console", { cwd: repoRoot, stdio: "inherit" });
    }
  }, 120_000);

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()();
    }
    for (const key of Object.keys(BUILD_ENV)) {
      delete process.env[key];
    }
  });

  it("platform-api reports its component, version and injected build facts", async () => {
    Object.assign(process.env, BUILD_ENV);
    const server = createPlatformServer({
      serviceName: "build-info-platform-test",
      state: createPlatformState()
    });
    const baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));

    const response = await jsonRequest(baseUrl, "/buildz");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      component: "platform-api",
      git_sha: BUILD_ENV.DELEXEC_BUILD_GIT_SHA,
      release_id: BUILD_ENV.DELEXEC_RELEASE_ID,
      manifest_sha256: BUILD_ENV.DELEXEC_RELEASE_MANIFEST_SHA256
    });
    expect(response.body.version).toBeTypeOf("string");
    expect(response.body.observed_at).toBeTypeOf("string");
  });

  it("transport-relay reports its own component identity", async () => {
    const server = createRelayServer({ serviceName: "build-info-relay-test" });
    const baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));

    const response = await jsonRequest(baseUrl, "/buildz");
    expect(response.status).toBe(200);
    expect(response.body.component).toBe("transport-relay");
    // unset facts stay null so a probe can tell "not injected" from "wrong"
    expect(response.body.git_sha).toBeNull();
  });

  it("gateway reports the console asset hash it actually serves", async () => {
    const gateway = createPlatformConsoleGatewayServer();
    const baseUrl = await listenServer(gateway);
    cleanup.push(() => closeServer(gateway));

    const response = await jsonRequest(baseUrl, "/buildz");
    expect(response.status).toBe(200);
    expect(response.body.component).toBe("platform-console-gateway");
    expect(response.body.console_asset_hash).toMatch(/^index-[A-Za-z0-9_-]+\.js$/);

    // the reported fingerprint must match the bundle index.html really links
    const indexHtml = fs.readFileSync(consoleDistIndex, "utf8");
    expect(indexHtml).toContain(response.body.console_asset_hash);
  });
});
