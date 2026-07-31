// The relay carries task envelopes across the public network, so these tests
// pin the two properties the audit's S1 finding was about: an unauthenticated
// party can neither read nor delete another receiver's messages, and a stale
// consumer cannot delete work that has been re-leased to someone else.
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createRelayServer, createMemoryRelayStore, createSqliteRelayStore } from "@delexec/transport-relay";
import { issueReceiverToken } from "../../apps/transport-relay/src/auth.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

const ADMIN_TOKEN = "relay-admin-integration-token";
const TOKEN_SECRET = "relay-token-secret-integration";

function authHeader(token) {
  return { Authorization: `Bearer ${token}` };
}

async function startRelay(overrides = {}) {
  const server = createRelayServer({
    serviceName: "relay-auth-test",
    auth: { adminToken: ADMIN_TOKEN, tokenSecret: TOKEN_SECRET },
    ...overrides
  });
  const baseUrl = await listenServer(server);
  return { server, baseUrl };
}

function envelope(messageId, extra = {}) {
  return { message_id: messageId, thread_id: "thread_1", payload: { secret: "private evidence" }, ...extra };
}

async function send(baseUrl, receiver, message, token = ADMIN_TOKEN) {
  return jsonRequest(baseUrl, "/v1/messages/send", {
    method: "POST",
    headers: authHeader(token),
    body: { receiver, envelope: message }
  });
}

describe("relay authentication", () => {
  const cleanup = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()();
    }
  });

  it("refuses every business route without a token", async () => {
    const { server, baseUrl } = await startRelay();
    cleanup.push(() => closeServer(server));

    const routes = [
      { method: "POST", path: "/v1/messages/send", body: { receiver: "r", envelope: envelope("m1") } },
      { method: "POST", path: "/v1/messages/poll", body: { receiver: "r" } },
      { method: "POST", path: "/v1/messages/ack", body: { receiver: "r", message_id: "m1" } },
      { method: "GET", path: "/v1/messages/peek?receiver=r" },
      { method: "GET", path: "/v1/receivers/r/health" },
      { method: "POST", path: "/v1/receivers/r/tokens", body: {} }
    ];

    for (const route of routes) {
      const response = await jsonRequest(baseUrl, route.path, { method: route.method, body: route.body });
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
      expect(response.body.error.code).toBe("RELAY_UNAUTHORIZED");
    }
  });

  it("keeps health and build probes public", async () => {
    const { server, baseUrl } = await startRelay();
    cleanup.push(() => closeServer(server));

    expect((await jsonRequest(baseUrl, "/healthz")).status).toBe(200);
    expect((await jsonRequest(baseUrl, "/buildz")).status).toBe(200);
    const root = await jsonRequest(baseUrl, "/");
    expect(root.body.auth_enforced).toBe(true);
  });

  it("stops a receiver token from reading or deleting another inbox", async () => {
    const { server, baseUrl } = await startRelay();
    cleanup.push(() => closeServer(server));

    await send(baseUrl, "responder_victim", envelope("m_victim"));
    const { token: attackerToken } = issueReceiverToken({ receiver: "responder_attacker", tokenSecret: TOKEN_SECRET });

    const peek = await jsonRequest(baseUrl, "/v1/messages/peek?receiver=responder_victim", {
      headers: authHeader(attackerToken)
    });
    expect(peek.status).toBe(403);

    const poll = await jsonRequest(baseUrl, "/v1/messages/poll", {
      method: "POST",
      headers: authHeader(attackerToken),
      body: { receiver: "responder_victim" }
    });
    expect(poll.status).toBe(403);

    const ack = await jsonRequest(baseUrl, "/v1/messages/ack", {
      method: "POST",
      headers: authHeader(attackerToken),
      body: { receiver: "responder_victim", message_id: "m_victim" }
    });
    expect(ack.status).toBe(403);

    // the victim's message is untouched
    const ownerPeek = await jsonRequest(baseUrl, "/v1/messages/peek?receiver=responder_victim", {
      headers: authHeader(ADMIN_TOKEN)
    });
    expect(ownerPeek.body.items).toHaveLength(1);
  });

  it("mints receiver tokens for admins only, and the token works on its own inbox", async () => {
    const { server, baseUrl } = await startRelay();
    cleanup.push(() => closeServer(server));

    const { token: someReceiverToken } = issueReceiverToken({ receiver: "responder_a", tokenSecret: TOKEN_SECRET });
    const forbidden = await jsonRequest(baseUrl, "/v1/receivers/responder_a/tokens", {
      method: "POST",
      headers: authHeader(someReceiverToken),
      body: {}
    });
    expect(forbidden.status).toBe(403);

    const minted = await jsonRequest(baseUrl, "/v1/receivers/responder_a/tokens", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { ttl_seconds: 3600 }
    });
    expect(minted.status).toBe(201);
    expect(minted.body.receiver).toBe("responder_a");
    expect(minted.body.expires_at).toBeTypeOf("string");

    await send(baseUrl, "responder_a", envelope("m_a"));
    const poll = await jsonRequest(baseUrl, "/v1/messages/poll", {
      method: "POST",
      headers: authHeader(minted.body.token),
      body: { receiver: "responder_a" }
    });
    expect(poll.status).toBe(200);
    expect(poll.body.items).toHaveLength(1);
  });

  it("runs open when no credential is configured, for in-process use", async () => {
    const server = createRelayServer({ serviceName: "relay-open-test" });
    const baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));

    const response = await jsonRequest(baseUrl, "/v1/messages/poll", { method: "POST", body: { receiver: "r" } });
    expect(response.status).toBe(200);
  });
});

describe("relay visibility lease", () => {
  const cleanup = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()();
    }
  });

  it("hides a claimed message from a second poller until the lease expires", async () => {
    const { server, baseUrl } = await startRelay({ visibilityTimeoutSeconds: 1 });
    cleanup.push(() => closeServer(server));

    await send(baseUrl, "responder_lease", envelope("m_lease"));

    const first = await jsonRequest(baseUrl, "/v1/messages/poll", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_lease" }
    });
    expect(first.body.items).toHaveLength(1);
    expect(first.body.lease_id).toMatch(/^lease_/);

    const second = await jsonRequest(baseUrl, "/v1/messages/poll", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_lease" }
    });
    expect(second.body.items).toHaveLength(0);

    // ... and becomes claimable again once the lease lapses, so a crashed
    // consumer never strands the message
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const third = await jsonRequest(baseUrl, "/v1/messages/poll", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_lease" }
    });
    expect(third.body.items).toHaveLength(1);
    expect(third.body.lease_id).not.toBe(first.body.lease_id);
  });

  it("refuses an ack carrying a superseded lease", async () => {
    const { server, baseUrl } = await startRelay({ visibilityTimeoutSeconds: 1 });
    cleanup.push(() => closeServer(server));

    await send(baseUrl, "responder_race", envelope("m_race"));
    const first = await jsonRequest(baseUrl, "/v1/messages/poll", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_race" }
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await jsonRequest(baseUrl, "/v1/messages/poll", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_race" }
    });
    expect(second.body.items).toHaveLength(1);

    // the slow first consumer must not delete work the second one now owns
    const staleAck = await jsonRequest(baseUrl, "/v1/messages/ack", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_race", message_id: "m_race", lease_id: first.body.lease_id }
    });
    expect(staleAck.status).toBe(409);
    expect(staleAck.body.error.code).toBe("RELAY_LEASE_CONFLICT");

    const currentAck = await jsonRequest(baseUrl, "/v1/messages/ack", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_race", message_id: "m_race", lease_id: second.body.lease_id }
    });
    expect(currentAck.status).toBe(200);
    expect(currentAck.body.acked).toBe(true);
  });

  it("keeps ack idempotent and never errors on a repeat", async () => {
    const { server, baseUrl } = await startRelay();
    cleanup.push(() => closeServer(server));

    await send(baseUrl, "responder_idem", envelope("m_idem"));
    const polled = await jsonRequest(baseUrl, "/v1/messages/poll", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_idem" }
    });

    const body = { receiver: "responder_idem", message_id: "m_idem", lease_id: polled.body.lease_id };
    const first = await jsonRequest(baseUrl, "/v1/messages/ack", { method: "POST", headers: authHeader(ADMIN_TOKEN), body });
    expect(first.body).toMatchObject({ acked: true });

    const repeat = await jsonRequest(baseUrl, "/v1/messages/ack", { method: "POST", headers: authHeader(ADMIN_TOKEN), body });
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ acked: false, reason: "not_found" });
  });

  it("reports visible and total depth separately", async () => {
    const { server, baseUrl } = await startRelay({ visibilityTimeoutSeconds: 60 });
    cleanup.push(() => closeServer(server));

    await send(baseUrl, "responder_depth", envelope("m1"));
    await send(baseUrl, "responder_depth", envelope("m2"));
    await jsonRequest(baseUrl, "/v1/messages/poll", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_depth", limit: 1 }
    });

    const health = await jsonRequest(baseUrl, "/v1/receivers/responder_depth/health", {
      headers: authHeader(ADMIN_TOKEN)
    });
    expect(health.body).toMatchObject({ queue_depth: 2, visible_depth: 1 });
  });

  it("applies the same lease semantics on the sqlite store", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "delexec-relay-lease-"));
    cleanup.push(() => rm(tempDir, { recursive: true, force: true }));
    const store = createSqliteRelayStore(path.join(tempDir, "relay.sqlite"));
    cleanup.push(() => store.close());

    const { server, baseUrl } = await startRelay({ store, visibilityTimeoutSeconds: 60 });
    cleanup.push(() => closeServer(server));

    await send(baseUrl, "responder_sqlite", envelope("m_sqlite"));
    const first = await jsonRequest(baseUrl, "/v1/messages/poll", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_sqlite" }
    });
    expect(first.body.items).toHaveLength(1);

    const second = await jsonRequest(baseUrl, "/v1/messages/poll", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_sqlite" }
    });
    expect(second.body.items).toHaveLength(0);

    const stale = await jsonRequest(baseUrl, "/v1/messages/ack", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_sqlite", message_id: "m_sqlite", lease_id: "lease_not_the_current_one" }
    });
    expect(stale.status).toBe(409);

    const acked = await jsonRequest(baseUrl, "/v1/messages/ack", {
      method: "POST",
      headers: authHeader(ADMIN_TOKEN),
      body: { receiver: "responder_sqlite", message_id: "m_sqlite", lease_id: first.body.lease_id }
    });
    expect(acked.body.acked).toBe(true);
    expect(store.queueDepth("responder_sqlite").total).toBe(0);
  });

  it("does not leak envelopes between receivers in the memory store", async () => {
    const store = createMemoryRelayStore();
    store.enqueue("a", { message_id: "m_a" });
    store.enqueue("b", { message_id: "m_b" });

    expect(store.poll("a").items.map((item) => item.message_id)).toEqual(["m_a"]);
    expect(store.peek("b").map((item) => item.message_id)).toEqual(["m_b"]);
  });
});
