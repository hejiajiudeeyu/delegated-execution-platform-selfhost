import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { gateway, type ApiResult } from "@/lib/api";
import { PHASE_LABEL, useConsole } from "@/state/console";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";

function HealthRow({ label, ok, detail }: { label: string; ok: boolean | null; detail?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border/60 py-2.5 text-sm last:border-0">
      <span>{label}</span>
      <span className="flex items-center gap-1.5">
        {ok === null ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : ok ? (
          <><CheckCircle2 className="h-4 w-4 text-emerald-600" /><span className="text-emerald-700">{detail || "正常"}</span></>
        ) : (
          <><CircleAlert className="h-4 w-4 text-red-600" /><span className="text-red-700">{detail || "异常"}</span></>
        )}
      </span>
    </div>
  );
}

export function OverviewPage() {
  const { phase, credentialVerified } = useConsole();
  const [health, setHealth] = useState<ApiResult | null>(null);
  useEffect(() => {
    void gateway.healthz().then(setHealth);
  }, []);

  const nextStep =
    phase !== "unlocked"
      ? { to: "/session", label: phase === "setup" ? "初始化控制台 →" : "解锁会话 →", text: "先在“会话与解锁”完成身份验证。" }
      : credentialVerified !== true
        ? { to: "/credentials", label: "配置并验证凭据 →", text: "保存 Operator API Key 并通过平台验证后,审批/计费/审计可用。" }
        : { to: "/reviews", label: "查看审批队列 →", text: "一切就绪。新提交会出现在审批队列。" };

  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">概览</div>
      <h1 className="mb-1 text-2xl font-bold">总览</h1>
      <p className="mb-5 text-muted-foreground">运营者控制台:审核上架、管理目录、查看计费与审计。</p>

      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">下一步</CardTitle></CardHeader>
          <CardContent>
            <p className="mb-3 text-sm text-muted-foreground">{nextStep.text}</p>
            <Button asChild><Link to={nextStep.to}>{nextStep.label}</Link></Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">健康状态</CardTitle></CardHeader>
          <CardContent>
            <HealthRow label="网关(platform-console-gateway)" ok={health ? health.ok : null} detail={health?.ok ? "正常" : "无应答"} />
            <HealthRow label="控制台会话" ok={phase === "unlocked" ? true : null} detail={PHASE_LABEL[phase]} />
            <HealthRow
              label="管理凭据"
              ok={credentialVerified}
              detail={credentialVerified === true ? "已验证" : credentialVerified === false ? "无效" : phase === "unlocked" ? "验证中…" : "待解锁"}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
