import { describe, expect, it } from "vitest";

import { BUILD_INFO_ENV_KEYS, buildInfoPayload, readPackageVersion } from "@delexec/build-info";

describe("build-info observed facts", () => {
  it("reports every declared fact from the environment", () => {
    const payload = buildInfoPayload({
      component: "platform-api",
      version: "0.1.0",
      env: {
        [BUILD_INFO_ENV_KEYS.gitSha]: "abc123",
        [BUILD_INFO_ENV_KEYS.imageDigest]: "sha256:deadbeef",
        [BUILD_INFO_ENV_KEYS.builtAt]: "2026-07-31T00:00:00.000Z",
        [BUILD_INFO_ENV_KEYS.releaseId]: "v0.2.0",
        [BUILD_INFO_ENV_KEYS.manifestSha256]: "f".repeat(64)
      }
    });

    expect(payload).toMatchObject({
      component: "platform-api",
      version: "0.1.0",
      git_sha: "abc123",
      image_digest: "sha256:deadbeef",
      built_at: "2026-07-31T00:00:00.000Z",
      release_id: "v0.2.0",
      manifest_sha256: "f".repeat(64)
    });
    expect(typeof payload.observed_at).toBe("string");
  });

  it("reports unset and blank facts as null instead of guessing", () => {
    const payload = buildInfoPayload({
      component: "transport-relay",
      env: { [BUILD_INFO_ENV_KEYS.gitSha]: "   " }
    });

    expect(payload.git_sha).toBeNull();
    expect(payload.image_digest).toBeNull();
    expect(payload.release_id).toBeNull();
    expect(payload.manifest_sha256).toBeNull();
    expect(payload.version).toBeNull();
  });

  it("merges component-specific facts such as the console asset hash", () => {
    const payload = buildInfoPayload({
      component: "platform-console-gateway",
      env: {},
      extra: { console_asset_hash: "index-DoU8e5Gd.js" }
    });

    expect(payload.console_asset_hash).toBe("index-DoU8e5Gd.js");
  });

  it("normalizes undefined extras to null so probes see a stable shape", () => {
    const payload = buildInfoPayload({
      component: "platform-console-gateway",
      env: {},
      extra: { console_asset_hash: undefined }
    });

    expect(payload).toHaveProperty("console_asset_hash", null);
  });

  it("requires a component name", () => {
    expect(() => buildInfoPayload({ env: {} })).toThrow(/component/);
  });

  it("reads the owning package version and never throws on a bad url", () => {
    expect(readPackageVersion(import.meta.url)).toBeTypeOf("string");
    expect(readPackageVersion("file:///nonexistent/deeply/missing/module.js")).toBeNull();
  });
});
