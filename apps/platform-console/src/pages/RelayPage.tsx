import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Activity, RefreshCw, Search } from "lucide-react"
import { requestJson } from "@/lib/api"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/components/ui/utils"

interface HealthResponse {
  ok?: boolean
  service?: string
}

interface ReceiverHealthResponse {
  ok?: boolean
  receiver?: string
  queue_depth?: number
  error?: { message?: string }
}

const RELAY_HEALTH_PATH = "/proxy/relay/healthz"
const RELAY_RECEIVER_PATH = (id: string) => `/proxy/relay/v1/receivers/${encodeURIComponent(id)}/health`

export function RelayPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [healthStatus, setHealthStatus] = useState<number | null>(null)
  const [healthLoading, setHealthLoading] = useState(true)

  const [receiverId, setReceiverId] = useState("")
  const [probing, setProbing] = useState(false)
  const [receiverResult, setReceiverResult] = useState<{
    receiverId: string
    status: number
    body: ReceiverHealthResponse | null
  } | null>(null)

  const loadHealth = async () => {
    setHealthLoading(true)
    setHealthError(null)
    const res = await requestJson<HealthResponse>(RELAY_HEALTH_PATH)
    setHealthStatus(res.status)
    if (res.status >= 200 && res.status < 300) {
      setHealth(res.body)
    } else {
      setHealth(null)
      setHealthError(
        res.status === 404
          ? "Relay 网关未配置：platform-console-gateway 未把 /proxy/relay 转发到 transport-relay。"
          : `relay healthz 返回 ${res.status}`
      )
    }
    setHealthLoading(false)
  }

  useEffect(() => {
    loadHealth()
  }, [])

  const probeReceiver = async (e: React.FormEvent) => {
    e.preventDefault()
    const id = receiverId.trim()
    if (!id) return
    setProbing(true)
    const res = await requestJson<ReceiverHealthResponse>(RELAY_RECEIVER_PATH(id))
    setProbing(false)
    setReceiverResult({ receiverId: id, status: res.status, body: res.body })
    if (res.status >= 400) {
      toast.error(`receiver ${id} 探测失败 (${res.status})`)
    }
  }

  const healthOk = health?.ok === true && healthStatus !== null && healthStatus < 300

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold">Relay 监控</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            transport-relay 健康与按 receiver 的队列深度（基于现有 healthz / receiver health 端点）
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadHealth} disabled={healthLoading}>
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", healthLoading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Activity className="h-4 w-4 text-purple-500" />
            Relay healthz
          </CardTitle>
        </CardHeader>
        <CardContent>
          {healthLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : healthError ? (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {healthError}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <Badge
                variant={healthOk ? "outline" : "solid"}
                tone={healthOk ? null : "destructive"}
                className="text-[11px]"
              >
                {healthOk ? "OK" : "DOWN"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                service: <span className="font-mono">{health?.service ?? "—"}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                http: <span className="font-mono">{healthStatus ?? "—"}</span>
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">按 receiver 探测队列深度</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form onSubmit={probeReceiver} className="flex gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="receiver_id（responder/caller 的 inbox ID）"
                value={receiverId}
                onChange={(e) => setReceiverId(e.target.value)}
                className="pl-8 text-sm"
              />
            </div>
            <Button type="submit" size="sm" disabled={probing || !receiverId.trim()}>
              {probing ? "探测中…" : "探测"}
            </Button>
          </form>

          {receiverResult && (
            <div className="rounded border border-border bg-muted/30 p-3 text-xs">
              <div className="flex items-center gap-3 mb-1.5">
                <span className="font-mono">{receiverResult.receiverId}</span>
                <Badge
                  variant={receiverResult.status < 300 ? "outline" : "solid"}
                  tone={receiverResult.status < 300 ? null : "destructive"}
                  className="text-[10px]"
                >
                  HTTP {receiverResult.status}
                </Badge>
              </div>
              {receiverResult.body && (
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">
                  {JSON.stringify(receiverResult.body, null, 2)}
                </pre>
              )}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            transport-relay 现仅暴露 <span className="font-mono">/healthz</span> 和{" "}
            <span className="font-mono">/v1/receivers/:id/health</span>。in-flight、dropped、error 等聚合指标需要后续在
            relay 里加端点（platform-api 没有 relay 监控代理）。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
