// FR-066: where alerts go, and proof that they got there.
//
// The page is built around one claim it must never make falsely: "you will be
// told". So it shows the delivery record next to the configuration, and it
// names what alerting cannot see — a platform that is down cannot report its
// own outage, which is exactly the incident that motivated this feature.
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle2, RefreshCw, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ActionResult, BusyButton, DataState, TechDetails, useAction } from "@/components/shared";
import { admin, type AlertStatus, type ApiResult } from "@/lib/api";
import { describeEvent } from "@/lib/vocabulary";
import { cn } from "@/components/ui/utils";
import { toast } from "sonner";

const KIND_LABEL: Record<string, string> = {
  device_unavailable: "设备不可用",
  call_stuck: "调用卡住",
  funds_held_after_end: "结束后资金仍冻结",
  hotline_review_pending: "热线待审批",
  responder_review_pending: "责任方待审批",
  alert_test: "测试告警"
};

const EVENT_LABEL: Record<string, string> = {
  opened: "首次告警",
  ongoing: "仍未解决",
  resolved: "已恢复",
  test: "测试"
};

export function AlertsPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ApiResult<AlertStatus> | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [renotifyHours, setRenotifyHours] = useState("6");
  const [livenessUrl, setLivenessUrl] = useState("");
  const [livenessMinutes, setLivenessMinutes] = useState("5");

  const load = useCallback(async () => {
    setLoading(true);
    const next = await admin.alertStatus();
    setResult(next);
    if (next.ok && next.body) {
      const config = next.body.config;
      setWebhookUrl(config.webhook_url ?? "");
      setRenotifyHours(String(config.renotify_hours ?? 6));
      setLivenessUrl(config.liveness_url ?? "");
      setLivenessMinutes(String(config.liveness_interval_minutes ?? 5));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const status = result?.ok ? (result.body ?? null) : null;

  const save = useAction(async (): Promise<ApiResult> => {
    const body: Record<string, unknown> = {
      enabled: webhookUrl.trim().length > 0,
      webhook_url: webhookUrl.trim() || null,
      renotify_hours: Number(renotifyHours),
      liveness_url: livenessUrl.trim() || null,
      liveness_interval_minutes: Number(livenessMinutes)
    };
    // Omitting the field keeps the stored secret; the box is left blank on
    // purpose after saving, because this page is never shown the secret back.
    if (secret.trim().length > 0) {
      body.webhook_secret = secret.trim();
    }
    const saved = await admin.alertConfigSave(body);
    if (saved.ok) {
      setSecret("");
      toast.success("已保存");
      await load();
    }
    return saved;
  });

  const sendTest = useAction(async (): Promise<ApiResult> => {
    const sent = await admin.alertTest();
    if (sent.ok && sent.body?.delivered) {
      toast.success("测试告警已送达");
    }
    await load();
    return sent;
  });

  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">设置 / 告警</div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-2xl font-bold">告警</h1>
          <p className="text-muted-foreground">
            出问题时主动通知你，而不是等你想起来打开这个页面。平台把告警 POST 到你配置的 URL——飞书/企微机器人、Bark、ntfy、自写脚本都可以。
          </p>
        </div>
        <BusyButton busy={loading} variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          刷新
        </BusyButton>
      </div>

      <DataState
        loading={loading}
        result={result && !result.ok ? result : null}
        emptyText="读不到告警状态。"
        onConfigureCredentials={() => navigate("/credentials")}
      >
        {status && (
          <div className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">通知地址</CardTitle>
                <p className="text-sm text-muted-foreground">
                  留空即关闭告警。密钥可选：填了之后每条告警都会带 <code className="text-xs">x-delexec-signature</code> 头（HMAC-SHA256），接收端可据此确认确实来自这个平台。
                </p>
              </CardHeader>
              <CardContent className="space-y-4 pt-0">
                <div className="space-y-2">
                  <Label htmlFor="webhook-url">Webhook URL</Label>
                  <Input
                    id="webhook-url"
                    value={webhookUrl}
                    placeholder="https://…"
                    onChange={(event) => setWebhookUrl(event.target.value)}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="webhook-secret">
                      签名密钥{status.config.webhook_secret_set ? "（已设置，留空表示不改）" : "（可选）"}
                    </Label>
                    <Input
                      id="webhook-secret"
                      type="password"
                      value={secret}
                      placeholder={status.config.webhook_secret_set ? "••••••••" : "留空则不签名"}
                      onChange={(event) => setSecret(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="renotify">问题未解决时，每隔几小时重备一次</Label>
                    <Input
                      id="renotify"
                      value={renotifyHours}
                      inputMode="decimal"
                      onChange={(event) => setRenotifyHours(event.target.value)}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <BusyButton busy={save.busy} onClick={() => void save.run()}>
                    保存
                  </BusyButton>
                  <BusyButton
                    busy={sendTest.busy}
                    variant="outline"
                    disabled={!status.config.webhook_url}
                    onClick={() => void sendTest.run()}
                  >
                    <Send className="h-4 w-4" />
                    发一条测试告警
                  </BusyButton>
                  <span className="text-xs text-muted-foreground">
                    没投递过的配置不值得信任——出事前先让它送一次。
                  </span>
                </div>
                <ActionResult result={save.result} okText="已保存" />
                <ActionResult result={sendTest.result} okText="测试告警已送达" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">存活 ping（平台自己宕机时唯一能救你的东西）</CardTitle>
                <p className="text-sm text-muted-foreground">
                  上面的告警由平台自己发出，所以平台一旦挂了，它也发不出「我挂了」。这里填一个外部监控的
                  ping URL（Healthchecks.io、Uptime Kuma 的 push 监控、BetterStack heartbeat 都是这个形态），平台按周期 GET 一次；
                  ping 停了，由对方通知你。
                </p>
              </CardHeader>
              <CardContent className="space-y-4 pt-0">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="liveness-url">Ping URL</Label>
                    <Input
                      id="liveness-url"
                      value={livenessUrl}
                      placeholder="https://hc-ping.com/…"
                      onChange={(event) => setLivenessUrl(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="liveness-minutes">每隔几分钟 ping 一次</Label>
                    <Input
                      id="liveness-minutes"
                      value={livenessMinutes}
                      inputMode="numeric"
                      onChange={(event) => setLivenessMinutes(event.target.value)}
                    />
                  </div>
                </div>
                {status.liveness_last_ping ? (
                  <p className="text-sm">
                    最近一次 ping：{new Date(status.liveness_last_ping.at).toLocaleString()}{" "}
                    {status.liveness_last_ping.ok ? (
                      <span className="text-emerald-700">成功</span>
                    ) : (
                      <span className="text-red-600">
                        失败（{status.liveness_last_ping.error || status.liveness_last_ping.status}）
                      </span>
                    )}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">还没 ping 过。</p>
                )}
              </CardContent>
            </Card>

            <div className="grid gap-5 md:grid-cols-2">
              <Card className={status.recent_failure_count > 0 ? "border-red-200" : undefined}>
                <CardHeader>
                  <CardTitle className="text-base">最近投递</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    投递失败本身也是故障——这里出现红色，说明告警发不出去，等于没有告警。
                  </p>
                </CardHeader>
                <CardContent className="pt-0">
                  {status.recent_deliveries.length === 0 ? (
                    <p className="py-3 text-sm text-muted-foreground">还没有发出过任何告警。</p>
                  ) : (
                    <ul className="space-y-2">
                      {status.recent_deliveries.map((delivery, index) => (
                        <li
                          key={`${delivery.key}-${index}`}
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 pb-2 text-sm last:border-0"
                        >
                          {delivery.ok ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                          ) : (
                            <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
                          )}
                          <span className="font-medium">{KIND_LABEL[delivery.kind] || delivery.kind}</span>
                          <Badge variant="outline" className="text-[10px]">
                            {EVENT_LABEL[delivery.event] || describeEvent(delivery.event)}
                          </Badge>
                          {delivery.target_id && (
                            <span className="text-xs text-muted-foreground">{delivery.target_id}</span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {new Date(delivery.at).toLocaleString()}
                          </span>
                          {!delivery.ok && (
                            <span className="text-xs text-red-600">{delivery.error || `HTTP ${delivery.status}`}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">当前还开着的告警</CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  {status.open_alerts.length === 0 ? (
                    <p className="py-3 text-sm text-muted-foreground">没有未解决的告警。</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {status.open_alerts.map((alert) => (
                        <li key={alert.key} className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-2 last:border-0">
                          <span className="font-medium">{KIND_LABEL[alert.kind] || alert.kind}</span>
                          {alert.target_id && <span className="text-xs text-muted-foreground">{alert.target_id}</span>}
                          <span className="text-xs text-muted-foreground">
                            自 {new Date(alert.first_seen_at).toLocaleString()}
                          </span>
                          {(alert.notify_count ?? 1) > 1 && (
                            <Badge variant="outline" className="text-[10px]">已通知 {alert.notify_count} 次</Badge>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Same rule the attention feed follows: name the blind spots, so
                silence about an unbuilt thing is never read as good news. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">它还看不到什么</CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {status.not_covered.map((entry) => (
                    <li key={entry.kind} className="flex flex-wrap gap-2">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{entry.kind}</span>
                      <span>{entry.reason}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <div className="text-xs text-muted-foreground">
              <TechDetails raw={result?.raw} />
            </div>
          </div>
        )}
      </DataState>
    </div>
  );
}
