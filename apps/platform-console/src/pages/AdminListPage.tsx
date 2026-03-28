import { useEffect, useState } from "react"
import { requestJson } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
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
  accentColor?: string
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

const STATUS_VARIANT: Record<string, "outline" | "secondary" | "destructive"> = {
  approved: "outline",
  enabled: "outline",
  active: "outline",
  rejected: "destructive",
  disabled: "secondary",
  pending: "secondary",
  pending_review: "secondary",
}

export function AdminListPage({
  title,
  subtitle,
  listEndpoint,
  actionEndpoint,
  idField,
  availableActions,
  renderExtra,
}: AdminListPageProps) {
  const [items, setItems] = useState<AdminItem[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [acting, setActing] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    const res = await requestJson<{ items: AdminItem[] }>(listEndpoint)
    if (res.body?.items) setItems(res.body.items)
    setLoading(false)
  }

  useEffect(() => { load() }, [listEndpoint])

  const handleAction = async (item: AdminItem, action: AdminAction) => {
    const id = String(item[idField])
    setActing(`${id}-${action}`)
    setActionError(null)
    const res = await requestJson<{ error?: { message?: string } }>(actionEndpoint(id, action), { method: "POST" })
    setActing(null)
    if (res.status >= 400) {
      const msg = (res.body as { error?: { message?: string } } | null)?.error?.message
      setActionError(msg ?? `操作失败（${res.status}）`)
      return
    }
    setItems((prev) => prev.filter((i) => String(i[idField]) !== id))
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

      {actionError && (
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
          {actionError}
        </div>
      )}

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
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {query ? "无匹配结果" : "暂无数据"}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => {
            const id = String(item[idField])
            const status = String(item.status ?? (item.enabled ? "enabled" : "disabled"))
            const reviewStatus = item.review_status ? String(item.review_status) : null
            const actions = availableActions(item)
            return (
              <Card key={id} className="hover:border-purple-500/30 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold truncate">
                          {item.display_name ?? id}
                        </span>
                        <Badge
                          variant={STATUS_VARIANT[status] ?? "secondary"}
                          className="text-[10px] shrink-0"
                        >
                          {status}
                        </Badge>
                        {reviewStatus && reviewStatus !== status && (
                          <Badge
                            variant={STATUS_VARIANT[reviewStatus] ?? "secondary"}
                            className="text-[10px] shrink-0 opacity-70"
                          >
                            {reviewStatus}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs font-mono text-muted-foreground mt-0.5 truncate">
                        {id}
                      </p>
                      {renderExtra && renderExtra(item)}
                    </div>
                    {actions.length > 0 && (
                      <div className="flex gap-1.5 shrink-0 flex-wrap justify-end">
                        {actions.map((action) => (
                          <button
                            key={action}
                            onClick={() => handleAction(item, action)}
                            disabled={acting === `${id}-${action}`}
                            className={cn(
                              "px-2.5 py-1 text-xs font-semibold rounded border transition-colors disabled:opacity-50",
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
          <p className="text-xs text-muted-foreground mt-0.5">
            Responder: {String(item.responder_id)}
          </p>
        ) : null
      }
    />
  )
}
