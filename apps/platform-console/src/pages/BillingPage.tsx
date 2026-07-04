import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ActionResult, BusyButton, CopyChip, DataState, TechDetails, useAction } from "@/components/shared";
import { admin, type ApiResult } from "@/lib/api";
import { toast } from "sonner";

interface LedgerRow {
  ledger_id?: string;
  kind?: string;
  amount_cents?: number;
  new_balance_cents?: number;
  request_id?: string | null;
  recorded_at?: string;
  [k: string]: unknown;
}

const KIND_LABEL: Record<string, { label: string; cls: string }> = {
  recharge: { label: "充值", cls: "bg-emerald-50 text-emerald-700" },
  hold: { label: "冻结", cls: "bg-amber-50 text-amber-800" },
  settle: { label: "结算", cls: "bg-violet-50 text-violet-700" },
  debit: { label: "结算", cls: "bg-violet-50 text-violet-700" },
  refund: { label: "退回", cls: "bg-sky-50 text-sky-700" }
};

function fmt(cents: number | undefined | null): string {
  if (cents == null) return "—";
  return cents.toLocaleString("zh-CN");
}

export function BillingPage() {
  const navigate = useNavigate();
  const [tenantInput, setTenantInput] = useState("");
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [balanceResult, setBalanceResult] = useState<ApiResult<Record<string, unknown>> | null>(null);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [ledgerRaw, setLedgerRaw] = useState<string>("");
  const [notFound, setNotFound] = useState(false);
  const [amount, setAmount] = useState("");
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) return;
    setTenantId(trimmed);
    setLoading(true);
    setNotFound(false);
    setConfirming(false);
    const [balance, ledger] = await Promise.all([admin.billingBalance(trimmed), admin.billingLedger(trimmed, 25)]);
    setBalanceResult(balance);
    const rows = ((ledger.body as { rows?: LedgerRow[] } | null)?.rows || []) as LedgerRow[];
    setLedgerRows(ledger.ok ? rows : []);
    setLedgerRaw(ledger.raw);
    if (!balance.ok && balance.status === 404) setNotFound(true);
    setLoading(false);
  }, []);

  const createTenant = useAction(async () => {
    const r = await admin.billingCreateTenant(tenantId || tenantInput.trim());
    if (r.ok) {
      toast.success("租户已创建");
      await load(tenantId || tenantInput.trim());
    }
    return r;
  });

  const recharge = useAction(async () => {
    const cents = Number(amount);
    const id = tenantId || tenantInput.trim();
    const r = await admin.billingRecharge(id, cents, `rch_${id}_${Date.now()}`, "manual", null);
    if (r.ok) {
      toast.success(`已充值 ${fmt(cents)} PTS`);
      setAmount("");
      setConfirming(false);
      await load(id);
    }
    return r;
  });

  const balanceBody = (balanceResult?.body || {}) as Record<string, unknown>;
  const balanceCents = (balanceBody.balance_cents ?? (balanceBody.balance as Record<string, unknown> | undefined)?.balance_cents) as number | undefined;
  const amountValid = /^\d+$/.test(amount) && Number(amount) > 0;
  const authFailure = balanceResult && !balanceResult.ok && balanceResult.failure === "auth" ? balanceResult : null;

  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">资金 / 计费</div>
      <h1 className="mb-1 text-2xl font-bold">计费</h1>
      <p className="mb-5 text-muted-foreground">查询租户余额与账本,录入人工充值。Caller 的租户 ID = 注册时打印的 user_id。</p>

      <Card className="mb-5">
        <CardContent className="pt-6">
          <Label htmlFor="tenant-id">租户 ID(输入后回车或失焦自动查询)</Label>
          <Input
            id="tenant-id"
            value={tenantInput}
            onChange={(e) => setTenantInput(e.target.value)}
            onBlur={() => tenantInput.trim() && tenantInput.trim() !== tenantId && void load(tenantInput)}
            onKeyDown={(e) => { if (e.key === "Enter") void load(tenantInput); }}
            placeholder="user_…"
            className="mt-1.5 max-w-xl font-mono"
          />
          {notFound && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              未找到该租户——如果这是新 Caller 的首次充值,先创建租户。
              <BusyButton size="sm" busy={createTenant.busy} onClick={() => void createTenant.run()}>创建租户</BusyButton>
            </div>
          )}
          <ActionResult result={createTenant.result?.ok ? null : createTenant.result} />
        </CardContent>
      </Card>

      <DataState
        loading={loading}
        result={authFailure || (balanceResult && !balanceResult.ok && !notFound ? balanceResult : null)}
        emptyText={tenantId ? "该租户暂无数据。" : "输入租户 ID 后自动查询;创建、充值与账本都在本页完成。"}
        onConfigureCredentials={() => navigate("/credentials")}
      >
        {tenantId && balanceResult?.ok ? (
          <div className="grid gap-5 lg:grid-cols-[1.3fr_.7fr]">
            <Card className="order-2 lg:order-1">
              <CardHeader><CardTitle className="text-base">账本(最近 {ledgerRows.length} 条)</CardTitle></CardHeader>
              <CardContent>
                {ledgerRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">查询成功,但该租户还没有账本记录。</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <th className="py-2 pr-3">类型</th><th className="py-2 pr-3">说明</th>
                          <th className="py-2 pr-3">金额</th><th className="py-2 pr-3">余额</th><th className="py-2">时间</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ledgerRows.map((row, i) => {
                          const kind = KIND_LABEL[String(row.kind)] || { label: String(row.kind || "—"), cls: "bg-muted text-muted-foreground" };
                          return (
                            <tr key={row.ledger_id || i} className="border-b border-border/60 align-top">
                              <td className="py-2.5 pr-3"><Badge className={kind.cls} variant="outline">{kind.label}</Badge></td>
                              <td className="py-2.5 pr-3">
                                {row.request_id ? <CopyChip value={String(row.request_id)} label={`${String(row.request_id).slice(0, 18)}…`} /> :
                                  <span className="text-muted-foreground">{String(row.kind) === "recharge" ? "人工充值" : "—"}</span>}
                              </td>
                              <td className={`py-2.5 pr-3 font-medium ${Number(row.amount_cents) > 0 ? "text-emerald-600" : Number(row.amount_cents) < 0 ? "text-amber-700" : ""}`}>
                                {Number(row.amount_cents) > 0 ? "+" : ""}{fmt(row.amount_cents)}
                              </td>
                              <td className="py-2.5 pr-3">{fmt(row.new_balance_cents)}</td>
                              <td className="py-2.5 text-muted-foreground">{row.recorded_at ? new Date(String(row.recorded_at)).toLocaleTimeString() : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <TechDetails raw={ledgerRaw} />
              </CardContent>
            </Card>

            <div className="order-1 space-y-5 lg:order-2">
              <div className="rounded-xl bg-gradient-to-br from-violet-500 to-violet-400 p-5 text-white shadow-sm">
                <div className="text-xs opacity-85">当前余额</div>
                <div className="text-3xl font-bold">{fmt(balanceCents)} <span className="text-base font-medium">PTS</span></div>
                <div className="mt-1 text-xs opacity-90">租户 <span className="font-mono">{tenantId.slice(0, 22)}…</span></div>
              </div>
              <Card>
                <CardHeader><CardTitle className="text-base">人工充值</CardTitle></CardHeader>
                <CardContent>
                  <Label htmlFor="amount">金额(PTS)<span className="text-red-500"> *必填</span></Label>
                  <Input id="amount" inputMode="numeric" value={amount} onChange={(e) => { setAmount(e.target.value); setConfirming(false); }} placeholder="例如 20000" className="mt-1.5" />
                  <p className="mt-1.5 text-xs text-muted-foreground">provider=manual,凭证号自动生成。</p>
                  {!confirming ? (
                    <Button className="mt-3" disabled={!amountValid} onClick={() => setConfirming(true)}>充值…</Button>
                  ) : (
                    <div className="mt-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 text-sm">
                      确认:为 <span className="font-mono text-xs">{tenantId.slice(0, 18)}…</span> 充值 <b>{fmt(Number(amount))} PTS</b>
                      {balanceCents != null && <>(充值后余额 {fmt(balanceCents + Number(amount))})</>}
                      <div className="mt-2 flex gap-2">
                        <BusyButton size="sm" busy={recharge.busy} onClick={() => void recharge.run()}>确认充值</BusyButton>
                        <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>取消</Button>
                      </div>
                    </div>
                  )}
                  <ActionResult result={recharge.result?.ok ? null : recharge.result} />
                </CardContent>
              </Card>
            </div>
          </div>
        ) : null}
      </DataState>
    </div>
  );
}
