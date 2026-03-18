import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createRelayServer } from "@delexec/transport-relay";
import { createRelayHttpTransportAdapter } from "@delexec/transport-relay-http";
import { closeServer, listenServer } from "../helpers/http.js";

describe("relay-http transport integration", () => {
  const cleanup = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()();
    }
  });

  it("sends, polls, acks, and peeks through relay server", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "delexec-relay-"));
    cleanup.push(() => rm(tempDir, { recursive: true, force: true }));

    const relayServer = createRelayServer();
    const relayUrl = await listenServer(relayServer);
    cleanup.push(() => closeServer(relayServer));

    const buyer = createRelayHttpTransportAdapter({
      baseUrl: relayUrl,
      receiver: "buyer-controller"
    });

    await buyer.send({
      to: "local://relay/seller_foxlab/foxlab.text.classifier.v1",
      thread_id: "thread_1",
      request_id: "req_relay_1",
      payload: { prompt: "hello" }
    });

    const seller = createRelayHttpTransportAdapter({
      baseUrl: relayUrl,
      receiver: "seller_foxlab"
    });

    const polled = await seller.poll();
    expect(polled.items).toHaveLength(1);
    expect(polled.items[0].request_id).toBe("req_relay_1");

    const peeked = await seller.peek({ thread_id: "thread_1" });
    expect(peeked.items).toHaveLength(1);

    const acked = await seller.ack(polled.items[0].message_id);
    expect(acked.acked).toBe(true);

    const empty = await seller.poll();
    expect(empty.items).toHaveLength(0);
  });
});
