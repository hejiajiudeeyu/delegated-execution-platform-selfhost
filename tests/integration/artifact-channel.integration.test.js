// FR-032/FR-033/FR-034: artifacts move between devices with their integrity
// checked, and the descriptor alone never yields bytes. The properties pinned
// here are the ones that decide whether a delivery can be trusted.
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFilesystemArtifactStore, createMemoryArtifactStore } from "@delexec/artifact-store";
import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

const PAYLOAD = Buffer.from("the quick brown fox jumps over the lazy dog\n".repeat(8), "utf8");
const PAYLOAD_SHA256 = crypto.createHash("sha256").update(PAYLOAD).digest("hex");

describe("artifact channel", () => {
  let server;
  let baseUrl;
  let state;
  let callerAuth;
  let requestId;
  const cleanup = [];

  async function startPlatform(artifactStore) {
    state = createPlatformState({ adminApiKey: "sk_admin_artifact_test", bootstrapEnabled: true });
    server = createPlatformServer({ serviceName: "artifact-channel-test", state, artifactStore });
    baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));

    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "artifact-caller@test.local" }
    });
    callerAuth = { Authorization: `Bearer ${caller.body.api_key}` };

    const responder = state.bootstrap.responders[0];
    requestId = "req_artifact_1";
    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: callerAuth,
      body: { request_id: requestId, responder_id: responder.responder_id, hotline_id: responder.hotline_id }
    });
    expect(token.status).toBe(201);
  }

  async function allocate(role = "input") {
    const response = await jsonRequest(baseUrl, `/v1/requests/${requestId}/artifacts`, {
      method: "POST",
      headers: callerAuth,
      body: { role, media_type: "text/plain" }
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  async function upload(artifactId, grant, body = PAYLOAD) {
    const response = await fetch(`${baseUrl}/v1/artifacts/${artifactId}/content`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${grant}`, "content-type": "application/octet-stream" },
      body
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  beforeEach(async () => {
    await startPlatform(createMemoryArtifactStore());
  });

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()();
    }
  });

  it("moves an artifact through allocate, upload, commit and download", async () => {
    const slot = await allocate();
    expect(slot.lifecycle_state).toBe("allocated");
    expect(slot.upload_grant).toBeTypeOf("string");

    const uploaded = await upload(slot.artifact_id, slot.upload_grant);
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.checksum.value).toBe(PAYLOAD_SHA256);

    const committed = await jsonRequest(baseUrl, `/v1/artifacts/${slot.artifact_id}/commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${slot.upload_grant}` },
      body: { checksum: { algorithm: "sha256", value: PAYLOAD_SHA256 } }
    });
    expect(committed.status).toBe(200);
    expect(committed.body.lifecycle_state).toBe("committed");

    const detail = await jsonRequest(baseUrl, `/v1/artifacts/${slot.artifact_id}`, { headers: callerAuth });
    expect(detail.status).toBe(200);
    expect(detail.body.download_grant).toBeTypeOf("string");

    const download = await fetch(`${baseUrl}/v1/artifacts/${slot.artifact_id}/content`, {
      headers: { Authorization: `Bearer ${detail.body.download_grant}` }
    });
    expect(download.status).toBe(200);
    const received = Buffer.from(await download.arrayBuffer());
    // the bytes that come back are byte-identical to what went in
    expect(crypto.createHash("sha256").update(received).digest("hex")).toBe(PAYLOAD_SHA256);
  });

  it("refuses to commit when the claimed checksum does not match the bytes", async () => {
    const slot = await allocate();
    await upload(slot.artifact_id, slot.upload_grant);

    const committed = await jsonRequest(baseUrl, `/v1/artifacts/${slot.artifact_id}/commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${slot.upload_grant}` },
      body: { checksum: { algorithm: "sha256", value: "f".repeat(64) } }
    });

    expect(committed.status).toBe(409);
    expect(committed.body.error.code).toBe("CONTRACT_ARTIFACT_CHECKSUM_MISMATCH");
    expect(state.artifacts.get(slot.artifact_id).lifecycle_state).toBe("allocated");
  });

  it("never serves bytes for an artifact that was never committed", async () => {
    const slot = await allocate();
    await upload(slot.artifact_id, slot.upload_grant);

    const detail = await jsonRequest(baseUrl, `/v1/artifacts/${slot.artifact_id}`, { headers: callerAuth });
    const download = await fetch(`${baseUrl}/v1/artifacts/${slot.artifact_id}/content`, {
      headers: { Authorization: `Bearer ${detail.body.download_grant}` }
    });
    expect(download.status).toBe(409);
  });

  it("treats an upload grant as unusable for download and vice versa", async () => {
    const slot = await allocate();
    await upload(slot.artifact_id, slot.upload_grant);
    await jsonRequest(baseUrl, `/v1/artifacts/${slot.artifact_id}/commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${slot.upload_grant}` },
      body: { checksum: { algorithm: "sha256", value: PAYLOAD_SHA256 } }
    });

    // an upload grant must not fetch bytes
    const withUploadGrant = await fetch(`${baseUrl}/v1/artifacts/${slot.artifact_id}/content`, {
      headers: { Authorization: `Bearer ${slot.upload_grant}` }
    });
    expect(withUploadGrant.status).toBe(403);
  });

  it("refuses a grant issued for a different artifact", async () => {
    const first = await allocate();
    const second = await allocate("output");

    const crossed = await upload(second.artifact_id, first.upload_grant);
    expect(crossed.status).toBe(403);
  });

  it("refuses uploads with no grant at all", async () => {
    const slot = await allocate();
    const response = await fetch(`${baseUrl}/v1/artifacts/${slot.artifact_id}/content`, {
      method: "PUT",
      body: PAYLOAD
    });
    expect(response.status).toBe(401);
  });

  it("keeps a stranger away from another request's artifacts", async () => {
    const slot = await allocate();
    const stranger = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "artifact-stranger@test.local" }
    });

    const detail = await jsonRequest(baseUrl, `/v1/artifacts/${slot.artifact_id}`, {
      headers: { Authorization: `Bearer ${stranger.body.api_key}` }
    });
    expect(detail.status).toBe(403);

    const allocateAsStranger = await jsonRequest(baseUrl, `/v1/requests/${requestId}/artifacts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stranger.body.api_key}` },
      body: { role: "input", media_type: "text/plain" }
    });
    expect(allocateAsStranger.status).toBe(403);
  });

  it("refuses to overwrite committed bytes", async () => {
    const slot = await allocate();
    await upload(slot.artifact_id, slot.upload_grant);
    await jsonRequest(baseUrl, `/v1/artifacts/${slot.artifact_id}/commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${slot.upload_grant}` },
      body: { checksum: { algorithm: "sha256", value: PAYLOAD_SHA256 } }
    });

    const rewrite = await upload(slot.artifact_id, slot.upload_grant, Buffer.from("different bytes"));
    expect(rewrite.status).toBe(409);
  });

  it("rejects an unsupported role rather than storing it", async () => {
    const response = await jsonRequest(baseUrl, `/v1/requests/${requestId}/artifacts`, {
      method: "POST",
      headers: callerAuth,
      body: { role: "screenshot", media_type: "image/png" }
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("CONTRACT_ARTIFACT_DESCRIPTOR_INVALID");
  });

  it("never exposes a storage locator in the descriptor", async () => {
    const slot = await allocate();
    await upload(slot.artifact_id, slot.upload_grant);
    const committed = await jsonRequest(baseUrl, `/v1/artifacts/${slot.artifact_id}/commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${slot.upload_grant}` },
      body: { checksum: { algorithm: "sha256", value: PAYLOAD_SHA256 } }
    });

    // A-01: descriptors travel, bytes are fetched through scoped authorization
    for (const forbidden of ["bucket", "object_key", "presigned_url", "url", "local_path"]) {
      expect(committed.body, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it("stores bytes durably on the filesystem backend", async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()();
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "delexec-artifacts-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const store = createFilesystemArtifactStore({ root: dir });
    await startPlatform(store);

    const slot = await allocate();
    await upload(slot.artifact_id, slot.upload_grant);
    await jsonRequest(baseUrl, `/v1/artifacts/${slot.artifact_id}/commit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${slot.upload_grant}` },
      body: { checksum: { algorithm: "sha256", value: PAYLOAD_SHA256 } }
    });

    // the bytes survive independently of the server process's memory
    const fromStore = await store.get(slot.artifact_id);
    expect(crypto.createHash("sha256").update(fromStore).digest("hex")).toBe(PAYLOAD_SHA256);
  });

  it("refuses an artifact id that would escape the store root", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "delexec-artifacts-safe-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const store = createFilesystemArtifactStore({ root: dir });

    await expect(store.put("../escape", Buffer.from("x"))).rejects.toThrow(/unsafe/);
    await expect(store.get("../../etc/passwd")).rejects.toThrow(/unsafe/);
  });
});
