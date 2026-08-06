// FR-066: the platform tells the operator something is wrong instead of
// waiting to be asked.
//
// Everything the console's attention feed knows was already computed; what
// was missing is a way out of the process. This module adds exactly that —
// an outbound leg — and deliberately adds NO second opinion about what counts
// as a problem. Alerts are derived from the same buildAttentionItems() the
// console renders, because two definitions of "wrong" drift, and this
// codebase has already paid for that once: isStuckCall read a field
// production events never carried, so the one guardrail against a silently
// stuck call never fired outside its own test.
//
// What this cannot do, stated plainly because a false sense of coverage is
// worse than none: a process cannot report its own death. Alerts about the
// platform being down are the liveness ping's job (below), not this one's.

import crypto from "node:crypto";

export const DEFAULT_ALERT_INTERVAL_MS = 60_000;
export const DEFAULT_RENOTIFY_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_LIVENESS_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_HISTORY_LIMIT = 50;
const MAX_ATTEMPTS = 3;

export function createAlertState() {
  return {
    config: null,
    // key -> { kind, target_id, first_seen_at, last_notified_at, notify_count }
    tracked: {},
    deliveries: []
  };
}

function isHttpUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Validate operator-supplied alert configuration.
 *
 * `enabled` is kept separate from "a URL exists" so that muting alerts is an
 * explicit act that survives in the record, rather than something an operator
 * accomplishes by quietly deleting the URL and later forgetting they did.
 */
export function normalizeAlertConfig(input = {}) {
  const errors = [];
  if (input === null || typeof input !== "object") {
    return { valid: false, errors: ["alert config must be an object"] };
  }

  const webhookUrl = input.webhook_url ?? null;
  if (webhookUrl !== null && !isHttpUrl(webhookUrl)) {
    errors.push("alerts.webhook_url must be an http(s) URL");
  }

  const livenessUrl = input.liveness_url ?? null;
  if (livenessUrl !== null && !isHttpUrl(livenessUrl)) {
    errors.push("alerts.liveness_url must be an http(s) URL");
  }

  const secret = input.webhook_secret ?? null;
  if (secret !== null && (typeof secret !== "string" || secret.length > 256)) {
    errors.push("alerts.webhook_secret must be a string of at most 256 characters");
  }

  const renotifyHours = input.renotify_hours === undefined || input.renotify_hours === null ? 6 : Number(input.renotify_hours);
  if (!Number.isFinite(renotifyHours) || renotifyHours < 0.25 || renotifyHours > 168) {
    errors.push("alerts.renotify_hours must be between 0.25 and 168");
  }

  const livenessMinutes =
    input.liveness_interval_minutes === undefined || input.liveness_interval_minutes === null
      ? 5
      : Number(input.liveness_interval_minutes);
  if (!Number.isFinite(livenessMinutes) || livenessMinutes < 1 || livenessMinutes > 1440) {
    errors.push("alerts.liveness_interval_minutes must be between 1 and 1440");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    config: {
      enabled: input.enabled === undefined ? Boolean(webhookUrl) : Boolean(input.enabled),
      webhook_url: webhookUrl,
      webhook_secret: secret,
      renotify_hours: renotifyHours,
      liveness_url: livenessUrl,
      liveness_interval_minutes: livenessMinutes,
      updated_at: new Date().toISOString()
    }
  };
}

/** The config as it may be shown to an operator: never the secret itself. */
export function redactAlertConfig(config) {
  if (!config) {
    return {
      enabled: false,
      webhook_url: null,
      webhook_secret_set: false,
      renotify_hours: 6,
      liveness_url: null,
      liveness_interval_minutes: 5,
      updated_at: null
    };
  }
  const { webhook_secret, ...rest } = config;
  return { ...rest, webhook_secret_set: Boolean(webhook_secret) };
}

/**
 * Attention items are aggregates ("3 devices unavailable"); alerts are about
 * one thing each, so that device B recovering does not silence device A and a
 * newly broken device C is not swallowed by an alert already sent for A.
 */
export function flattenAttentionToAlerts(items = []) {
  const alerts = [];
  for (const item of items) {
    const targets = Array.isArray(item.targets) ? item.targets : [];
    if (targets.length === 0) {
      alerts.push({
        key: item.kind,
        kind: item.kind,
        severity: item.severity || "attention",
        target_id: null,
        target_label: null,
        summary: item.summary
      });
      continue;
    }
    for (const target of targets) {
      alerts.push({
        key: `${item.kind}:${target.id}`,
        kind: item.kind,
        severity: item.severity || "attention",
        target_id: target.id,
        target_label: target.label || target.id,
        summary: item.summary
      });
    }
  }
  return alerts;
}

/**
 * Decide what to send. Fires on first appearance and again once the renotify
 * window has passed while the problem is still there — a problem that is
 * mentioned once and never again is how a 5.5-hour outage goes unnoticed —
 * and sends one closing notice when it clears, so silence after an alert is
 * never ambiguous.
 *
 * Mutates `alertState.tracked`, which is persisted, so a platform restart does
 * not re-announce every open problem.
 */
export function evaluateAlerts(alertState, currentAlerts, { now = Date.now(), renotifyMs = DEFAULT_RENOTIFY_MS } = {}) {
  const tracked = alertState.tracked || (alertState.tracked = {});
  const nowIso = new Date(now).toISOString();
  const seen = new Set();
  const fire = [];

  for (const alert of currentAlerts) {
    seen.add(alert.key);
    const existing = tracked[alert.key];
    if (!existing) {
      tracked[alert.key] = {
        kind: alert.kind,
        target_id: alert.target_id,
        first_seen_at: nowIso,
        last_notified_at: nowIso,
        notify_count: 1
      };
      fire.push({ ...alert, event: "opened", first_seen_at: nowIso });
      continue;
    }
    const last = Date.parse(existing.last_notified_at || existing.first_seen_at || nowIso);
    if (Number.isFinite(last) && now - last >= renotifyMs) {
      existing.last_notified_at = nowIso;
      existing.notify_count = (existing.notify_count || 1) + 1;
      fire.push({ ...alert, event: "ongoing", first_seen_at: existing.first_seen_at });
    }
  }

  const resolve = [];
  for (const key of Object.keys(tracked)) {
    if (seen.has(key)) {
      continue;
    }
    const entry = tracked[key];
    resolve.push({
      key,
      kind: entry.kind,
      severity: "resolved",
      target_id: entry.target_id ?? null,
      target_label: entry.target_id ?? null,
      summary: null,
      event: "resolved",
      first_seen_at: entry.first_seen_at
    });
    delete tracked[key];
  }

  return { fire, resolve };
}

export function buildAlertPayload(alert, { serviceName = "platform-api", consoleUrl = null, now = Date.now() } = {}) {
  return {
    schema: "delexec.alert.v1",
    event: alert.event,
    kind: alert.kind,
    severity: alert.severity,
    target_id: alert.target_id ?? null,
    target_label: alert.target_label ?? null,
    // A human-readable line first: most webhook receivers (a chat bot, a phone
    // push) show one line of text and nothing else.
    text: describeAlert(alert),
    summary: alert.summary ?? null,
    first_seen_at: alert.first_seen_at ?? null,
    source: serviceName,
    console_url: consoleUrl,
    sent_at: new Date(now).toISOString()
  };
}

const KIND_TEXT = Object.freeze({
  device_unavailable: "设备不可用",
  call_stuck: "调用卡住未到终态",
  funds_held_after_end: "调用已结束但资金仍冻结",
  hotline_review_pending: "热线等待审核",
  responder_review_pending: "责任方等待审核"
});

export function describeAlert(alert) {
  const what = KIND_TEXT[alert.kind] || alert.kind;
  const who = alert.target_label || alert.target_id;
  const subject = who ? `${what}：${who}` : what;
  if (alert.event === "resolved") {
    return `已恢复 — ${subject}`;
  }
  if (alert.event === "ongoing") {
    return `仍未解决 — ${subject}`;
  }
  return `需要处理 — ${subject}`;
}

/**
 * POST the payload. Retries a couple of times because a webhook receiver
 * blinking is common and losing the one notice about a dead device is not
 * acceptable; it does not retry forever, because a receiver that is properly
 * down should surface as a visible delivery failure rather than an infinite
 * background loop.
 */
export async function deliverAlert(config, payload, { fetchImpl = fetch, timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS } = {}) {
  if (!config?.webhook_url) {
    return { ok: false, skipped: true, reason: "no_webhook_url" };
  }

  const body = JSON.stringify(payload);
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (config.webhook_secret) {
    // Lets the receiver prove the POST came from this platform, so an alert
    // endpoint can be a plain URL without becoming an open megaphone.
    headers["x-delexec-signature"] = `sha256=${crypto
      .createHmac("sha256", config.webhook_secret)
      .update(body)
      .digest("hex")}`;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(config.webhook_url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, status: response.status, attempts: attempt };
      }
      lastError = `http_${response.status}`;
      // A 4xx is the receiver saying "this request is wrong"; repeating it
      // verbatim will not make it right.
      if (response.status >= 400 && response.status < 500) {
        break;
      }
    } catch (error) {
      lastError = error?.name === "TimeoutError" ? "timeout" : String(error?.message || error);
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  return { ok: false, error: lastError || "unknown_error", attempts: MAX_ATTEMPTS };
}

/**
 * The dead man's switch. The platform cannot alert about its own outage — the
 * process doing the alerting is the process that died — so instead it checks
 * in on a schedule and an external service (Healthchecks.io, Uptime Kuma push,
 * BetterStack heartbeat) alarms when the check-ins stop. GET, because that is
 * the one method every heartbeat endpoint accepts.
 *
 * This is the only part of FR-066 that covers the incident which motivated it:
 * the 2026-07-04 outage was 5.5 hours long and was found by walking into it.
 */
export async function pingLiveness(config, { fetchImpl = fetch, timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS } = {}) {
  if (!config?.liveness_url) {
    return { ok: false, skipped: true, reason: "no_liveness_url" };
  }
  try {
    const response = await fetchImpl(config.liveness_url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { ok: response.status >= 200 && response.status < 300, status: response.status };
  } catch (error) {
    return { ok: false, error: error?.name === "TimeoutError" ? "timeout" : String(error?.message || error) };
  }
}

export function recordDelivery(alertState, entry) {
  const deliveries = alertState.deliveries || (alertState.deliveries = []);
  deliveries.push(entry);
  if (deliveries.length > DELIVERY_HISTORY_LIMIT) {
    deliveries.splice(0, deliveries.length - DELIVERY_HISTORY_LIMIT);
  }
}

/**
 * One evaluation pass: work out what changed, send it, and record what
 * happened to each send. Delivery failures are kept in state rather than only
 * logged, because "we tried to warn you and could not" is itself something the
 * operator has to be able to see — otherwise a broken webhook reproduces the
 * exact silence this feature exists to end.
 */
export async function runAlertPass(
  alertState,
  currentAlerts,
  { now = Date.now(), serviceName = "platform-api", consoleUrl = null, fetchImpl = fetch } = {}
) {
  const config = alertState.config;
  if (!config?.enabled || !config.webhook_url) {
    return { skipped: true, reason: "alerts_disabled", fired: 0, resolved: 0 };
  }

  const renotifyMs = Math.round((Number(config.renotify_hours) || 6) * 60 * 60 * 1000);
  const { fire, resolve } = evaluateAlerts(alertState, currentAlerts, { now, renotifyMs });
  let failures = 0;

  for (const alert of [...fire, ...resolve]) {
    const payload = buildAlertPayload(alert, { serviceName, consoleUrl, now });
    const result = await deliverAlert(config, payload, { fetchImpl });
    if (!result.ok) {
      failures += 1;
    }
    recordDelivery(alertState, {
      at: new Date(now).toISOString(),
      key: alert.key,
      event: alert.event,
      kind: alert.kind,
      target_id: alert.target_id ?? null,
      ok: Boolean(result.ok),
      status: result.status ?? null,
      error: result.error ?? null,
      attempts: result.attempts ?? null
    });
  }

  return { skipped: false, fired: fire.length, resolved: resolve.length, failures };
}

/**
 * Start the periodic pass. Returns a stop function; nothing is scheduled if
 * there is no configuration yet, and the loop re-checks configuration each
 * tick so enabling alerts in the console takes effect without a restart.
 */
export function startAlertLoop({
  state,
  buildAlerts,
  intervalMs = DEFAULT_ALERT_INTERVAL_MS,
  serviceName = "platform-api",
  consoleUrl = null,
  onStateChanged = null,
  fetchImpl = fetch,
  logger = console
} = {}) {
  let livenessLastPingedAt = 0;
  let running = false;

  async function tick() {
    if (running) {
      return;
    }
    running = true;
    try {
      const alertState = state.alerts;
      const config = alertState?.config;
      if (!config) {
        return;
      }
      const now = Date.now();

      if (config.liveness_url) {
        const dueMs = Math.max(60_000, Number(config.liveness_interval_minutes || 5) * 60 * 1000);
        if (now - livenessLastPingedAt >= dueMs) {
          livenessLastPingedAt = now;
          const ping = await pingLiveness(config, { fetchImpl });
          if (!ping.ok && !ping.skipped) {
            logger.warn?.(`[${serviceName}] liveness ping failed: ${ping.error || ping.status}`);
          }
          alertState.liveness_last_ping = {
            at: new Date(now).toISOString(),
            ok: Boolean(ping.ok),
            status: ping.status ?? null,
            error: ping.error ?? null
          };
        }
      }

      const result = await runAlertPass(alertState, buildAlerts(now), { now, serviceName, consoleUrl, fetchImpl });
      alertState.last_pass_at = new Date(now).toISOString();
      if (!result.skipped && (result.fired > 0 || result.resolved > 0)) {
        if (onStateChanged) {
          await onStateChanged(state);
        }
      }
    } catch (error) {
      logger.warn?.(`[${serviceName}] alert pass failed: ${error?.message || error}`);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
