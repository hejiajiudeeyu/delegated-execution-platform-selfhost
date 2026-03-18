import crypto from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function resolveReceiver(target) {
  if (!target || typeof target !== "string" || !target.startsWith("local://")) {
    return target;
  }

  try {
    const parsed = new URL(target);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (parsed.hostname === "relay" && segments[0]) {
      return segments[0];
    }
    if (segments[0]) {
      return segments[0];
    }
    if (parsed.hostname) {
      return parsed.hostname;
    }
  } catch {
    return target;
  }

  return target;
}

async function requestJson(baseUrl, pathname, { method = "GET", body } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

export function createRelayHttpTransportAdapter({ baseUrl, receiver }) {
  if (!baseUrl) {
    throw new Error("relay_http_base_url_required");
  }
  if (!receiver) {
    throw new Error("relay_http_receiver_required");
  }

  return {
    async send(envelope) {
      const target = resolveReceiver(envelope.to || envelope.seller_id || receiver);
      const message = {
        ...envelope,
        to: envelope.to || target,
        message_id: envelope.message_id || `msg_${crypto.randomUUID()}`,
        queued_at: envelope.queued_at || nowIso()
      };
      const response = await requestJson(baseUrl, "/v1/messages/send", {
        method: "POST",
        body: {
          receiver: target,
          envelope: message
        }
      });
      if (response.status !== 201) {
        throw new Error(`relay_http_send_failed:${response.status}`);
      }
      return response.body;
    },

    async poll({ limit = 10, receiver: overrideReceiver } = {}) {
      const response = await requestJson(baseUrl, "/v1/messages/poll", {
        method: "POST",
        body: {
          receiver: overrideReceiver || receiver,
          limit
        }
      });
      if (response.status !== 200) {
        throw new Error(`relay_http_poll_failed:${response.status}`);
      }
      return response.body;
    },

    async ack(messageId, { receiver: overrideReceiver } = {}) {
      const response = await requestJson(baseUrl, "/v1/messages/ack", {
        method: "POST",
        body: {
          receiver: overrideReceiver || receiver,
          message_id: messageId
        }
      });
      if (response.status !== 200) {
        throw new Error(`relay_http_ack_failed:${response.status}`);
      }
      return response.body;
    },

    async peek({ thread_id, receiver: overrideReceiver } = {}) {
      const params = new URLSearchParams({
        receiver: overrideReceiver || receiver
      });
      if (thread_id) {
        params.set("thread_id", thread_id);
      }
      const response = await requestJson(baseUrl, `/v1/messages/peek?${params.toString()}`);
      if (response.status !== 200) {
        throw new Error(`relay_http_peek_failed:${response.status}`);
      }
      return response.body;
    },

    async health() {
      const response = await requestJson(baseUrl, `/v1/receivers/${encodeURIComponent(receiver)}/health`);
      if (response.status !== 200) {
        throw new Error(`relay_http_health_failed:${response.status}`);
      }
      return response.body;
    }
  };
}
