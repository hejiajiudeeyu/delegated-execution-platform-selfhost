// Main line B: one call, whole story, one page.
//
// The v0.2.0 console had no detail route at all. Tracing a call meant finding
// its card on /requests, expanding a raw JSON dump, copying the caller id by
// hand, typing it into /billing, then hunting /audit and assembling the
// timeline in your head. Three pages with no link between them.
//
// The four state axes are drawn as four independent rows rather than four
// badges in a line, because they *are* four independent lines — that is what
// the previous console's side-by-side badges failed to convey, and drawing
// them separately removes the need to explain it.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, FileDown, RefreshCw, ShieldCheck, ShieldX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyChip, DataState, TechDetails } from "@/components/shared";
import { admin, type ApiResult, type AxisState, type CallDetail } from "@/lib/api";
import {
  ACTOR_LABEL,
  ARTIFACT_LIFECYCLE,
  ARTIFACT_ROLE,
  AXIS_LABEL,
  EXECUTION_VALUE,
  PROGRESS_STAGE_LABEL,
  SETTLEMENT_VALUE,
  Term,
  describeEvent
} from "@/lib/vocabulary";
import { cn } from "@/components/ui/utils";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AxisRow({ axis, state }: { axis: keyof CallDetail["state"]; state: AxisState }) {
  const vocab = AXIS_LABEL[axis];
  const readable =
    axis === "execution"
      ? EXECUTION_VALUE[state.value || ""] || state.value
      : axis === "settlement"
        ? SETTLEMENT_VALUE[state.value || ""] || state.value
        : state.value;

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border/60 py-3 last:border-0">
      <div className="w-24 shrink-0 text-sm font-medium">
        <Term plain={vocab.plain}>{vocab.title}</Term>
      </div>
      {state.tracked ? (
        <>
          <span className="text-sm font-semibold">{readable || "—"}</span>
          {state.source && <span className="text-xs text-muted-foreground">来源：{state.source}</span>}
        </>
      ) : (
        // An untracked axis says why. A plausible-looking value here would be
        // worse than a blank, because the operator would believe it. The API
        // explains itself through `reason` for unbuilt features and `source`
        // for "nothing to track on this call", so both are surfaced rather
        // than falling back to a generic line that says less than the API did.
        <span className="text-sm text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">未跟踪</span>{" "}
          {state.reason || state.source || "平台尚未跟踪这一维度"}
        </span>
      )}
    </div>
  );
}

export function CallDetailPage() {
  const { requestId = "" } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ApiResult<CallDetail> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setResult(await admin.callDetail(requestId));
    setLoading(false);
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Only a successful response is a call. An error body (401 after the
  // session expires, 404, gateway failure) is truthy but has no `state`, and
  // rendering it as a call crashed the whole page to white — found live when
  // visiting a detail link before unlocking. DataState shows the error; this
  // guard keeps the crashed render from ever being constructed.
  const call = result?.ok ? (result.body ?? null) : null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" className="-ml-2 mb-1" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
            返回
          </Button>
          <h1 className="text-2xl font-bold">调用详情</h1>
          <div className="mt-1.5">
            <CopyChip value={requestId} />
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <DataState
        loading={loading}
        result={result && !result.ok ? result : null}
        emptyText="找不到这个调用。"
        onConfigureCredentials={() => navigate("/credentials")}
      >
        {call && (
          <div className="space-y-5">
            {/* Four axes, four lines. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">状态</CardTitle>
                <p className="text-sm text-muted-foreground">
                  这四条线各自独立推进——执行完成不代表已验收，已验收也不代表钱已经动。
                </p>
              </CardHeader>
              <CardContent className="pt-0">
                <AxisRow axis="execution" state={call.state.execution} />
                <AxisRow axis="delivery_integrity" state={call.state.delivery_integrity} />
                <AxisRow axis="acceptance" state={call.state.acceptance} />
                <AxisRow axis="settlement" state={call.state.settlement} />
              </CardContent>
            </Card>

            {/* Timeline: what actually happened, in order, in words. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">时间线</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {call.timeline.length === 0 ? (
                  <p className="py-3 text-sm text-muted-foreground">还没有事件。</p>
                ) : (
                  <ol className="relative space-y-0">
                    {call.timeline.map((event, index) => {
                      const type = String(event.event_type ?? "");
                      const at = event.at ? new Date(String(event.at)) : null;
                      // Progress rows are observations, not milestones: drawn
                      // hollow and grey so the eye still reads the lifecycle
                      // events as the skeleton of the timeline.
                      const progress =
                        type === "PROGRESS" && event.progress && typeof event.progress === "object"
                          ? (event.progress as { stage?: string; percent?: number; message?: string })
                          : null;
                      return (
                        <li key={`${type}-${index}`} className="flex gap-3 border-b border-border/60 py-2.5 last:border-0">
                          <span
                            className={cn(
                              "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                              progress ? "border border-muted-foreground/50 bg-transparent" : "bg-primary/60"
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className={cn("text-sm", progress ? "text-muted-foreground" : "font-medium")}>
                                {describeEvent(type)}
                              </span>
                              {progress && (
                                <span className="text-sm text-muted-foreground">
                                  {PROGRESS_STAGE_LABEL[String(progress.stage)] || String(progress.stage ?? "")}
                                  {typeof progress.percent === "number" && ` · ${Math.round(progress.percent)}%`}
                                </span>
                              )}
                              {typeof event.actor_type === "string" && (
                                <Badge variant="outline" className="text-[10px]">
                                  {ACTOR_LABEL[event.actor_type] || String(event.actor_type)}
                                </Badge>
                              )}
                              {at && (
                                <span className="text-xs text-muted-foreground">{at.toLocaleString()}</span>
                              )}
                            </div>
                            {progress && typeof progress.message === "string" && progress.message && (
                              <div className="text-xs text-muted-foreground">{progress.message}</div>
                            )}
                            {typeof event.message === "string" && !progress && type === "SOFT_TIMEOUT" && (
                              <div className="text-xs text-muted-foreground">{event.message}</div>
                            )}
                            {typeof event.reason === "string" && (
                              <div className="text-xs text-muted-foreground">{event.reason}</div>
                            )}
                            {typeof event.error_code === "string" && (
                              <div className="text-xs text-red-600">{event.error_code}</div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </CardContent>
            </Card>

            {/* Artifacts, with the one distinction that matters: committed
                bytes are verifiable, allocated ones do not exist yet. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">文件</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {call.artifacts.length === 0 ? (
                  <p className="py-3 text-sm text-muted-foreground">这次调用没有文件往来。</p>
                ) : (
                  <div className="space-y-2.5">
                    {call.artifacts.map((artifact) => {
                      const lifecycle = ARTIFACT_LIFECYCLE[artifact.lifecycle_state];
                      const committed = artifact.lifecycle_state === "committed";
                      return (
                        <div
                          key={artifact.artifact_id}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border/70 px-3 py-2.5"
                        >
                          <Badge variant="outline">{ARTIFACT_ROLE[artifact.role] || artifact.role}</Badge>
                          <span className="text-sm">{artifact.media_type}</span>
                          <span className="text-sm text-muted-foreground">{formatBytes(artifact.size_bytes)}</span>
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 text-xs",
                              committed ? "text-emerald-700" : "text-amber-700"
                            )}
                          >
                            {committed ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldX className="h-3.5 w-3.5" />}
                            <Term plain={lifecycle?.plain || ""}>{lifecycle?.label || artifact.lifecycle_state}</Term>
                          </span>
                          {artifact.checksum?.value && (
                            <CopyChip
                              value={artifact.checksum.value}
                              label={`${artifact.checksum.algorithm}:${artifact.checksum.value.slice(0, 12)}…`}
                            />
                          )}
                          <CopyChip value={artifact.artifact_id} label={artifact.artifact_id.slice(0, 14) + "…"} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="grid gap-5 md:grid-cols-2">
              {/* Billing, carried here rather than making the operator copy a
                  tenant id into another page. */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">资金</CardTitle>
                </CardHeader>
                <CardContent className="pt-0 text-sm">
                  {call.billing ? (
                    <dl className="space-y-2">
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">状态</dt>
                        <dd className="font-medium">
                          {SETTLEMENT_VALUE[String(call.billing.state ?? "")] || String(call.billing.state ?? "—")}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">冻结金额</dt>
                        <dd className="font-medium">
                          {call.billing.hold_amount_cents == null ? "—" : `${String(call.billing.hold_amount_cents)} PTS`}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-muted-foreground">租户</dt>
                        <dd>
                          {/* Carried from the call, never typed by hand. */}
                          {call.billing.tenant_id ? (
                            <Link to={`/billing?tenant=${encodeURIComponent(String(call.billing.tenant_id))}`} className="underline">
                              查看账户 →
                            </Link>
                          ) : (
                            "—"
                          )}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="text-muted-foreground">这次调用没有计费。</p>
                  )}
                </CardContent>
              </Card>

              {/* Who did the work, and what shape it was in. */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">设备与热线</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 pt-0 text-sm">
                  {call.responder ? (
                    <>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">设备</span>
                        <span className="font-medium">
                          {String(call.responder.display_name || call.responder.responder_id)}
                        </span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">可用性</span>
                        <span className="font-medium">{String(call.responder.availability_status ?? "—")}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">最近心跳</span>
                        <span>
                          {call.responder.last_heartbeat_at
                            ? new Date(String(call.responder.last_heartbeat_at)).toLocaleString()
                            : "从未"}
                        </span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">版本</span>
                        <span>{call.responder.device_version ? String(call.responder.device_version) : "未上报"}</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-muted-foreground">还没有设备接下这次调用。</p>
                  )}
                  {call.hotline && (
                    <div className="mt-3 border-t border-border/60 pt-3">
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">热线</span>
                        <span className="font-medium">{String(call.hotline.display_name || call.hotline.hotline_id)}</span>
                      </div>
                      {/* Which contract this call agreed to — not the one on the
                          shelf today. Judging a delivery against the current
                          contract is the mistake the pin exists to prevent. */}
                      <div className="mt-2 flex justify-between gap-3">
                        <span className="text-muted-foreground">契约版本</span>
                        {call.hotline_version?.tracked ? (
                          <span className="text-right">
                            <span className="font-medium">v{call.hotline_version.version}</span>
                            {call.hotline_version.superseded_by_current && (
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                （热线已更新到 v{String(call.hotline.published_version ?? "?")}，本次调用不受影响）
                              </span>
                            )}
                            {call.hotline_version.integrity === "digest_mismatch" && (
                              <span className="ml-1.5 text-xs text-destructive">内容与摘要不符</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">未记录（早于契约版本化）</span>
                        )}
                      </div>
                      {call.hotline_version?.tracked && call.hotline_version.digest && (
                        <div className="mt-1 flex justify-between gap-3">
                          <span className="text-muted-foreground">内容摘要</span>
                          <span className="font-mono text-xs">{call.hotline_version.digest.slice(7, 19)}…</span>
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {call.audit_events.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">相关审计事件</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="space-y-1.5 text-sm">
                    {call.audit_events.map((event, index) => (
                      <li key={index} className="flex flex-wrap gap-2 text-muted-foreground">
                        <span className="font-medium text-foreground">{String(event.action ?? event.event_type ?? "事件")}</span>
                        {typeof event.at === "string" && <span className="text-xs">{new Date(event.at).toLocaleString()}</span>}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <FileDown className="h-3.5 w-3.5" />
              <TechDetails raw={result?.raw} />
            </div>
          </div>
        )}
      </DataState>
    </div>
  );
}
