import { afterEach, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";

import {
  createPlatformServer,
  createPlatformState,
  hydratePlatformState,
  serializePlatformState
} from "@delexec/platform-api";
import { createBuyerControllerServer, createBuyerState, hydrateBuyerState, serializeBuyerState } from "@delexec/buyer-controller-core";
import { createPostgresSnapshotStore } from "@delexec/postgres-store";
import { createSellerControllerServer, createSellerState, hydrateSellerState, serializeSellerState } from "@delexec/seller-runtime-core";
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
    const seller = state.bootstrap.sellers[0];
    const registered = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "persist-platform@test.local" }
    });
    const buyerAuth = { Authorization: `Bearer ${registered.body.api_key}` };
    await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: buyerAuth,
      body: {
        request_id: requestId,
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id
      }
    });
    await jsonRequest(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
      method: "POST",
      headers: buyerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        result_delivery: {
          kind: "local",
          address: "buyer-controller"
        }
      }
    });

    const snapshot = await store.loadSnapshot();
    const restored = createPlatformState();
    hydratePlatformState(restored, snapshot);

    expect(restored.users.size).toBe(1);
    expect(restored.requests.get(requestId)?.seller_id).toBe(seller.seller_id);
    expect(restored.requests.get(requestId)?.events.some((event) => event.event_type === "DELIVERY_META_ISSUED")).toBe(
      true
    );
  });

  it("rehydrates buyer request state from postgres snapshot", async () => {
    const pool = createMemoryPool();
    const store = await createPostgresSnapshotStore({ pool, serviceName: "buyer-controller" });
    await store.migrate();
    cleanup.push(() => store.close());

    const state = createBuyerState();
    const server = createBuyerControllerServer({
      state,
      serviceName: "buyer-persist-test",
      onStateChanged: async (currentState) => {
        await store.saveSnapshot(serializeBuyerState(currentState));
      }
    });
    const baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));

    const requestId = "req_buyer_persist_1";
    await jsonRequest(baseUrl, "/controller/requests", {
      method: "POST",
      body: {
        request_id: requestId,
        seller_id: "seller_persist",
        subagent_id: "persist.runtime.v1"
      }
    });
    await jsonRequest(baseUrl, `/controller/requests/${requestId}/mark-sent`, {
      method: "POST"
    });

    const restored = createBuyerState();
    hydrateBuyerState(restored, await store.loadSnapshot());
    expect(restored.requests.get(requestId)?.status).toBe("SENT");
    expect(restored.requests.get(requestId)?.timeline.some((event) => event.event === "SENT")).toBe(true);
  });

  it("rehydrates seller task queue state from postgres snapshot", async () => {
    const pool = createMemoryPool();
    const store = await createPostgresSnapshotStore({ pool, serviceName: "seller-controller" });
    await store.migrate();
    cleanup.push(() => store.close());

    const state = createSellerState({
      sellerId: "seller_persist",
      subagentIds: ["persist.runtime.v1"]
    });
    const server = createSellerControllerServer({
      state,
      serviceName: "seller-persist-test",
      onStateChanged: async (currentState) => {
        await store.saveSnapshot(serializeSellerState(currentState));
      }
    });
    const baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));

    const created = await jsonRequest(baseUrl, "/controller/tasks", {
      method: "POST",
      body: {
        request_id: "req_seller_persist_1",
        subagent_id: "persist.runtime.v1",
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

    const restored = createSellerState({
      sellerId: "seller_persist",
      subagentIds: ["persist.runtime.v1"],
      signing: {
        publicKeyPem: state.signing.publicKeyPem,
        privateKeyPem: state.signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
      }
    });
    hydrateSellerState(restored, await store.loadSnapshot());

    const restoredTask = restored.tasks.get(created.body.task_id);
    expect(restoredTask?.request_id).toBe("req_seller_persist_1");
    expect(restoredTask?.result_package?.status).toBe("ok");
    expect(restored.requestIndex.get("req_seller_persist_1")).toBe(created.body.task_id);
  });
});
