// FR-066: alerts leave the process.
//
// Every case here delivers to a real HTTP receiver rather than a mocked
// fetch, because the failure this feature exists to prevent is not "the
// function was called" — it is "nothing arrived and nobody knew". A stub that
// records calls would pass while a malformed body or a wrong content-type
// silently broke the only thing that matters.
import crypto from "node:crypto";
import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import {
  buildAlertPayload,
  createAlertState,
  evaluateAlerts,
  flattenAttentionToAlerts,
  runAlertPass
} from "../../apps/platform-api/src/alerts.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

/** A receiver that records what actually arrived over the wire. */
async function startReceiver({ status = 200, failTimes = 0 } = {}) {
  const received = [];
  let remainingFailures = failTimes;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({
        method: req.method,
        url: req.url,
        signature: req.headers["x-delexec-signature"] || null,
        contentType: req.headers["content-type"] || null,
        raw: body,
        json: body ? JSON.parse(body) : null
      });
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        res.writeHead(500).end("nope");
        return;
      }
      res.writeHead(status).end("ok");
    });
  });
  const url = await listenServer(server);
  return { server, url, received };
}

describe("alerts (platform)", () => {
  const cleanup = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()();
    }
  });

  async function scenario(name) {
    const state = createPlatformState({ adminApiKey: `sk_admin_${name}`, bootstrapEnabled: true });
    const server = createPlatformServer({ serviceName: `alerts-${name}`, state });
    const baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));
    const adminHeaders = { Authorization: `Bearer ${state.adminApiKey}` };
    return {
      state,
      baseUrl,
      adminHeaders,
      putConfig: (body) =>
        jsonRequest(baseUrl, "/v1/admin/alerts/config", { method: "PUT", headers: adminHeaders, body }),
      getConfig: () => jsonRequest(baseUrl, "/v1/admin/alerts/config", { headers: adminHeaders }),
      status: () => jsonRequest(baseUrl, "/v1/admin/alerts/status", { headers: adminHeaders }),
      test: () => jsonRequest(baseUrl, "/v1/admin/alerts/test", { method: "POST", headers: adminHeaders, body: {} })
    };
  }

  it("stores the configuration, never returns the secret, and signs what it sends", async () => {
    const receiver = await startReceiver();
    cleanup.push(() => closeServer(receiver.server));
    const ctx = await scenario("config");

    const saved = await ctx.putConfig({
      enabled: true,
      webhook_url: receiver.url,
      webhook_secret: "s3cr3t",
      renotify_hours: 6
    });
    expect(saved.status).toBe(200);
    // The secret is acknowledged as set and never echoed back.
    expect(saved.body.config.webhook_secret_set).toBe(true);
    expect(saved.body.config.webhook_secret).toBeUndefined();
    expect(JSON.stringify(saved.body)).not.toContain("s3cr3t");

    const fetched = await ctx.getConfig();
    expect(JSON.stringify(fetched.body)).not.toContain("s3cr3t");

    const sent = await ctx.test();
    expect(sent.status).toBe(200);
    expect(sent.body.delivered).toBe(true);
    expect(receiver.received).toHaveLength(1);

    const delivery = receiver.received[0];
    expect(delivery.contentType).toContain("application/json");
    const expectedSignature = `sha256=${crypto.createHmac("sha256", "s3cr3t").update(delivery.raw).digest("hex")}`;
    expect(delivery.signature).toBe(expectedSignature);
    expect(delivery.json.schema).toBe("delexec.alert.v1");
    // A receiver that shows one line of text must still be useful.
    expect(delivery.json.text).toContain("测试告警");
  });

  it("keeps the stored secret when a later edit omits it", async () => {
    // Otherwise changing the renotify window from the console — which is never
    // shown the secret — would silently unsign every future alert.
    const receiver = await startReceiver();
    cleanup.push(() => closeServer(receiver.server));
    const ctx = await scenario("secret_retained");

    await ctx.putConfig({ enabled: true, webhook_url: receiver.url, webhook_secret: "keep-me" });
    const edited = await ctx.putConfig({ enabled: true, webhook_url: receiver.url, renotify_hours: 12 });
    expect(edited.status).toBe(200);
    expect(edited.body.config.webhook_secret_set).toBe(true);
    expect(edited.body.config.renotify_hours).toBe(12);

    await ctx.test();
    const delivery = receiver.received.at(-1);
    expect(delivery.signature).toBe(
      `sha256=${crypto.createHmac("sha256", "keep-me").update(delivery.raw).digest("hex")}`
    );
  });

  it("refuses a configuration that would quietly never deliver", async () => {
    const ctx = await scenario("invalid_config");
    const badUrl = await ctx.putConfig({ enabled: true, webhook_url: "not-a-url" });
    expect(badUrl.status).toBe(400);
    expect(badUrl.body.error.code).toBe("CONTRACT_INVALID_ALERT_CONFIG");

    const badWindow = await ctx.putConfig({ enabled: true, webhook_url: "https://example.com/hook", renotify_hours: 0 });
    expect(badWindow.status).toBe(400);

    // And a test send with nothing configured says so rather than reporting success.
    const untested = await ctx.test();
    expect(untested.status).toBe(400);
  });

  it("reports a failed delivery instead of swallowing it", async () => {
    // A broken webhook that looks fine reproduces exactly the silence this
    // feature exists to end, so the failure has to be visible in the console.
    const ctx = await scenario("delivery_failure");
    await ctx.putConfig({ enabled: true, webhook_url: "http://127.0.0.1:1/hook" });

    const sent = await ctx.test();
    expect(sent.status).toBe(502);
    expect(sent.body.delivered).toBe(false);

    const status = await ctx.status();
    expect(status.body.recent_failure_count).toBe(1);
    expect(status.body.recent_deliveries[0].ok).toBe(false);
    expect(status.body.recent_deliveries[0].error).toBeTruthy();
  });

  it("says out loud that it cannot see a platform outage", async () => {
    // An operator who believes alerting covers the platform being down will
    // read the silence during an outage as good news. This is the same rule
    // the attention feed already follows for unbuilt features.
    const ctx = await scenario("not_covered");
    const status = await ctx.status();
    const kinds = status.body.not_covered.map((entry) => entry.kind);
    expect(kinds).toContain("platform_down");
    const platformDown = status.body.not_covered.find((entry) => entry.kind === "platform_down");
    expect(platformDown.reason).toContain("存活 ping");
  });

  it("retries a receiver that blinks, and gives up on one that refuses", async () => {
    const flaky = await startReceiver({ failTimes: 1 });
    cleanup.push(() => closeServer(flaky.server));
    const ctx = await scenario("retry");
    await ctx.putConfig({ enabled: true, webhook_url: flaky.url });

    const sent = await ctx.test();
    expect(sent.body.delivered).toBe(true);
    expect(sent.body.attempts).toBe(2);
    expect(flaky.received).toHaveLength(2);

    // A 4xx is the receiver saying the request itself is wrong; repeating it
    // verbatim cannot help, so it must not be retried.
    const rejecting = await startReceiver({ status: 404 });
    cleanup.push(() => closeServer(rejecting.server));
    const ctx2 = await scenario("no_retry_on_4xx");
    await ctx2.putConfig({ enabled: true, webhook_url: rejecting.url });
    const refused = await ctx2.test();
    expect(refused.body.delivered).toBe(false);
    expect(rejecting.received).toHaveLength(1);
  });

  it("fires once on a new problem, again only after the renotify window, and once on recovery", async () => {
    const receiver = await startReceiver();
    cleanup.push(() => closeServer(receiver.server));
    const alertState = createAlertState();
    alertState.config = { enabled: true, webhook_url: receiver.url, renotify_hours: 6 };

    const problem = [{ key: "device_unavailable:dev_a", kind: "device_unavailable", severity: "attention", target_id: "dev_a", target_label: "Mac", summary: "1 台设备不可用" }];
    const t0 = Date.parse("2026-08-06T00:00:00.000Z");

    const first = await runAlertPass(alertState, problem, { now: t0 });
    expect(first.fired).toBe(1);

    // Still broken five minutes later: the operator has already been told.
    const quiet = await runAlertPass(alertState, problem, { now: t0 + 5 * 60_000 });
    expect(quiet.fired).toBe(0);

    // Still broken six hours later: a problem mentioned once and never again
    // is how a long outage goes unnoticed.
    const again = await runAlertPass(alertState, problem, { now: t0 + 6 * 60 * 60_000 + 1000 });
    expect(again.fired).toBe(1);

    // Recovered: silence after an alert must never be ambiguous.
    const recovered = await runAlertPass(alertState, [], { now: t0 + 7 * 60 * 60_000 });
    expect(recovered.resolved).toBe(1);
    expect(alertState.tracked["device_unavailable:dev_a"]).toBeUndefined();

    const events = receiver.received.map((entry) => entry.json.event);
    expect(events).toEqual(["opened", "ongoing", "resolved"]);
    expect(receiver.received.at(-1).json.text).toContain("已恢复");
  });

  it("tracks each device separately so one recovery does not silence another", async () => {
    const alertState = createAlertState();
    const t0 = Date.parse("2026-08-06T00:00:00.000Z");
    const both = [
      { key: "device_unavailable:dev_a", kind: "device_unavailable", severity: "attention", target_id: "dev_a" },
      { key: "device_unavailable:dev_b", kind: "device_unavailable", severity: "attention", target_id: "dev_b" }
    ];
    expect(evaluateAlerts(alertState, both, { now: t0 }).fire).toHaveLength(2);

    const onlyB = [both[1]];
    const second = evaluateAlerts(alertState, onlyB, { now: t0 + 60_000 });
    expect(second.resolve.map((entry) => entry.target_id)).toEqual(["dev_a"]);
    // B is still broken and still tracked — it must not be resolved with A.
    expect(alertState.tracked["device_unavailable:dev_b"]).toBeTruthy();
  });

  it("survives a restart without re-announcing problems already reported", async () => {
    // The alert record rides the persisted snapshot; if it did not, every
    // deploy would re-page the operator about everything still open.
    const receiver = await startReceiver();
    cleanup.push(() => closeServer(receiver.server));
    const alertState = createAlertState();
    alertState.config = { enabled: true, webhook_url: receiver.url, renotify_hours: 6 };
    const problem = [{ key: "call_stuck:req_1", kind: "call_stuck", severity: "attention", target_id: "req_1" }];
    const t0 = Date.parse("2026-08-06T00:00:00.000Z");
    await runAlertPass(alertState, problem, { now: t0 });
    expect(receiver.received).toHaveLength(1);

    const rehydrated = { ...createAlertState(), ...JSON.parse(JSON.stringify(alertState)) };
    const afterRestart = await runAlertPass(rehydrated, problem, { now: t0 + 60_000 });
    expect(afterRestart.fired).toBe(0);
    expect(receiver.received).toHaveLength(1);
  });

  it("alerts on exactly what the console shows, including past the display cap", async () => {
    // The alert path and the attention feed must never be two opinions about
    // what is wrong. The feed truncates targets for display; alerting must not
    // inherit that truncation — a device that sorts 21st is not less broken.
    const items = [
      {
        kind: "device_unavailable",
        severity: "attention",
        count: 25,
        summary: "25 台设备不可用",
        targets: Array.from({ length: 25 }, (_, index) => ({ type: "responder", id: `dev_${index}`, label: `dev_${index}` }))
      }
    ];
    const alerts = flattenAttentionToAlerts(items);
    expect(alerts).toHaveLength(25);
    expect(alerts.at(-1).target_id).toBe("dev_24");
  });

  it("surfaces a real offline device end to end, from heartbeat age to delivered alert", async () => {
    const receiver = await startReceiver();
    cleanup.push(() => closeServer(receiver.server));
    const ctx = await scenario("device_offline_e2e");
    await ctx.putConfig({ enabled: true, webhook_url: receiver.url });

    // Age the bootstrap device's heartbeat past the offline threshold, the way
    // a device that stopped calling home would.
    const responder = ctx.state.responders.get(ctx.state.bootstrap.responders[0].responder_id);
    responder.last_heartbeat_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const attention = await jsonRequest(ctx.baseUrl, "/v1/admin/attention", { headers: ctx.adminHeaders });
    expect(JSON.stringify(attention.body.items)).toContain("device_unavailable");

    const pass = await runAlertPass(
      ctx.state.alerts,
      flattenAttentionToAlerts(
        attention.body.items.map((item) => ({ ...item, targets: item.targets }))
      ),
      { now: Date.now() }
    );
    expect(pass.fired).toBeGreaterThanOrEqual(1);

    const delivered = receiver.received.at(-1).json;
    expect(delivered.kind).toBe("device_unavailable");
    expect(delivered.text).toContain("设备不可用");
    expect(delivered.target_id).toBe(responder.responder_id);
  });

  it("builds a payload a one-line receiver can use", async () => {
    const payload = buildAlertPayload(
      { key: "k", kind: "call_stuck", severity: "attention", target_id: "req_9", target_label: "mineru.pdf", event: "opened", summary: "1 个调用卡住" },
      { serviceName: "platform-api", consoleUrl: "https://callanything.xyz/console/", now: Date.parse("2026-08-06T01:00:00.000Z") }
    );
    expect(payload.text).toBe("需要处理 — 调用卡住未到终态：mineru.pdf");
    expect(payload.console_url).toBe("https://callanything.xyz/console/");
    expect(payload.sent_at).toBe("2026-08-06T01:00:00.000Z");
  });
});
