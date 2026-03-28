import { useEffect, useState } from "react"
import { requestJson } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { RefreshCw, Search } from "lucide-react"
import { cn } from "@/components/ui/utils"

interface Request {
  request_id: string
  hotline_id?: string
  responder_id?: string
  status: string
  created_at?: string
}

const STATUS_VARIANT: Record<string, "outline" | "secondary" | "destructive"> = {
  completed: "outline",
  failed: "destructive",
  error: "destructive",
  timeout: "destructive",
  pending: "secondary",
  processing: "secondary",
}

export function RequestsPage() {
  const [items, setItems] = useState<Request[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")

  const load = async () => {
    setLoading(true)
    const res = await requestJson<{ items: Request[] }>("/proxy/v1/admin/requests")
    if (res.body?.items) setItems(res.body.items)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const filtered = items.filter((item) => {
    const q = query.toLowerCase()
    return !q ||
      item.request_id.toLowerCase().includes(q) ||
      (item.hotline_id ?? "").toLowerCase().includes(q) ||
      (item.responder_id ?? "").toLowerCase().includes(q)
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold">Request 监控</h1>
          <p className="text-xs text-muted-foreground mt-0.5">查看所有 Call 请求记录</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <div className="relative max-w-xs">
        <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="搜索 Request ID / Hotline…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-8 text-sm"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">暂无记录</p>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((req) => (
                <div key={req.request_id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-muted-foreground">
                        {req.request_id.slice(0, 16)}…
                      </span>
                      {req.hotline_id && (
                        <Badge variant="secondary" className="text-[10px]">
                          {req.hotline_id}
                        </Badge>
                      )}
                    </div>
                    {req.created_at && (
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {new Date(req.created_at).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <Badge
                    variant={STATUS_VARIANT[req.status] ?? "secondary"}
                    className="text-[10px] shrink-0 ml-3"
                  >
                    {req.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

interface AuditEvent {
  id?: string
  action?: string
  actor_id?: string
  actor_type?: string
  target_type?: string
  target_id?: string
  recorded_at?: string
}

interface Review {
  hotline_id?: string
  responder_id?: string
  review_status?: string
  status?: string
  submitted_at?: string
  _type: "hotline" | "responder"
}

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    requestJson<{ items: AuditEvent[] }>("/proxy/v1/admin/audit-events").then((res) => {
      if (res.body?.items) setEvents(res.body.items)
      setLoading(false)
    })
  }, [])

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-base font-bold">Audit 日志</h1>
        <p className="text-xs text-muted-foreground mt-0.5">平台操作审计记录</p>
      </div>
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
          ) : events.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">暂无审计记录</p>
          ) : (
            <div className="divide-y divide-border">
              {events.map((ev, i) => (
                <div key={ev.id ?? i} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">{ev.action ?? "unknown"}</p>
                    <p className="text-xs text-muted-foreground">
                      {[ev.actor_type, ev.actor_id].filter(Boolean).join(" · ")}
                      {ev.target_type && (
                        <span className="ml-2 opacity-60">→ {ev.target_type}{ev.target_id ? ` ${ev.target_id}` : ""}</span>
                      )}
                    </p>
                  </div>
                  {ev.recorded_at && (
                    <span className="text-[10px] text-muted-foreground shrink-0 ml-4">
                      {new Date(ev.recorded_at).toLocaleString()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export function ReviewsPage() {
  const [reviews, setReviews] = useState<Review[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    const [hotlinesRes, respondersRes] = await Promise.all([
      requestJson<{ items: Omit<Review, "_type">[] }>("/proxy/v2/admin/hotlines?review_status=pending"),
      requestJson<{ items: Omit<Review, "_type">[] }>("/proxy/v2/admin/responders?review_status=pending"),
    ])
    const hotlines: Review[] = (hotlinesRes.body?.items ?? []).map((i) => ({ ...i, _type: "hotline" as const }))
    const responders: Review[] = (respondersRes.body?.items ?? []).map((i) => ({ ...i, _type: "responder" as const }))
    setReviews([...hotlines, ...responders])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const handleAction = async (item: Review, action: "approve" | "reject") => {
    const entityId = item._type === "hotline" ? item.hotline_id : item.responder_id
    const entityPath = item._type === "hotline" ? "hotlines" : "responders"
    await requestJson(`/proxy/v2/admin/${entityPath}/${encodeURIComponent(entityId ?? "")}/${action}`, {
      method: "POST",
    })
    load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold">Review 队列</h1>
          <p className="text-xs text-muted-foreground mt-0.5">待审核的 Hotline / Responder 申请</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")} />
          刷新
        </Button>
      </div>
      <div className="space-y-2">
        {loading ? (
          [1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)
        ) : reviews.length === 0 ? (
          <div className="py-12 text-center text-sm font-medium text-foreground">审核队列为空</div>
        ) : (
          reviews.map((rev) => {
            const displayId = rev._type === "hotline" ? rev.hotline_id : rev.responder_id
            return (
              <Card key={displayId}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{displayId}</span>
                        <Badge variant="secondary" className="text-[10px]">{rev.review_status ?? "pending"}</Badge>
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">{rev._type}</Badge>
                      </div>
                      {rev._type === "hotline" && rev.responder_id && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Responder: {rev.responder_id}
                        </p>
                      )}
                      {rev.submitted_at && (
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          提交于 {new Date(rev.submitted_at).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <button
                        onClick={() => handleAction(rev, "approve")}
                        className="px-2.5 py-1 text-xs font-semibold rounded border bg-green-500/10 text-green-700 border-green-500/30 hover:bg-green-500/20 transition-colors"
                      >
                        批准
                      </button>
                      <button
                        onClick={() => handleAction(rev, "reject")}
                        className="px-2.5 py-1 text-xs font-semibold rounded border bg-red-500/10 text-red-700 border-red-500/30 hover:bg-red-500/20 transition-colors"
                      >
                        拒绝
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })
        )}
      </div>
    </div>
  )
}
