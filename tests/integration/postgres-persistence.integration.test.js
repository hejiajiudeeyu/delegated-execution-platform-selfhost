// Platform-scope snapshot persistence test. The caller-controller and
// responder-runtime persistence flows that used to live in this file moved to
// the client repository together with their packages during the repo split;
// this repository only owns the platform-api snapshot round-trip.
import { afterEach, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";

import {
  createPlatformServer,
  createPlatformState,
  hydratePlatformState,
  serializePlatformState
} from "@delexec/platform-api";
import { createPostgresSnapshotStore } from "@delexec/postgres-store";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

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

    const state = createPlatformState({ bootstrapEnabled: true });
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
    const restored = createPlatformState({ bootstrapEnabled: true });
    hydratePlatformState(restored, snapshot);

    expect(restored.users.size).toBe(1);
    expect(restored.requests.get(requestId)?.responder_id).toBe(responder.responder_id);
    expect(restored.requests.get(requestId)?.events.some((event) => event.event_type === "DELIVERY_META_ISSUED")).toBe(
      true
    );
  });
});
