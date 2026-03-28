import { useEffect, useState } from "react"
import { requestJson } from "@/lib/api"
import { useAuth } from "@/hooks/useAuth"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Activity, CheckCircle2, XCircle, Key, Save, AlertTriangle } from "lucide-react"

interface MetricsSummary {
  total_requests?: number
  active_responders?: number
  active_hotlines?: number
  requests_last_hour?: number
}

export function OverviewPage() {
  const { status } = useAuth()
  const [health, setHealth] = useState<{ ok: boolean } | null>(null)
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [proxyError, setProxyError] = useState("")
  const [credentials, setCredentials] = useState({ api_key: "" })
  const [credLoading, setCredLoading] = useState(false)
  const [credSaved, setCredSaved] = useState(false)

  const apiKeyConfigured = status?.auth?.admin_api_key_configured as boolean | undefined

  useEffect(() => {
    const load = async () => {
      try {
        const [h, m] = await Promise.all([
          requestJson<{ ok: boolean }>("/proxy/healthz"),
          requestJson<MetricsSummary>("/proxy/v1/metrics/summary"),
        ])
        if (h.status === 200 && h.body) {
          setHealth(h.body)
        } else {
          const err = h.body as { error?: { message?: string; code?: string } } | null
          if (err?.error?.code === "AUTH_CREDENTIALS_MISSING") {
            setProxyError("请先配置 Platform Admin API Key")
          } else {
            setProxyError(err?.error?.message ?? "无法连接 Platform API")
          }
        }
        if (m.status === 200 && m.body) setMetrics(m.body)
      } catch {
        setProxyError("网络错误")
      }
      setLoading(false)
    }
    load()
  }, [credSaved])

  const handleSaveCred = async () => {
    setCredLoading(true)
    const res = await requestJson("/credentials/platform-admin", {
      method: "PUT",
      body: { api_key: credentials.api_key },
    })
    setCredLoading(false)
    if (res.status === 200) {
      setCredSaved(true)
      setProxyError("")
      setHealth(null)
      setMetrics(null)
      setLoading(true)
      setTimeout(() => setCredSaved(false), 3000)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-base font-bold">Overview</h1>
        <p className="text-xs text-muted-foreground mt-0.5">平台健康状态与指标摘要</p>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Platform API 状态：</span>
        {loading ? (
          <Skeleton className="h-5 w-16" />
        ) : proxyError ? (
          <div className="flex items-center gap-1 text-yellow-600 text-xs font-semibold">
            <AlertTriangle className="h-3.5 w-3.5" /> {proxyError}
          </div>
        ) : health?.ok ? (
          <div className="flex items-center gap-1 text-green-600 text-xs font-semibold">
            <CheckCircle2 className="h-3.5 w-3.5" /> 正常
          </div>
        ) : (
          <div className="flex items-center gap-1 text-red-600 text-xs font-semibold">
            <XCircle className="h-3.5 w-3.5" /> 异常
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "总请求数", value: metrics?.total_requests },
          { label: "活跃 Responder", value: metrics?.active_responders },
          { label: "活跃 Hotline", value: metrics?.active_hotlines },
          { label: "近 1 小时请求", value: metrics?.requests_last_hour },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                <Activity className="h-3 w-3" /> {stat.label}
              </p>
              {loading ? (
                <Skeleton className="h-7 w-12" />
              ) : (
                <p className="text-2xl font-bold">{stat.value ?? "–"}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <Key className="h-4 w-4 text-purple-500" />
            Platform Admin 凭证
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {apiKeyConfigured ? (
              <span className="text-green-600 font-medium">✓ API Key 已配置</span>
            ) : (
              <span className="text-yellow-600 font-medium">⚠ API Key 未配置，需要设置后才能查看平台数据</span>
            )}
          </p>
          <div className="space-y-1.5">
            <Label>Admin API Key</Label>
            <Input
              type="password"
              placeholder="sk_admin_..."
              value={credentials.api_key}
              onChange={(e) => setCredentials({ api_key: e.target.value })}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSaveCred} disabled={credLoading || !credentials.api_key}>
              <Save className="h-3.5 w-3.5 mr-1.5" />
              {credLoading ? "保存中…" : "保存凭证"}
            </Button>
            {credSaved && (
              <span className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> 已保存，正在重新获取数据…
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
