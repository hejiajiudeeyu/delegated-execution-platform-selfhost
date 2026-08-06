// Unified gateway client. Every console call goes through here so error
// classification, session-token injection, and base-URL resolution stay in
// one place (design rule: future gateway/API evolution lands only in this
// module).
import { gatewayApiUrl, resolveGatewayBase } from "./gateway-url";

const SESSION_KEY = "platform.console.session";

export type FailureKind = "none" | "auth" | "gateway_down" | "http_error";

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
  /** classified failure: auth => credentials/session problem; gateway_down => network/gateway unreachable */
  failure: FailureKind;
  /** human-oriented message extracted from the structured error, if any */
  message: string | null;
  /** raw JSON string for the collapsed "技术详情" block */
  raw: string;
}

export function getSessionToken(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(SESSION_KEY);
}
export function setSessionToken(token: string | null): void {
  if (token) sessionStorage.setItem(SESSION_KEY, token);
  else sessionStorage.removeItem(SESSION_KEY);
}

function gatewayBase(): string {
  // Dev goes through the vite proxy, so the base is this origin — but it has
  // to be an *absolute* base. `new URL("session", "/")` throws Invalid base
  // URL, and the throw was caught and classified as gateway_down, so the dev
  // server reported "网关不可达" no matter what was running behind it. Two
  // console rebuilds were developed against a UI that could not reach a
  // gateway at all.
  if (import.meta.env.DEV) return `${window.location.origin}/`;
  return resolveGatewayBase(window.location);
}

async function request<T>(pathname: string, options: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const { method = "GET", body } = options;
  const headers: Record<string, string> = {};
  const token = getSessionToken();
  if (token) headers["X-Platform-Console-Session"] = token;
  if (body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
  try {
    const response = await fetch(gatewayApiUrl(gatewayBase(), pathname), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: { code: "GATEWAY_BAD_RESPONSE", message: text.slice(0, 200) } };
      }
    }
    return classify<T>(response.status, parsed, text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "network request failed";
    return {
      ok: false,
      status: 0,
      body: null,
      failure: "gateway_down",
      message,
      raw: JSON.stringify({ error: { code: "GATEWAY_UNREACHABLE", message } }, null, 2)
    };
  }
}

export function classify<T>(status: number, parsed: unknown, rawText?: string): ApiResult<T> {
  const errObj =
    parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)
      ? ((parsed as Record<string, unknown>).error as Record<string, unknown> | null)
      : null;
  const message = errObj && typeof errObj.message === "string" ? errObj.message : null;
  let failure: FailureKind = "none";
  if (status === 401 || status === 403) failure = "auth";
  else if (status === 0 || status === 502 || status === 503 || status === 504) failure = "gateway_down";
  else if (status >= 400) failure = "http_error";
  return {
    ok: status >= 200 && status < 300,
    status,
    body: (parsed as T) ?? null,
    failure,
    message,
    raw: rawText ? JSON.stringify({ status, body: parsed }, null, 2) : JSON.stringify({ status }, null, 2)
  };
}

// ---- session surface (gateway-owned, frozen API) ----
// GET /session returns { ok, session: { setup_required, authenticated,
// admin_api_key_configured, ... } }; `authenticated` reflects the token this
// client sent, so "locked" also covers a missing/expired local token.
export interface SessionInfo {
  setup_required?: boolean;
  authenticated?: boolean;
  admin_api_key_configured?: boolean;
  [k: string]: unknown;
}
export interface SessionEnvelope {
  ok?: boolean;
  token?: string;
  session?: SessionInfo;
}
export type SessionPhase = "unreachable" | "setup" | "locked" | "unlocked";

export function derivePhase(result: ApiResult<SessionEnvelope>): SessionPhase {
  if (result.failure === "gateway_down") return "unreachable";
  const session = (result.body && result.body.session) || {};
  if (session.setup_required) return "setup";
  return session.authenticated && getSessionToken() ? "unlocked" : "locked";
}

export const gateway = {
  healthz: () => request<{ ok?: boolean }>("/healthz"),
  session: () => request<SessionEnvelope>("/session"),
  setup: (bootstrapSecret: string, passphrase: string) =>
    request<SessionEnvelope>("/session/setup", {
      method: "POST",
      body: bootstrapSecret ? { bootstrap_secret: bootstrapSecret, passphrase } : { passphrase }
    }),
  login: (passphrase: string) => request<SessionEnvelope>("/session/login", { method: "POST", body: { passphrase } }),
  recover: (bootstrapSecret: string, newPassphrase: string) =>
    request<SessionEnvelope>("/session/recover", {
      method: "POST",
      body: { bootstrap_secret: bootstrapSecret, passphrase: newPassphrase, confirm_reset: true }
    }),
  logout: () => request("/session/logout", { method: "POST" }),
  changePassphrase: (nextPassphrase: string) =>
    request("/session/change-passphrase", { method: "POST", body: { next_passphrase: nextPassphrase } }),
  getCredentials: () => request<{ api_key_configured?: boolean }>("/credentials/platform-admin"),
  saveCredential: (apiKey: string, baseUrl?: string) =>
    request("/credentials/platform-admin", {
      method: "PUT",
      body: baseUrl ? { api_key: apiKey, base_url: baseUrl } : { api_key: apiKey }
    }),
  proxy: <T = unknown>(pathname: string, options: { method?: string; body?: unknown } = {}) =>
    request<T>(`/proxy${pathname}`, options)
};

// ---- aggregate reads (CHG-2026-189) ----
// These exist so the console can answer "what needs me" and "the whole story
// of one call" without joining four list endpoints in the browser. Joining
// them here is what forced the previous two consoles into per-endpoint pages.

export type AttentionTargetType = "hotline" | "responder" | "request";

export interface AttentionTarget {
  type: AttentionTargetType;
  id: string;
  label: string;
  availability_status?: string;
}

export interface AttentionItem {
  kind: string;
  severity: "action" | "attention";
  count: number;
  summary: string;
  targets: AttentionTarget[];
}

export interface AttentionEnvelope {
  generated_at: string;
  items: AttentionItem[];
  /** An empty list is a real answer, not a missing one. */
  nothing_to_do: boolean;
  not_tracked: { kind: string; reason: string }[];
}

/** One of the four state axes. `tracked:false` means the platform does not
 * follow this axis yet — the console must show the reason, never a guess. */
export interface AxisState {
  value: string | null;
  tracked: boolean;
  source?: string;
  reason?: string;
}

export interface CallArtifact {
  artifact_id: string;
  role: string;
  media_type: string;
  size_bytes: number;
  lifecycle_state: string;
  checksum?: { algorithm: string; value: string } | null;
  created_at?: string;
}

export interface CallDetail {
  request_id: string;
  caller_id: string | null;
  responder_id: string | null;
  hotline_id: string | null;
  request_kind: string;
  state: {
    execution: AxisState;
    delivery_integrity: AxisState;
    acceptance: AxisState;
    settlement: AxisState;
  };
  timeline: Record<string, unknown>[];
  artifacts: CallArtifact[];
  billing: Record<string, unknown> | null;
  responder: Record<string, unknown> | null;
  hotline: Record<string, unknown> | null;
  audit_events: Record<string, unknown>[];
}

export interface AlertConfig {
  enabled: boolean;
  webhook_url: string | null;
  webhook_secret_set: boolean;
  renotify_hours: number;
  liveness_url: string | null;
  liveness_interval_minutes: number;
  updated_at: string | null;
}

export interface AlertDelivery {
  at: string;
  key: string;
  event: string;
  kind: string;
  target_id: string | null;
  ok: boolean;
  status: number | null;
  error: string | null;
  attempts: number | null;
}

export interface AlertStatus {
  config: AlertConfig;
  last_pass_at: string | null;
  liveness_last_ping: { at: string; ok: boolean; status: number | null; error: string | null } | null;
  open_alerts: { key: string; kind: string; target_id: string | null; first_seen_at: string; notify_count?: number }[];
  recent_deliveries: AlertDelivery[];
  recent_failure_count: number;
  not_covered: { kind: string; reason: string }[];
}

// ---- admin data surface (platform-api via /proxy, frozen API) ----
export const admin = {
  attention: () => gateway.proxy<AttentionEnvelope>("/v1/admin/attention"),
  alertConfig: () => gateway.proxy<{ config: AlertConfig }>("/v1/admin/alerts/config"),
  alertStatus: () => gateway.proxy<AlertStatus>("/v1/admin/alerts/status"),
  alertConfigSave: (body: Record<string, unknown>) =>
    gateway.proxy<{ config: AlertConfig }>("/v1/admin/alerts/config", { method: "PUT", body }),
  alertTest: () =>
    gateway.proxy<{ delivered: boolean; status: number | null; error: string | null }>("/v1/admin/alerts/test", {
      method: "POST",
      body: {}
    }),
  callDetail: (requestId: string) => gateway.proxy<CallDetail>(`/v1/admin/requests/${encodeURIComponent(requestId)}`),
  responders: (query: string) => gateway.proxy<{ items?: unknown[]; total?: number }>(`/v2/admin/responders?${query}`),
  hotlines: (query: string) => gateway.proxy<{ items?: unknown[]; total?: number }>(`/v2/admin/hotlines?${query}`),
  requests: (query: string) => gateway.proxy<{ items?: unknown[]; total?: number }>(`/v1/admin/requests?${query}`),
  auditEvents: (query: string) => gateway.proxy<{ items?: unknown[]; total?: number }>(`/v1/admin/audit-events?${query}`),
  reviewAction: (type: "responders" | "hotlines", id: string, action: "approve" | "enable" | "reject", reason: string | null) =>
    gateway.proxy(`/v2/admin/${type}/${encodeURIComponent(id)}/${action}`, { method: "POST", body: { reason } }),
  billingBalance: (tenantId: string) =>
    gateway.proxy<Record<string, unknown>>(`/v1/admin/billing/tenants/${encodeURIComponent(tenantId)}/balance`),
  billingLedger: (tenantId: string, limit = 25) =>
    gateway.proxy<{ rows?: unknown[] }>(`/v1/admin/billing/tenants/${encodeURIComponent(tenantId)}/ledger?limit=${limit}`),
  billingCreateTenant: (tenantId: string) =>
    gateway.proxy(`/v1/admin/billing/tenants`, { method: "POST", body: { tenant_id: tenantId } }),
  billingRecharge: (tenantId: string, amountCents: number, rechargeId: string, provider: string, externalReference: string | null) =>
    gateway.proxy(`/v1/admin/billing/tenants/${encodeURIComponent(tenantId)}/recharges`, {
      method: "POST",
      body: {
        recharge_id: rechargeId,
        amount_cents: amountCents,
        provider,
        external_reference: externalReference
      }
    })
};
