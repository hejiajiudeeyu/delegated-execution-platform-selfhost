import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyChip, DataState, TechDetails } from "@/components/shared";
import { admin, gateway, type ApiResult } from "@/lib/api";

interface ListSpec {
  crumb: string;
  title: string;
  lead: string;
  emptyText: string;
  fetch: (offset: number) => Promise<ApiResult<{ items?: unknown[]; total?: number }>>;
  render: (item: Record<string, unknown>) => React.ReactNode;
  pageSize: number;
}

function usePagedList(spec: ListSpec) {
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<ApiResult<{ items?: unknown[]; total?: number }> | null>(null);
  const load = useCallback(async (nextOffset: number) => {
    setLoading(true);
    setResult(await spec.fetch(nextOffset));
    setOffset(nextOffset);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.fetch]);
  useEffect(() => { void load(0); }, [load]);
  return { offset, loading, result, load };
}

export function GenericListPage({ spec }: { spec: ListSpec }) {
  const navigate = useNavigate();
  const { offset, loading, result, load } = usePagedList(spec);
  const items = (result?.ok ? result.body?.items || [] : []) as Record<string, unknown>[];
  const total = result?.body?.total ?? null;

  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">{spec.crumb}</div>
      <h1 className="mb-1 text-2xl font-bold">{spec.title}</h1>
      <p className="mb-4 text-muted-foreground">{spec.lead}</p>
      <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Button variant="outline" size="sm" onClick={() => void load(0)}>刷新</Button>
        <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => void load(Math.max(0, offset - spec.pageSize))}>上一页</Button>
        <Button variant="outline" size="sm" disabled={items.length < spec.pageSize} onClick={() => void load(offset + spec.pageSize)}>下一页</Button>
        {total != null && <span>第 {offset + 1}–{offset + items.length} 条 / 共 {String(total)} 条</span>}
      </div>
      <DataState loading={loading} result={result && !result.ok ? result : null} emptyText={spec.emptyText} onConfigureCredentials={() => navigate("/credentials")}>
        {items.length === 0 ? null : (
          <div className="space-y-3">
            {items.map((item, i) => (
              <Card key={i}><CardContent className="pt-5">{spec.render(item)}<TechDetails raw={JSON.stringify(item, null, 2)} /></CardContent></Card>
            ))}
          </div>
        )}
      </DataState>
    </div>
  );
}

function StatusBadges({ item }: { item: Record<string, unknown> }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {typeof item.review_status === "string" && (
        <Badge variant="outline" className={item.review_status === "approved" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"}>
          {item.review_status === "approved" ? "已批准" : item.review_status === "pending" ? "待审核" : String(item.review_status)}
        </Badge>
      )}
      {typeof item.status === "string" && (
        <Badge variant="outline" className={item.status === "enabled" ? "bg-emerald-50 text-emerald-700" : "bg-muted text-muted-foreground"}>
          {item.status === "enabled" ? "已启用" : item.status === "disabled" ? "未启用" : String(item.status)}
        </Badge>
      )}
      {typeof item.availability_status === "string" && <Badge variant="outline">{String(item.availability_status)}</Badge>}
    </span>
  );
}

export function RespondersPage() {
  return (
    <GenericListPage
      spec={{
        crumb: "目录 / Responders",
        title: "Responders",
        lead: "已注册的服务方身份及其审核状态。",
        emptyText: "还没有注册的 Responder。",
        pageSize: 8,
        fetch: (offset) => admin.responders(`limit=8&offset=${offset}`),
        render: (item) => (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold">{String(item.display_name || item.responder_id)}</div>
              <div className="mt-1"><CopyChip value={String(item.responder_id)} /></div>
            </div>
            <StatusBadges item={item} />
          </div>
        )
      }}
    />
  );
}

export function HotlinesPage() {
  return (
    <GenericListPage
      spec={{
        crumb: "目录 / Hotlines",
        title: "Hotlines",
        lead: "目录中的热线及其审核/启用状态。",
        emptyText: "目录中还没有热线。",
        pageSize: 8,
        fetch: (offset) => admin.hotlines(`limit=8&offset=${offset}`),
        render: (item) => (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold">{String(item.display_name || item.hotline_id)}</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <CopyChip value={String(item.hotline_id)} />
                {(item.pricing_hint as Record<string, unknown> | null)?.fixed_price_cents != null && (
                  <Badge variant="outline">{String((item.pricing_hint as Record<string, unknown>).fixed_price_cents)} PTS / 次</Badge>
                )}
              </div>
            </div>
            <StatusBadges item={item} />
          </div>
        )
      }}
    />
  );
}

export function RequestsPage() {
  return (
    <GenericListPage
      spec={{
        crumb: "运营 / 请求",
        title: "请求",
        lead: "平台受理的调用请求与状态。",
        emptyText: "还没有请求记录。",
        pageSize: 8,
        fetch: (offset) => admin.requests(`limit=8&offset=${offset}`),
        render: (item) => (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="mt-1 flex flex-wrap gap-1.5">
                <CopyChip value={String(item.request_id)} />
                {typeof item.hotline_id === "string" && <CopyChip value={item.hotline_id} />}
              </div>
            </div>
            <Badge
              variant="outline"
              className={
                item.status === "SUCCEEDED" ? "bg-emerald-50 text-emerald-700" : item.status === "FAILED" ? "bg-red-50 text-red-700" : "bg-muted text-muted-foreground"
              }
            >
              {String(item.status || "—")}
            </Badge>
          </div>
        )
      }}
    />
  );
}

export function AuditPage() {
  return (
    <GenericListPage
      spec={{
        crumb: "资金 / 审计",
        title: "审计",
        lead: "平台侧管理与计费事件流水。",
        emptyText: "查询成功,但还没有审计事件。",
        pageSize: 10,
        fetch: (offset) => admin.auditEvents(`limit=10&offset=${offset}`),
        render: (item) => (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div className="min-w-0">
              <span className="font-medium">{String(item.event_name || item.event_type || "event")}</span>
              {typeof item.actor_type === "string" && <span className="ml-2 text-muted-foreground">by {item.actor_type}</span>}
            </div>
            <span className="text-muted-foreground">{item.at ? new Date(String(item.at)).toLocaleString() : ""}</span>
          </div>
        )
      }}
    />
  );
}

export function MarketplacePage() {
  return (
    <GenericListPage
      spec={{
        crumb: "目录 / Marketplace",
        title: "Marketplace(公开视角)",
        lead: "公开市场当前可见的热线——终端用户看到的就是这些。",
        emptyText: "公开市场当前没有可见热线。",
        pageSize: 20,
        fetch: async () => {
          const result = await gateway.proxy<{ items?: unknown[] }>("/v2/hotlines?status=enabled");
          return result;
        },
        render: (item) => (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold">{String(item.display_name || item.hotline_id)}</div>
              <div className="mt-1"><CopyChip value={String(item.hotline_id)} /></div>
            </div>
            <StatusBadges item={item} />
          </div>
        )
      }}
    />
  );
}
