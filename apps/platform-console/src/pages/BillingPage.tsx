import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { AlertTriangle, CreditCard, Plus, RefreshCw, Search } from "lucide-react"
import { requestJson } from "@/lib/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/components/ui/utils"

interface BillingWindow {
  window_kind: string
  window_started_at?: string
  max_amount_cents?: number | null
  used_as_caller_cents: number
  earned_as_responder_cents: number
  hard_block_on_exceed: boolean
}

interface BillingBalance {
  tenant_id: string
  credit_balance_cents: number
  pending_credit_cents: number
  currency: string
  credit_mode?: string
  rate_limit_per_second?: number
  windows?: BillingWindow[]
}

interface BillingLedgerRow {
  ledger_id: string
  tenant_id: string
  kind: string
  direction: string
  amount_cents: number
  prev_balance_cents: number
  new_balance_cents: number
  recorded_at: string
}

interface BillingLedgerResponse {
  items?: BillingLedgerRow[]
  next_cursor?: string | null
  has_more?: boolean
}

function formatPts(cents?: number | null) {
  return `${((cents ?? 0) / 100).toFixed(2)} PTS`
}

function errorMessage(body: unknown, fallback: string) {
  const maybe = body as { error?: { message?: string; code?: string } } | null
  return maybe?.error?.message ?? maybe?.error?.code ?? fallback
}

export function BillingPage() {
  const [tenantId, setTenantId] = useState("tenant_default")
  const [tenantDraft, setTenantDraft] = useState("tenant_default")
  const [balance, setBalance] = useState<BillingBalance | null>(null)
  const [ledger, setLedger] = useState<BillingLedgerRow[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [recharging, setRecharging] = useState(false)
  const [rechargeId, setRechargeId] = useState("")
  const [amountCents, setAmountCents] = useState("10000")
  const [provider, setProvider] = useState("manual")
  const [externalReference, setExternalReference] = useState("")

  const selectedTenant = tenantId.trim()
  const windows = useMemo(() => balance?.windows ?? [], [balance])

  async function refreshBilling(nextTenant = selectedTenant) {
    if (!nextTenant) return
    setLoading(true)
    const [balanceRes, ledgerRes] = await Promise.all([
      requestJson<{ balance?: BillingBalance }>(`/proxy/v1/admin/billing/tenants/${encodeURIComponent(nextTenant)}/balance`),
      requestJson<BillingLedgerResponse>(
        `/proxy/v1/admin/billing/tenants/${encodeURIComponent(nextTenant)}/ledger?limit=25`
      ),
    ])
    setLoading(false)

    if (balanceRes.status === 200 && balanceRes.body?.balance) {
      setBalance(balanceRes.body.balance)
    } else {
      setBalance(null)
      toast.error(errorMessage(balanceRes.body, "无法加载 tenant balance"))
    }

    if (ledgerRes.status === 200) {
      setLedger(ledgerRes.body?.items ?? [])
    } else {
      setLedger([])
      toast.error(errorMessage(ledgerRes.body, "无法加载 billing ledger"))
    }
  }

  useEffect(() => {
    void refreshBilling()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSelectTenant(event: React.FormEvent) {
    event.preventDefault()
    const next = tenantDraft.trim()
    if (!next) return
    setTenantId(next)
    await refreshBilling(next)
  }

  async function handleCreateTenant() {
    const next = tenantDraft.trim() || selectedTenant
    if (!next) return
    setCreating(true)
    const res = await requestJson<{ balance?: BillingBalance }>("/proxy/v1/admin/billing/tenants", {
      method: "POST",
      body: { tenant_id: next },
    })
    setCreating(false)
    if (res.status >= 400) {
      toast.error(errorMessage(res.body, "tenant 创建失败"))
      return
    }
    toast.success("tenant 已创建或已存在")
    setTenantId(next)
    setTenantDraft(next)
    if (res.body?.balance) setBalance(res.body.balance)
    await refreshBilling(next)
  }

  async function handleRecharge(event: React.FormEvent) {
    event.preventDefault()
    if (!selectedTenant) return
    const amount = Number(amountCents)
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      toast.error("amount_cents 必须是正整数")
      return
    }
    const id = rechargeId.trim() || `rch_${selectedTenant}_${Date.now()}`
    setRecharging(true)
    const res = await requestJson(`/proxy/v1/admin/billing/tenants/${encodeURIComponent(selectedTenant)}/recharges`, {
      method: "POST",
      body: {
        recharge_id: id,
        amount_cents: amount,
        currency: "PTS",
        provider: provider.trim() || "manual",
        external_reference: externalReference.trim() || null,
      },
    })
    setRecharging(false)
    if (res.status >= 400) {
      toast.error(errorMessage(res.body, "recharge 记录失败"))
      return
    }
    toast.success("recharge 已记录")
    setRechargeId("")
    await refreshBilling(selectedTenant)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-bold">Billing 管理</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">P-1 M1.2 admin-only balance / recharge / ledger surface</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refreshBilling()} disabled={loading || !selectedTenant}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <Alert className="border-amber-500/30 bg-amber-50/80 text-amber-950">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>admin-only，不代表终端用户计费已 ready</AlertTitle>
        <AlertDescription>
          这里只允许 operator 创建 tenant、查看余额、记录人工充值和查看 ledger。client-facing billing、扣费 enforcement、提现或法币结算仍然不在 ready 结论内。
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Search className="h-4 w-4 text-purple-500" />
              Tenant
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <form onSubmit={handleSelectTenant} className="space-y-2">
              <Label>tenant_id</Label>
              <Input value={tenantDraft} onChange={(e) => setTenantDraft(e.target.value)} className="font-mono text-sm" />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="sm" disabled={loading || !tenantDraft.trim()}>
                  查询
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={creating || !tenantDraft.trim()} onClick={handleCreateTenant}>
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  {creating ? "创建中…" : "创建 tenant"}
                </Button>
              </div>
            </form>

            <form onSubmit={handleRecharge} className="space-y-2 border-t border-border pt-3">
              <Label>recharge_id</Label>
              <Input value={rechargeId} onChange={(e) => setRechargeId(e.target.value)} placeholder="留空自动生成" className="font-mono text-sm" />
              <Label>amount_cents</Label>
              <Input value={amountCents} onChange={(e) => setAmountCents(e.target.value)} inputMode="numeric" className="font-mono text-sm" />
              <Label>provider</Label>
              <Input value={provider} onChange={(e) => setProvider(e.target.value)} className="font-mono text-sm" />
              <Label>external_reference</Label>
              <Input value={externalReference} onChange={(e) => setExternalReference(e.target.value)} placeholder="可选" className="font-mono text-sm" />
              <Button type="submit" size="sm" disabled={recharging || !selectedTenant}>
                <CreditCard className="mr-1.5 h-3.5 w-3.5" />
                {recharging ? "记录中…" : "记录人工充值"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Balance</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : balance ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">available</p>
                    <p className="mt-1 text-xl font-bold">{formatPts(balance.credit_balance_cents)}</p>
                  </div>
                  <div className="rounded border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">pending</p>
                    <p className="mt-1 text-xl font-bold">{formatPts(balance.pending_credit_cents)}</p>
                  </div>
                  <div className="rounded border bg-muted/20 p-3">
                    <p className="text-xs text-muted-foreground">mode</p>
                    <p className="mt-1 text-xl font-bold">{balance.credit_mode ?? "prepaid"}</p>
                  </div>
                </div>
                <div className="overflow-hidden rounded border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>window</TableHead>
                        <TableHead>caller used</TableHead>
                        <TableHead>responder earned</TableHead>
                        <TableHead>hard block</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {windows.map((window) => (
                        <TableRow key={window.window_kind}>
                          <TableCell className="font-mono text-xs">{window.window_kind}</TableCell>
                          <TableCell>{formatPts(window.used_as_caller_cents)}</TableCell>
                          <TableCell>{formatPts(window.earned_as_responder_cents)}</TableCell>
                          <TableCell>
                            <Badge variant="solid" tone={window.hard_block_on_exceed ? "destructive" : "neutral"} className="text-[10px]">
                              {window.hard_block_on_exceed ? "on" : "off"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">选择或创建 tenant 后显示余额。</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Ledger</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-2 p-4">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : ledger.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">暂无 ledger 记录。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>recorded_at</TableHead>
                  <TableHead>kind</TableHead>
                  <TableHead>direction</TableHead>
                  <TableHead>amount</TableHead>
                  <TableHead>balance</TableHead>
                  <TableHead>ledger_id</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.map((row) => (
                  <TableRow key={row.ledger_id}>
                    <TableCell className="text-xs">{new Date(row.recorded_at).toLocaleString()}</TableCell>
                    <TableCell>{row.kind}</TableCell>
                    <TableCell>{row.direction}</TableCell>
                    <TableCell>{formatPts(row.amount_cents)}</TableCell>
                    <TableCell>{formatPts(row.prev_balance_cents)} → {formatPts(row.new_balance_cents)}</TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-xs">{row.ledger_id}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
