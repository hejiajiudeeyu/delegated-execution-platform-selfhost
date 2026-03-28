import { afterEach, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";

import {
  createPlatformServer,
  createPlatformState,
  hydratePlatformState,
  serializePlatformState
} from "@delexec/platform-api";
import { createCallerControllerServer, createCallerState, hydrateCallerState, serializeCallerState } from "@delexec/caller-controller-core";
import { createPostgresSnapshotStore } from "@delexec/postgres-store";
import { createResponderControllerServer, createResponderState, hydrateResponderState, serializeResponderState } from "@delexec/responder-runtime-core";
import { closeServer, jsonRequest, listenServer, waitFor } from "../helpers/http.js";

function createMemoryPool() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

describe("postgres snapshot persistence", () => {
  const cleanup = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      await fn();
    }
  });

  it("rehydrates platform state from postgres snapshot", async () => {
    const pool = createMemoryPool();
    const store = await createPostgresSnapshotStore({ pool, serviceName: "platform-api" });
    await store.migrate();
    cleanup.push(() => store.close());

    const state = createPlatformState();
    const server = createPlatformServer({
      state,
      serviceName: "platform-persist-test",
      onStateChanged: async (currentState) => {
        await store.saveSnapshot(serializePlatformState(currentState));
      }
    });
    const baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));

    const requestId = "req_platform_persist_1";
    const responder = state.bootstrap.responders[0];
    const registered = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "persist-platform@test.local" }
    });
    const callerAuth = { Authorization: `Bearer ${registered.body.api_key}` };
    await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: callerAuth,
      body: {
        request_id: requestId,
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id
      }
    });
    await jsonRequest(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
      method: "POST",
      headers: callerAuth,
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        result_delivery: {
          kind: "local",
          address: "caller-controller"
        }
      }
    });

    const snapshot = await store.loadSnapshot();
    const restored = createPlatformState();
    hydratePlatformState(restored, snapshot);

    expect(restored.users.size).toBe(1);
    expect(restored.requests.get(requestId)?.responder_id).toBe(responder.responder_id);
    expect(restored.requests.get(requestId)?.events.some((event) => event.event_type === "DELIVERY_META_ISSUED")).toBe(
      true
    );
  });

  it("rehydrates caller request state from postgres snapshot", async () => {
    const pool = createMemoryPool();
    const store = await createPostgresSnapshotStore({ pool, serviceName: "caller-controller" });
    await store.migrate();
    cleanup.push(() => store.close());

    const state = createCallerState();
    const server = createCallerControllerServer({
      state,
      serviceName: "caller-persist-test",
      onStateChanged: async (currentState) => {
        await store.saveSnapshot(serializeCallerState(currentState));
      }
    });
    const baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));

    const requestId = "req_caller_persist_1";
    await jsonRequest(baseUrl, "/controller/requests", {
      method: "POST",
      body: {
        request_id: requestId,
        responder_id: "responder_persist",
        hotline_id: "persist.runtime.v1"
      }
    });
    await jsonRequest(baseUrl, `/controller/requests/${requestId}/mark-sent`, {
      method: "POST"
    });

    const restored = createCallerState();
    hydrateCallerState(restored, await store.loadSnapshot());
    expect(restored.requests.get(requestId)?.status).toBe("SENT");
    expect(restored.requests.get(requestId)?.timeline.some((event) => event.event === "SENT")).toBe(true);
  });

  it("rehydrates responder task queue state from postgres snapshot", async () => {
    const pool = createMemoryPool();
    const store = await createPostgresSnapshotStore({ pool, serviceName: "responder-controller" });
    await store.migrate();
    cleanup.push(() => store.close());

    const state = createResponderState({
      responderId: "responder_persist",
      hotlineIds: ["persist.runtime.v1"]
    });
    const server = createResponderControllerServer({
      state,
      serviceName: "responder-persist-test",
      onStateChanged: async (currentState) => {
        await store.saveSnapshot(serializeResponderState(currentState));
      }
    });
    const baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));

    const created = await jsonRequest(baseUrl, "/controller/tasks", {
      method: "POST",
      body: {
        request_id: "req_responder_persist_1",
        hotline_id: "persist.runtime.v1",
        delay_ms: 10,
        simulate: "success"
      }
    });

    await waitFor(async () => {
      const result = await jsonRequest(baseUrl, `/controller/tasks/${created.body.task_id}/result`);
      if (result.status !== 200 || result.body.available !== true) {
        throw new Error("result_not_ready");
      }
      return result;
    });

    const restored = createResponderState({
      responderId: "responder_persist",
      hotlineIds: ["persist.runtime.v1"],
      signing: {
        publicKeyPem: state.signing.publicKeyPem,
        privateKeyPem: state.signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
      }
    });
    hydrateResponderState(restored, await store.loadSnapshot());

    const restoredTask = restored.tasks.get(created.body.task_id);
    expect(restoredTask?.request_id).toBe("req_responder_persist_1");
    expect(restoredTask?.result_package?.status).toBe("ok");
    expect(restored.requestIndex.get("req_responder_persist_1")).toBe(created.body.task_id);
  });
});
