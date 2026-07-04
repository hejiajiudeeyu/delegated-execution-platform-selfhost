import { useState } from "react";
import { AlertCircle, CheckCircle2, ClipboardCopy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import type { ApiResult } from "@/lib/api";
import { toast } from "sonner";

/** R1: inline, adjacent action feedback. Success green, failure red with a
 * human message; raw JSON demoted to a collapsed block. */
export function ActionResult({ result, okText }: { result: ApiResult | null; okText?: string }) {
  if (!result) return null;
  if (result.ok) {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          {okText || "操作成功。"}
          <TechDetails raw={result.raw} />
        </div>
      </div>
    );
  }
  const human =
    result.failure === "gateway_down"
      ? "网关没有应答——请确认 platform-console-gateway 正在运行,然后重试。"
      : result.failure === "auth"
        ? "凭据无效或会话已过期。"
        : result.message || "请求被拒绝,请检查输入。";
  return (
    <div className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        {human}
        <TechDetails raw={result.raw} />
      </div>
    </div>
  );
}

/** Collapsed raw JSON — for debugging only, never the primary UI. */
export function TechDetails({ raw }: { raw: string | null | undefined }) {
  if (!raw) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">技术详情(raw JSON)</summary>
      <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-zinc-900 p-3 text-xs leading-relaxed text-zinc-100">{raw}</pre>
    </details>
  );
}

/** R2/R5: four distinguishable data states. Non-2xx NEVER renders as empty. */
export function DataState({
  loading,
  result,
  emptyText,
  onConfigureCredentials,
  children
}: {
  loading: boolean;
  result: ApiResult | null;
  emptyText: string;
  onConfigureCredentials?: () => void;
  children?: React.ReactNode;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-5 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 正在加载…
      </div>
    );
  }
  if (result && !result.ok) {
    if (result.failure === "auth") {
      return (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">
          <b>管理凭据无效或未配置</b> —— 此数据需要经过验证的 Operator API Key。
          {onConfigureCredentials && (
            <Button variant="outline" size="sm" className="ml-3" onClick={onConfigureCredentials}>
              去配置凭据 →
            </Button>
          )}
          <TechDetails raw={result.raw} />
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
        <b>{result.failure === "gateway_down" ? "网关或平台不可达" : "查询失败"}</b>
        {result.message ? ` —— ${result.message}` : null}
        <TechDetails raw={result.raw} />
      </div>
    );
  }
  if (!children) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/20 px-5 py-8 text-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    );
  }
  return <>{children}</>;
}

export function CopyChip({ value, label }: { value: string; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        toast.success("已复制");
      }}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 font-mono text-xs text-muted-foreground hover:bg-accent"
      title={value}
    >
      <span className="truncate">{label || value}</span>
      <ClipboardCopy className="h-3 w-3 shrink-0" />
    </button>
  );
}

/** Review lifecycle progress: 已提交 → 待审核 → 已批准 → 已启用 */
export function Lifecycle({ stage }: { stage: "pending" | "approved" | "enabled" | "rejected" }) {
  const steps = ["已提交", "待审核", "已批准", "已启用(上市场)"];
  const activeIndex = stage === "pending" ? 1 : stage === "approved" ? 2 : stage === "enabled" ? 3 : 1;
  return (
    <div className="mt-3 flex items-center gap-2 text-xs">
      {steps.map((label, i) => (
        <span key={label} className="flex items-center gap-2">
          {i > 0 && <span className="h-px w-6 bg-border" />}
          <span
            className={cn(
              "flex items-center gap-1.5",
              i < activeIndex && "font-medium text-emerald-600",
              i === activeIndex && "font-semibold text-primary",
              i > activeIndex && "text-muted-foreground"
            )}
          >
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                i < activeIndex ? "bg-emerald-500" : i === activeIndex ? "bg-primary ring-4 ring-primary/15" : "bg-border"
              )}
            />
            {label}
          </span>
        </span>
      ))}
      {stage === "rejected" && <span className="ml-2 font-medium text-red-600">已驳回</span>}
    </div>
  );
}

/** Busy-aware action button with per-action spinner. */
export function BusyButton({
  busy,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { busy?: boolean }) {
  return (
    <Button disabled={busy || props.disabled} {...props}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {children}
    </Button>
  );
}

export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<ApiResult>) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);
  const run = async (...args: A) => {
    setBusy(true);
    try {
      const r = await fn(...args);
      setResult(r);
      return r;
    } finally {
      setBusy(false);
    }
  };
  return { busy, result, run, reset: () => setResult(null) };
}
