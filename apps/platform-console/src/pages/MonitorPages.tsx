import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react"
import { requestJson } from "@/lib/api"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/components/ui/utils"
import { DetailRow } from "@/pages/AdminListPage"

const PAGE_SIZE = 25

interface Pagination {
  total?: number
  limit?: number
  offset?: number
  has_more?: boolean
}

function fmtDate(iso?: string | null) {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return String(iso)
  }
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || v === null) continue
    usp.set(k, String(v))
  }
  const s = usp.toString()
  return s ? `?${s}` : ""
}

function PaginationBar({
  pagination,
  offset,
  onOffsetChange,
  loading,
}: {
  pagination: Pagination | null
  offset: number
  onOffsetChange: (next: number) => void
  loading: boolean
}) {
  const total = pagination?.total
  const limit = pagination?.limit ?? PAGE_SIZE
  const hasMore = pagination?.has_more === true
  const start = offset + 1
  const end = offset + (pagination?.limit ?? 0)
  return (
    <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
      <span>
        {total != null ? `${start}-${Math.min(end, total)} / ${total}` : `offset ${offset}`}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={loading || offset === 0}
        onClick={() => onOffsetChange(Math.max(0, offset - limit))}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={loading || !hasMore}
        onClick={() => onOffsetChange(offset + limit)}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

interface RequestEvent {
  at?: string
  event_type?: string
  [key: string]: unknown
}

interface RequestSummary {
  request_id: string
  caller_id?: string | null
  responder_id?: string | null
  hotline_id?: string | null
  request_kind?: string
  request_visibility?: string
  event_count?: number
  latest_event?: RequestEvent | null
}

const REQUEST_EVENT_TONE: Record<string, "neutral" | "destructive"> = {
  TASK_TOKEN_ISSUED: "neutral",
  DELIVERY_META_ISSUED: "neutral",
  ACKED: "neutral",
  COMPLETED: "neutral",
  FAILED: "destructive",
  TIMED_OUT: "destructive",
}

export function RequestsPage() {
  const [items, setItems] = useState<RequestSummary[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [offset, setOffset] = useState(0)
  const [q, setQ] = useState("")
  const [callerFilter, setCallerFilter] = useState("")
  const [responderFilter, setResponderFilter] = useState("")
  const [hotlineFilter, setHotlineFilter] = useState("")
  const [eventTypeFilter, setEventTypeFilter] = useState("")
  const [selected, setSelected] = useState<RequestSummary | null>(null)

  const load = async () => {
    setLoading(true)
    const path =
      "/proxy/v1/admin/requests" +
      buildQuery({
        limit: PAGE_SIZE,
        offset,
        q: q || undefined,
        caller_id: callerFilter || undefined,
        responder_id: responderFilter || undefined,
        hotline_id: hotlineFilter || undefined,
        event_type: eventTypeFilter || undefined,
      })
    const res = await requestJson<{ items: RequestSummary[]; pagination?: Pagination }>(path)
    if (res.body) {
      setItems(res.body.items ?? [])
      setPagination(res.body.pagination ?? null)
    } else if (res.status >= 400) {
      toast.error(`加载请求失败 (${res.status})`)
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset])

  const submitFilters = (e: React.FormEvent) => {
    e.preventDefault()
    if (offset === 0) load()
    else setOffset(0)
  }

  const clearFilters = () => {
    setQ("")
    setCallerFilter("")
    setResponderFilter("")
    setHotlineFilter("")
    setEventTypeFilter("")
    if (offset === 0) load()
    else setOffset(0)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold">Request 监控</h1>
          <p className="text-xs text-muted-foreground mt-0.5">查看所有 Call 请求与事件时间线</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <Card>
        <CardContent className="p-3">
          <form onSubmit={submitFilters} className="grid grid-cols-1 gap-2 md:grid-cols-5">
            <div className="relative md:col-span-2">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="搜索 request / caller / responder / hotline…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-8 text-sm"
              />
            </div>
            <Input placeholder="caller_id" value={callerFilter} onChange={(e) => setCallerFilter(e.target.value)} className="text-sm" />
            <Input placeholder="responder_id" value={responderFilter} onChange={(e) => setResponderFilter(e.target.value)} className="text-sm" />
            <Input placeholder="hotline_id" value={hotlineFilter} onChange={(e) => setHotlineFilter(e.target.value)} className="text-sm" />
            <Input
              placeholder="event_type (e.g. COMPLETED)"
              value={eventTypeFilter}
              onChange={(e) => setEventTypeFilter(e.target.value)}
              className="text-sm md:col-span-2"
            />
            <div className="flex gap-2 md:col-span-3 md:justify-end">
              <Button type="submit" size="sm" disabled={loading}>
                应用
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={clearFilters} disabled={loading}>
                清空
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <PaginationBar pagination={pagination} offset={offset} onOffsetChange={setOffset} loading={loading} />

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-2 p-4">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">暂无记录</p>
          ) : (
            <div className="divide-y divide-border">
              {items.map((req) => {
                const eventType = req.latest_event?.event_type ?? "—"
                const tone = REQUEST_EVENT_TONE[eventType] ?? "neutral"
                return (
                  <button
                    key={req.request_id}
                    type="button"
                    onClick={() => setSelected(req)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs">{req.request_id.slice(0, 24)}…</span>
                        {req.hotline_id && (
                          <Badge variant="outline" className="text-[10px]">
                            {req.hotline_id}
                          </Badge>
                        )}
                        {req.request_visibility && req.request_visibility !== "public" && (
                          <Badge variant="solid" tone="neutral" className="text-[10px]">
                            {req.request_visibility}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {(req.caller_id ?? "?")} → {(req.responder_id ?? "?")} · {req.event_count ?? 0} events
                        {req.latest_event?.at ? ` · ${fmtDate(req.latest_event.at)}` : ""}
                      </p>
                    </div>
                    <Badge variant="solid" tone={tone} className="ml-3 shrink-0 text-[10px]">
                      {eventType}
                    </Badge>
                  </button>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-2xl">
          {selected && <RequestDetail request={selected} />}
        </SheetContent>
      </Sheet>
    </div>
  )
}

function RequestDetail({ request }: { request: RequestSummary }) {
  const [events, setEvents] = useState<RequestEvent[] | null>(null)
  const [eventsError, setEventsError] = useState<string | null>(null)
  const [eventsLoading, setEventsLoading] = useState(true)

  useEffect(() => {
    let active = true
    setEventsLoading(true)
    setEventsError(null)
    requestJson<{ events: RequestEvent[]; items?: RequestEvent[] }>(
      `/proxy/v1/requests/${encodeURIComponent(request.request_id)}/events`
    )
      .then((res) => {
        if (!active) return
        if (res.status >= 200 && res.status < 300) {
          setEvents(res.body?.events ?? res.body?.items ?? [])
        } else {
          setEvents(null)
          setEventsError(`加载事件失败 (${res.status})`)
        }
      })
      .finally(() => {
        if (active) setEventsLoading(false)
      })
    return () => {
      active = false
    }
  }, [request.request_id])

  return (
    <>
      <SheetHeader>
        <SheetTitle>Request 详情</SheetTitle>
        <SheetDescription className="font-mono text-xs">{request.request_id}</SheetDescription>
      </SheetHeader>
      <div className="space-y-4 px-4 py-4">
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">基础信息</h3>
          <DetailRow label="caller_id" mono>
            {request.caller_id ?? "—"}
          </DetailRow>
          <DetailRow label="responder_id" mono>
            {request.responder_id ?? "—"}
          </DetailRow>
          <DetailRow label="hotline_id" mono>
            {request.hotline_id ?? "—"}
          </DetailRow>
          <DetailRow label="request_kind">{request.request_kind ?? "—"}</DetailRow>
          <DetailRow label="request_visibility">{request.request_visibility ?? "—"}</DetailRow>
          <DetailRow label="event_count">{String(request.event_count ?? 0)}</DetailRow>
        </section>

        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">事件时间线</h3>
          {eventsLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : eventsError ? (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {eventsError}
            </div>
          ) : events && events.length > 0 ? (
            <ol className="space-y-2">
              {events.map((ev, i) => {
                const tone = REQUEST_EVENT_TONE[String(ev.event_type ?? "")] ?? "neutral"
                return (
                  <li key={i} className="rounded border border-border bg-muted/20 p-2 text-xs">
                    <div className="flex items-center gap-2">
                      <Badge variant="solid" tone={tone} className="text-[10px]">
                        {ev.event_type ?? "?"}
                      </Badge>
                      <span className="text-muted-foreground">{fmtDate(ev.at as string | undefined)}</span>
                    </div>
                    <pre className="mt-1.5 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">
                      {JSON.stringify(ev, null, 2)}
                    </pre>
                  </li>
                )
              })}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">暂无事件</p>
          )}
        </section>

        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">运维操作</h3>
          <p className="text-[11px] text-muted-foreground">
            cancel / re-issue 当前未在 platform-api 中暴露，需要先在 platform-api 增加端点。
          </p>
        </section>
      </div>
    </>
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
  [key: string]: unknown
}

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [offset, setOffset] = useState(0)
  const [q, setQ] = useState("")
  const [actionFilter, setActionFilter] = useState("")
  const [actorTypeFilter, setActorTypeFilter] = useState("")
  const [targetTypeFilter, setTargetTypeFilter] = useState("")
  const [selected, setSelected] = useState<AuditEvent | null>(null)

  const load = async () => {
    setLoading(true)
    const path =
      "/proxy/v1/admin/audit-events" +
      buildQuery({
        limit: PAGE_SIZE,
        offset,
        q: q || undefined,
        action: actionFilter || undefined,
        actor_type: actorTypeFilter || undefined,
        target_type: targetTypeFilter || undefined,
      })
    const res = await requestJson<{ items: AuditEvent[]; pagination?: Pagination }>(path)
    if (res.body) {
      setEvents(res.body.items ?? [])
      setPagination(res.body.pagination ?? null)
    } else if (res.status >= 400) {
      toast.error(`加载审计失败 (${res.status})`)
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset])

  const submitFilters = (e: React.FormEvent) => {
    e.preventDefault()
    if (offset === 0) load()
    else setOffset(0)
  }

  const clearFilters = () => {
    setQ("")
    setActionFilter("")
    setActorTypeFilter("")
    setTargetTypeFilter("")
    if (offset === 0) load()
    else setOffset(0)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold">Audit 日志</h1>
          <p className="text-xs text-muted-foreground mt-0.5">平台操作审计记录</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <Card>
        <CardContent className="p-3">
          <form onSubmit={submitFilters} className="grid grid-cols-1 gap-2 md:grid-cols-5">
            <div className="relative md:col-span-2">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="搜索 action / actor / target…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-8 text-sm"
              />
            </div>
            <Input placeholder="action" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="text-sm" />
            <Input placeholder="actor_type" value={actorTypeFilter} onChange={(e) => setActorTypeFilter(e.target.value)} className="text-sm" />
            <Input placeholder="target_type" value={targetTypeFilter} onChange={(e) => setTargetTypeFilter(e.target.value)} className="text-sm" />
            <div className="flex gap-2 md:col-span-5 md:justify-end">
              <Button type="submit" size="sm" disabled={loading}>
                应用
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={clearFilters} disabled={loading}>
                清空
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <PaginationBar pagination={pagination} offset={offset} onOffsetChange={setOffset} loading={loading} />

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-2 p-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">暂无审计记录</p>
          ) : (
            <div className="divide-y divide-border">
              {events.map((ev, i) => (
                <button
                  key={ev.id ?? i}
                  type="button"
                  onClick={() => setSelected(ev)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                >
                  <div>
                    <p className="text-sm font-medium">{ev.action ?? "unknown"}</p>
                    <p className="text-xs text-muted-foreground">
                      {[ev.actor_type, ev.actor_id].filter(Boolean).join(" · ")}
                      {ev.target_type && (
                        <span className="ml-2 opacity-60">
                          → {ev.target_type}
                          {ev.target_id ? ` ${ev.target_id}` : ""}
                        </span>
                      )}
                    </p>
                  </div>
                  {ev.recorded_at && (
                    <span className="ml-4 shrink-0 text-[10px] text-muted-foreground">{fmtDate(ev.recorded_at)}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.action ?? "Audit Event"}</SheetTitle>
                <SheetDescription className="font-mono text-xs">{selected.id ?? "—"}</SheetDescription>
              </SheetHeader>
              <div className="space-y-3 px-4 py-4 text-xs">
                <DetailRow label="recorded_at">{fmtDate(selected.recorded_at)}</DetailRow>
                <DetailRow label="actor">
                  {[selected.actor_type, selected.actor_id].filter(Boolean).join(" · ") || "—"}
                </DetailRow>
                <DetailRow label="target">
                  {[selected.target_type, selected.target_id].filter(Boolean).join(" · ") || "—"}
                </DetailRow>
                <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 font-mono text-[11px]">
                  {JSON.stringify(selected, null, 2)}
                </pre>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

interface ReviewSummary {
  hotline_id?: string
  responder_id?: string
  display_name?: string
  review_status?: string
  status?: string
  submitted_at?: string
  responder_id_for_hotline?: string
  _type: "hotline" | "responder"
}

export function ReviewsPage() {
  const [reviews, setReviews] = useState<ReviewSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState<string | null>(null)
  const [rejectFor, setRejectFor] = useState<ReviewSummary | null>(null)
  const [rejectReason, setRejectReason] = useState("")

  const load = async () => {
    setLoading(true)
    const [hotlinesRes, respondersRes] = await Promise.all([
      requestJson<{ items: Omit<ReviewSummary, "_type">[] }>("/proxy/v2/admin/hotlines?review_status=pending"),
      requestJson<{ items: Omit<ReviewSummary, "_type">[] }>("/proxy/v2/admin/responders?review_status=pending"),
    ])
    const hotlines: ReviewSummary[] = (hotlinesRes.body?.items ?? []).map((i) => ({ ...i, _type: "hotline" as const }))
    const responders: ReviewSummary[] = (respondersRes.body?.items ?? []).map((i) => ({ ...i, _type: "responder" as const }))
    setReviews([...hotlines, ...responders])
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  const submitAction = async (item: ReviewSummary, action: "approve" | "reject", reason?: string) => {
    const entityId = item._type === "hotline" ? item.hotline_id : item.responder_id
    if (!entityId) return
    const entityPath = item._type === "hotline" ? "hotlines" : "responders"
    setActing(`${entityId}-${action}`)
    const res = await requestJson<{ error?: { message?: string } }>(
      `/proxy/v2/admin/${entityPath}/${encodeURIComponent(entityId)}/${action}`,
      { method: "POST", body: reason ? { reason } : undefined }
    )
    setActing(null)
    if (res.status >= 400) {
      const msg = (res.body as { error?: { message?: string } } | null)?.error?.message
      toast.error(msg ?? `操作失败 (${res.status})`)
      return
    }
    toast.success(`${action === "approve" ? "批准" : "拒绝"}成功`)
    setRejectFor(null)
    setRejectReason("")
    load()
  }

  const queue = useMemo(() => reviews, [reviews])

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
        ) : queue.length === 0 ? (
          <div className="py-12 text-center text-sm font-medium text-foreground">审核队列为空</div>
        ) : (
          queue.map((rev) => {
            const displayId = rev._type === "hotline" ? rev.hotline_id : rev.responder_id
            const key = `${rev._type}-${displayId}`
            return (
              <Card key={key}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{rev.display_name ?? displayId}</span>
                        <Badge variant="solid" tone="neutral" className="text-[10px]">
                          {rev.review_status ?? "pending"}
                        </Badge>
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          {rev._type}
                        </Badge>
                      </div>
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{displayId}</p>
                      {rev._type === "hotline" && rev.responder_id && (
                        <p className="mt-0.5 text-xs text-muted-foreground">Responder: {rev.responder_id}</p>
                      )}
                      {rev.submitted_at && (
                        <p className="mt-0.5 text-[10px] text-muted-foreground">提交于 {fmtDate(rev.submitted_at)}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        onClick={() => submitAction(rev, "approve")}
                        disabled={acting === `${displayId}-approve`}
                        className="rounded border border-green-500/30 bg-green-500/10 px-2.5 py-1 text-xs font-semibold text-green-700 transition-colors hover:bg-green-500/20 disabled:opacity-50"
                      >
                        {acting === `${displayId}-approve` ? "…" : "批准"}
                      </button>
                      <button
                        onClick={() => {
                          setRejectFor(rev)
                          setRejectReason("")
                        }}
                        disabled={acting === `${displayId}-reject`}
                        className="rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-700 transition-colors hover:bg-red-500/20 disabled:opacity-50"
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

      <Sheet open={rejectFor !== null} onOpenChange={(open) => !open && (setRejectFor(null), setRejectReason(""))}>
        <SheetContent className="sm:max-w-md">
          {rejectFor && (
            <>
              <SheetHeader>
                <SheetTitle>拒绝 {rejectFor._type === "hotline" ? "Hotline" : "Responder"}</SheetTitle>
                <SheetDescription className="font-mono text-xs">
                  {rejectFor._type === "hotline" ? rejectFor.hotline_id : rejectFor.responder_id}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-3 px-4 py-4">
                <Input
                  placeholder="拒绝原因（可选）"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setRejectFor(null)
                      setRejectReason("")
                    }}
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => submitAction(rejectFor, "reject", rejectReason.trim() || undefined)}
                    disabled={acting !== null}
                  >
                    确认拒绝
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
