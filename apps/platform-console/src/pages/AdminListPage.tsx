import { useEffect, useState } from "react"
import { toast } from "sonner"
import { requestJson } from "@/lib/api"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { RefreshCw, Search } from "lucide-react"
import { cn } from "@/components/ui/utils"

type AdminAction = "approve" | "reject" | "enable" | "disable"

interface AdminItem {
  id: string
  display_name?: string
  status?: string
  enabled?: boolean
  created_at?: string
  [key: string]: unknown
}

interface AdminListPageProps {
  title: string
  subtitle: string
  listEndpoint: string
  actionEndpoint: (id: string, action: AdminAction) => string
  idField: string
  availableActions: (item: AdminItem) => AdminAction[]
  renderExtra?: (item: AdminItem) => React.ReactNode
  renderDetail?: (item: AdminItem) => React.ReactNode
  detailTitle?: (item: AdminItem) => string
}

const ACTION_LABELS: Record<AdminAction, string> = {
  approve: "批准",
  reject: "拒绝",
  enable: "启用",
  disable: "禁用",
}

const ACTION_STYLES: Record<AdminAction, string> = {
  approve: "bg-green-500/10 text-green-700 border-green-500/30 hover:bg-green-500/20",
  reject: "bg-red-500/10 text-red-700 border-red-500/30 hover:bg-red-500/20",
  enable: "bg-purple-500/10 text-purple-700 border-purple-500/30 hover:bg-purple-500/20",
  disable: "bg-muted text-muted-foreground border-border hover:bg-muted/80",
}

const STATUS_OK = new Set(["approved", "enabled", "active"])
const STATUS_BAD = new Set(["rejected", "failed", "error"])

function statusVariant(status: string): { variant: "outline" | "solid" | "dark"; tone: "destructive" | "neutral" | null } {
  if (STATUS_OK.has(status)) return { variant: "outline", tone: null }
  if (STATUS_BAD.has(status)) return { variant: "solid", tone: "destructive" }
  return { variant: "solid", tone: "neutral" }
}

function fmtDate(iso?: string | null) {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return String(iso)
  }
}

export function DetailRow({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("break-words", mono && "font-mono")}>{children ?? "—"}</span>
    </div>
  )
}

export function AdminListPage({
  title,
  subtitle,
  listEndpoint,
  actionEndpoint,
  idField,
  availableActions,
  renderExtra,
  renderDetail,
  detailTitle,
}: AdminListPageProps) {
  const [items, setItems] = useState<AdminItem[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [acting, setActing] = useState<string | null>(null)
  const [selected, setSelected] = useState<AdminItem | null>(null)

  const load = async () => {
    setLoading(true)
    const res = await requestJson<{ items: AdminItem[] }>(listEndpoint)
    if (res.body?.items) setItems(res.body.items)
    else if (res.status >= 400) toast.error(`加载失败 (${res.status})`)
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [listEndpoint])

  const handleAction = async (item: AdminItem, action: AdminAction, e?: React.MouseEvent) => {
    e?.stopPropagation()
    const id = String(item[idField])
    setActing(`${id}-${action}`)
    const res = await requestJson<{ error?: { message?: string } }>(actionEndpoint(id, action), { method: "POST" })
    setActing(null)
    if (res.status >= 400) {
      const msg = (res.body as { error?: { message?: string } } | null)?.error?.message
      toast.error(msg ?? `操作失败 (${res.status})`)
      return
    }
    toast.success(`${ACTION_LABELS[action]}成功`)
    setSelected(null)
    load()
  }

  const filtered = items.filter((item) => {
    const q = query.toLowerCase()
    const id = String(item[idField] ?? "")
    const name = String(item.display_name ?? "")
    return !q || id.toLowerCase().includes(q) || name.toLowerCase().includes(q)
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold">{title}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <div className="relative max-w-xs">
        <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="搜索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8 text-sm"
        />
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">{query ? "无匹配结果" : "暂无数据"}</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => {
            const id = String(item[idField])
            const status = String(item.status ?? (item.enabled ? "enabled" : "disabled"))
            const reviewStatus = item.review_status ? String(item.review_status) : null
            const actions = availableActions(item)
            const sv = statusVariant(status)
            const rsv = reviewStatus ? statusVariant(reviewStatus) : null
            return (
              <Card
                key={id}
                onClick={() => setSelected(item)}
                className="cursor-pointer transition-colors hover:border-purple-500/30"
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold">{item.display_name ?? id}</span>
                        <Badge variant={sv.variant} tone={sv.tone} className="shrink-0 text-[10px]">
                          {status}
                        </Badge>
                        {reviewStatus && reviewStatus !== status && rsv && (
                          <Badge variant={rsv.variant} tone={rsv.tone} className="shrink-0 text-[10px] opacity-70">
                            {reviewStatus}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{id}</p>
                      {renderExtra && renderExtra(item)}
                    </div>
                    {actions.length > 0 && (
                      <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                        {actions.map((action) => (
                          <button
                            key={action}
                            onClick={(e) => handleAction(item, action, e)}
                            disabled={acting === `${id}-${action}`}
                            className={cn(
                              "rounded border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50",
                              ACTION_STYLES[action]
                            )}
                          >
                            {acting === `${id}-${action}` ? "…" : ACTION_LABELS[action]}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{detailTitle ? detailTitle(selected) : String(selected[idField])}</SheetTitle>
                <SheetDescription className="font-mono text-xs">{String(selected[idField])}</SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 py-4">
                {renderDetail ? (
                  renderDetail(selected)
                ) : (
                  <pre className="overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-[11px]">
                    {JSON.stringify(selected, null, 2)}
                  </pre>
                )}
              </div>
              {availableActions(selected).length > 0 && (
                <div className="border-t border-border px-4 py-3">
                  <div className="flex flex-wrap gap-2">
                    {availableActions(selected).map((action) => {
                      const id = String(selected[idField])
                      return (
                        <button
                          key={action}
                          onClick={(e) => handleAction(selected, action, e)}
                          disabled={acting === `${id}-${action}`}
                          className={cn(
                            "rounded border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50",
                            ACTION_STYLES[action]
                          )}
                        >
                          {acting === `${id}-${action}` ? "…" : ACTION_LABELS[action]}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

interface ResponderHotlineSummary {
  hotline_id?: string
  display_name?: string
  status?: string
  review_status?: string
  catalog_visibility?: string
  availability_status?: string
}

function renderResponderDetail(item: AdminItem) {
  const hotlines = (item.hotlines as ResponderHotlineSummary[] | undefined) ?? []
  return (
    <div className="space-y-4">
      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">基础信息</h3>
        <DetailRow label="display_name">{item.display_name ?? "—"}</DetailRow>
        <DetailRow label="owner_user_id" mono>
          {(item.owner_user_id as string | undefined) ?? "—"}
        </DetailRow>
        <DetailRow label="contact_email">{(item.contact_email as string | undefined) ?? "—"}</DetailRow>
        <DetailRow label="support_email">{(item.support_email as string | undefined) ?? "—"}</DetailRow>
        <DetailRow label="status">{String(item.status ?? "—")}</DetailRow>
        <DetailRow label="review_status">{String(item.review_status ?? "—")}</DetailRow>
        <DetailRow label="reviewed_at">{fmtDate(item.reviewed_at as string | null | undefined)}</DetailRow>
        <DetailRow label="reviewed_by" mono>
          {(item.reviewed_by as string | undefined) ?? "—"}
        </DetailRow>
        {item.review_reason ? <DetailRow label="review_reason">{String(item.review_reason)}</DetailRow> : null}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">运行</h3>
        <DetailRow label="availability">{String(item.availability_status ?? "—")}</DetailRow>
        <DetailRow label="last_heartbeat">{fmtDate(item.last_heartbeat_at as string | null | undefined)}</DetailRow>
        <DetailRow label="hotline_count">{String(item.hotline_count ?? hotlines.length)}</DetailRow>
      </section>

      {hotlines.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">挂载的 Hotline</h3>
          <div className="overflow-hidden rounded border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-left">
                <tr>
                  <th className="px-2 py-1.5 font-medium">hotline_id</th>
                  <th className="px-2 py-1.5 font-medium">display</th>
                  <th className="px-2 py-1.5 font-medium">status</th>
                  <th className="px-2 py-1.5 font-medium">review</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {hotlines.map((h, i) => (
                  <tr key={h.hotline_id ?? i}>
                    <td className="px-2 py-1.5 font-mono">{h.hotline_id ?? "—"}</td>
                    <td className="px-2 py-1.5">{h.display_name ?? "—"}</td>
                    <td className="px-2 py-1.5">{h.status ?? "—"}</td>
                    <td className="px-2 py-1.5">{h.review_status ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

function renderHotlineDetail(item: AdminItem) {
  const capabilities = (item.capabilities as string[] | undefined) ?? []
  const tags = (item.tags as string[] | undefined) ?? []
  const taskTypes = (item.task_types as string[] | undefined) ?? []
  const lastTest = item.latest_review_test as
    | { status?: string; completed_at?: string; verdict?: string; review_test_id?: string }
    | undefined
  return (
    <div className="space-y-4">
      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">基础信息</h3>
        <DetailRow label="display_name">{item.display_name ?? "—"}</DetailRow>
        <DetailRow label="responder_id" mono>
          {(item.responder_id as string | undefined) ?? "—"}
        </DetailRow>
        <DetailRow label="status">{String(item.status ?? "—")}</DetailRow>
        <DetailRow label="review_status">{String(item.review_status ?? "—")}</DetailRow>
        <DetailRow label="catalog_visibility">{String(item.catalog_visibility ?? "—")}</DetailRow>
        <DetailRow label="availability">{String(item.availability_status ?? "—")}</DetailRow>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">能力声明</h3>
        <DetailRow label="task_types">{taskTypes.length ? taskTypes.join(", ") : "—"}</DetailRow>
        <DetailRow label="capabilities">{capabilities.length ? capabilities.join(", ") : "—"}</DetailRow>
        <DetailRow label="tags">{tags.length ? tags.join(", ") : "—"}</DetailRow>
      </section>

      {lastTest && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">最近一次审核测试</h3>
          <DetailRow label="review_test_id" mono>
            {lastTest.review_test_id ?? "—"}
          </DetailRow>
          <DetailRow label="status">{lastTest.status ?? "—"}</DetailRow>
          <DetailRow label="verdict">{lastTest.verdict ?? "—"}</DetailRow>
          <DetailRow label="completed_at">{fmtDate(lastTest.completed_at)}</DetailRow>
        </section>
      )}
    </div>
  )
}

export function RespondersPage() {
  return (
    <AdminListPage
      title="Responder 管理"
      subtitle="审核和管理已注册的 Responder"
      listEndpoint="/proxy/v2/admin/responders"
      actionEndpoint={(id, action) => `/proxy/v2/admin/responders/${encodeURIComponent(id)}/${action}`}
      idField="responder_id"
      availableActions={(item) => {
        const reviewStatus = String(item.review_status ?? "")
        const status = String(item.status ?? "")
        if (reviewStatus === "pending") return ["approve", "reject"]
        if (reviewStatus === "rejected") return ["approve"]
        if (status === "enabled") return ["disable"]
        if (status === "disabled" && reviewStatus === "approved") return ["enable"]
        return []
      }}
      renderDetail={renderResponderDetail}
      detailTitle={(item) => String(item.display_name ?? item.responder_id ?? "Responder")}
    />
  )
}

export function HotlinesAdminPage() {
  return (
    <AdminListPage
      title="Hotline 管理"
      subtitle="审核和管理已发布的 Hotline"
      listEndpoint="/proxy/v2/admin/hotlines"
      actionEndpoint={(id, action) => `/proxy/v2/admin/hotlines/${encodeURIComponent(id)}/${action}`}
      idField="hotline_id"
      availableActions={(item) => {
        const reviewStatus = String(item.review_status ?? "")
        const status = String(item.status ?? "")
        if (reviewStatus === "pending") return ["approve", "reject"]
        if (reviewStatus === "rejected") return ["approve"]
        if (status === "enabled") return ["disable"]
        if (status === "disabled" && reviewStatus === "approved") return ["enable"]
        return []
      }}
      renderExtra={(item) =>
        item.responder_id ? (
          <p className="mt-0.5 text-xs text-muted-foreground">Responder: {String(item.responder_id)}</p>
        ) : null
      }
      renderDetail={renderHotlineDetail}
      detailTitle={(item) => String(item.display_name ?? item.hotline_id ?? "Hotline")}
    />
  )
}
