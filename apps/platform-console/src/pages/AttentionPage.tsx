// Main line A: the home page answers "what needs me right now".
//
// The page it replaces showed three health lights — gateway alive, session
// unlocked, credential valid — and a "next step" card that went permanently
// silent once setup was done. It consumed no business signal at all, which is
// the mechanical reason the operator could not tell what to do next.
//
// Every row here is a real, clickable piece of work. When there is none, the
// page says so in words rather than showing green lights and leaving the
// operator to infer it.
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, CheckCircle2, Inbox, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DataState, TechDetails } from "@/components/shared";
import { admin, type ApiResult, type AttentionEnvelope, type AttentionItem, type AttentionTarget } from "@/lib/api";
import { ATTENTION_KIND } from "@/lib/vocabulary";
import { useConsole } from "@/state/console";
import { cn } from "@/components/ui/utils";

/** Where a piece of work is actually done. An attention row that does not lead
 * somewhere is just a notification, which is what the last console had. */
function targetHref(target: AttentionTarget): string {
  if (target.type === "request") return `/calls/${encodeURIComponent(target.id)}`;
  if (target.type === "hotline") return `/reviews`;
  return `/reviews`;
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const vocab = ATTENTION_KIND[item.kind];
  const isAction = item.severity === "action";
  return (
    <Card className={cn("overflow-hidden", isAction ? "border-primary/30" : "border-amber-200")}>
      <CardContent className="pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-bold",
                  isAction ? "bg-primary text-primary-foreground" : "bg-amber-100 text-amber-800"
                )}
              >
                {item.count}
              </span>
              <span className="text-base font-semibold">{vocab?.title || item.kind}</span>
              <Badge variant="outline" className={isAction ? "" : "border-amber-300 text-amber-700"}>
                {isAction ? "待处理" : "需留意"}
              </Badge>
            </div>
            {vocab?.plain && <p className="mt-1.5 text-sm text-muted-foreground">{vocab.plain}</p>}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {item.targets.map((target) => (
            <Button key={`${target.type}:${target.id}`} asChild variant="outline" size="sm" className="max-w-full">
              <Link to={targetHref(target)}>
                <span className="truncate">{target.label}</span>
                {target.availability_status && (
                  <Badge variant="outline" className="ml-1.5 border-amber-300 text-amber-700">
                    {target.availability_status}
                  </Badge>
                )}
                <ArrowRight className="h-3.5 w-3.5 shrink-0" />
              </Link>
            </Button>
          ))}
          {item.count > item.targets.length && (
            <span className="self-center text-xs text-muted-foreground">
              …另有 {item.count - item.targets.length} 条未列出
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function AttentionPage() {
  const navigate = useNavigate();
  const { phase, credentialVerified } = useConsole();
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ApiResult<AttentionEnvelope> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setResult(await admin.attention());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (phase === "unlocked") {
      void load();
    } else {
      setLoading(false);
    }
  }, [load, phase]);

  // Setup is the one case where the operator genuinely has a fixed next step,
  // so it stays. Unlike the old card, it disappears once it stops being true.
  if (phase !== "unlocked" || credentialVerified === false) {
    const to = phase !== "unlocked" ? "/session" : "/credentials";
    const label = phase === "setup" ? "初始化控制台" : phase !== "unlocked" ? "解锁会话" : "配置管理凭据";
    const why =
      phase !== "unlocked"
        ? "控制台还没解锁，看不到任何业务数据。"
        : "管理凭据没通过验证，审批、计费、审计都取不到数据。";
    return (
      <div>
        <h1 className="mb-1 text-2xl font-bold">现在需要你做的事</h1>
        <p className="mb-5 text-muted-foreground">{why}</p>
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 pt-5">
            <Button onClick={() => navigate(to)}>
              {label}
              <ArrowRight className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground">完成后这里会显示真实待办。</span>
          </CardContent>
        </Card>
      </div>
    );
  }

  const envelope = result?.body ?? null;
  const items = envelope?.items ?? [];
  const actionable = items.filter((item) => item.severity === "action");
  const watch = items.filter((item) => item.severity !== "action");

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-2xl font-bold">现在需要你做的事</h1>
          <p className="text-muted-foreground">
            {envelope
              ? envelope.nothing_to_do
                ? "没有需要你处理的事。"
                : `${actionable.length} 类待处理，${watch.length} 类需留意。`
              : "正在读取…"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <DataState
        loading={loading}
        result={result && !result.ok ? result : null}
        emptyText=""
        onConfigureCredentials={() => navigate("/credentials")}
      >
        {envelope?.nothing_to_do ? (
          // Said plainly, not implied by three green lights.
          <Card className="border-emerald-200 bg-emerald-50/50">
            <CardContent className="flex items-start gap-3 pt-5">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div>
                <div className="font-semibold text-emerald-800">没有需要你处理的事</div>
                <p className="mt-1 text-sm text-emerald-700">
                  没有待审的热线或设备，没有卡住的调用，没有结束后仍冻结的资金，设备都在线。
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {actionable.map((item) => (
              <AttentionRow key={item.kind} item={item} />
            ))}
            {watch.length > 0 && (
              <>
                <div className="pt-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">需留意</div>
                {watch.map((item) => (
                  <AttentionRow key={item.kind} item={item} />
                ))}
              </>
            )}
          </div>
        )}

        {/* What this page deliberately cannot see. Silence about an unbuilt
            capability reads exactly like silence about a healthy one. */}
        {envelope?.not_tracked && envelope.not_tracked.length > 0 && (
          <div className="mt-6 rounded-xl border border-dashed border-border bg-muted/20 px-5 py-4">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <AlertTriangle className="h-4 w-4" />
              这个页面还看不到以下情况
            </div>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              {envelope.not_tracked.map((entry) => (
                <li key={entry.kind}>· {entry.reason}</li>
              ))}
            </ul>
          </div>
        )}

        {envelope && (
          <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground">
            <Inbox className="h-3.5 w-3.5" />
            读取于 {new Date(envelope.generated_at).toLocaleString()}
            <TechDetails raw={result?.raw} />
          </div>
        )}
      </DataState>
    </div>
  );
}
