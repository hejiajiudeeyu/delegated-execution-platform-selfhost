import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActionResult, BusyButton, CopyChip, DataState, Lifecycle, useAction } from "@/components/shared";
import { admin, type ApiResult } from "@/lib/api";
import { toast } from "sonner";

interface ReviewEntity {
  kind: "responders" | "hotlines";
  id: string;
  title: string;
  stage: "pending" | "approved" | "enabled";
  detail: Record<string, unknown>;
}

function normalize(kind: "responders" | "hotlines", stage: "pending" | "approved", items: unknown[]): ReviewEntity[] {
  return (items as Record<string, unknown>[]).map((item) => {
    const id = String(kind === "responders" ? item.responder_id : item.hotline_id);
    return {
      kind,
      id,
      title: String(item.display_name || id),
      stage,
      detail: item
    };
  });
}

function EntityCard({ entity, onDone }: { entity: ReviewEntity; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const act = useAction(async (action: "approve" | "enable" | "reject"): Promise<ApiResult> => {
    const r = await admin.reviewAction(entity.kind, entity.id, action, reason.trim() || null);
    if (r.ok) {
      toast.success(`${entity.title}:${action === "approve" ? "已批准" : action === "enable" ? "已启用" : "已驳回"}`);
      onDone();
    }
    return r;
  });
  const price = (entity.detail.pricing_hint as Record<string, unknown> | null)?.fixed_price_cents;
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-semibold">{entity.title}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <CopyChip value={entity.id} />
              <Badge variant="outline">{entity.kind === "responders" ? "Responder" : "Hotline"}</Badge>
              {price != null && <Badge variant="outline">{String(price)} PTS / 次</Badge>}
              {typeof entity.detail.trust_tier === "string" && <Badge variant="outline">{entity.detail.trust_tier}</Badge>}
            </div>
            {typeof entity.detail.submitted_at === "string" && (
              <div className="mt-1.5 text-sm text-muted-foreground">提交于 {new Date(entity.detail.submitted_at).toLocaleString()}</div>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            {entity.stage === "pending" && (
              <>
                <BusyButton busy={act.busy} onClick={() => void act.run("approve")}>批准</BusyButton>
                <BusyButton variant="outline" className="border-red-200 text-red-600 hover:bg-red-50" busy={act.busy} onClick={() => void act.run("reject")}>
                  驳回
                </BusyButton>
              </>
            )}
            {entity.stage === "approved" && (
              <BusyButton busy={act.busy} onClick={() => void act.run("enable")}>启用(上市场)</BusyButton>
            )}
          </div>
        </div>
        <Lifecycle stage={entity.stage} />
        {entity.stage === "pending" && (
          <div className="mt-3 max-w-lg">
            <Label htmlFor={`reason-${entity.id}`} className="text-xs text-muted-foreground">审核备注(可选,写入审计)</Label>
            <Input id={`reason-${entity.id}`} value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1" placeholder="operator review" />
          </div>
        )}
        <ActionResult result={act.result?.ok ? null : act.result} />
      </CardContent>
    </Card>
  );
}

export function ReviewQueuePage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"pending" | "recent">("pending");
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<ApiResult | null>(null);
  const [pending, setPending] = useState<ReviewEntity[]>([]);
  const [toEnable, setToEnable] = useState<ReviewEntity[]>([]);
  const [recent, setRecent] = useState<ReviewEntity[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const [pr, ph, ar, ah, er, eh] = await Promise.all([
      admin.responders("review_status=pending&limit=50"),
      admin.hotlines("review_status=pending&limit=50"),
      admin.responders("review_status=approved&status=disabled&limit=50"),
      admin.hotlines("review_status=approved&status=disabled&limit=50"),
      admin.responders("review_status=approved&status=enabled&limit=10"),
      admin.hotlines("review_status=approved&status=enabled&limit=10")
    ]);
    const firstFailure = [pr, ph, ar, ah, er, eh].find((r) => !r.ok);
    setFailure(firstFailure || null);
    setPending([...normalize("responders", "pending", pr.body?.items || []), ...normalize("hotlines", "pending", ph.body?.items || [])]);
    setToEnable([...normalize("responders", "approved", ar.body?.items || []), ...normalize("hotlines", "approved", ah.body?.items || [])]);
    setRecent(
      [...normalize("responders", "approved", er.body?.items || []), ...normalize("hotlines", "approved", eh.body?.items || [])].map((e) => ({
        ...e,
        stage: "enabled" as const
      }))
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const actionable = [...pending, ...toEnable];

  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">运营 / 审批队列</div>
      <h1 className="mb-1 text-2xl font-bold">审批队列</h1>
      <p className="mb-4 text-muted-foreground">新提交的 Responder 与 Hotline 在这里审核;“批准 → 启用”两步后进入公开市场。</p>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "pending" | "recent")}>
          <TabsList>
            <TabsTrigger value="pending">待处理 ({actionable.length})</TabsTrigger>
            <TabsTrigger value="recent">最近已启用 ({recent.length})</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button variant="outline" size="sm" onClick={() => void load()}>刷新</Button>
      </div>

      <DataState
        loading={loading}
        result={failure}
        emptyText={
          tab === "pending"
            ? "当前没有待处理的提交 ✓ 新的 submit-review 会自动出现在这里。"
            : "还没有已启用的条目。"
        }
        onConfigureCredentials={() => navigate("/credentials")}
      >
        {(tab === "pending" ? actionable : recent).length === 0 ? null : (
          <div className="space-y-4">
            {(tab === "pending" ? actionable : recent).map((entity) => (
              <EntityCard key={`${entity.kind}:${entity.id}:${entity.stage}`} entity={entity} onDone={() => void load()} />
            ))}
          </div>
        )}
      </DataState>
    </div>
  );
}
