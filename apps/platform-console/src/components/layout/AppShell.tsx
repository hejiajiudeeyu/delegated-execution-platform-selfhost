import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Lock, Menu, RefreshCw, ShieldCheck, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { PHASE_LABEL, useConsole } from "@/state/console";

// Grouped by what the operator is trying to do, not by which API endpoint
// serves it. The previous nav listed platform-api's resources, which is why
// none of the three things an operator actually does mapped to a single page.
const NAV: { group: string; items: { to: string; label: string; needsUnlock?: boolean }[] }[] = [
  { group: "开始", items: [{ to: "/attention", label: "需要我做的事" }] },
  {
    group: "运营",
    items: [
      { to: "/reviews", label: "审批队列", needsUnlock: true },
      { to: "/requests", label: "调用记录", needsUnlock: true }
    ]
  },
  {
    group: "目录",
    items: [
      { to: "/responders", label: "Responders", needsUnlock: true },
      { to: "/hotlines", label: "Hotlines", needsUnlock: true },
      { to: "/marketplace", label: "Marketplace" }
    ]
  },
  {
    group: "资金",
    items: [
      { to: "/billing", label: "计费", needsUnlock: true },
      { to: "/audit", label: "审计", needsUnlock: true }
    ]
  },
  {
    group: "设置",
    items: [
      { to: "/alerts", label: "告警", needsUnlock: true },
      { to: "/session", label: "会话与解锁" },
      { to: "/credentials", label: "网关凭据", needsUnlock: true }
    ]
  }
];

function PhaseBadge() {
  const { phase, credentialVerified } = useConsole();
  const tone =
    phase === "unlocked"
      ? credentialVerified
        ? "bg-emerald-50 text-emerald-700"
        : "bg-amber-50 text-amber-700"
      : phase === "unreachable"
        ? "bg-red-50 text-red-700"
        : "bg-amber-50 text-amber-700";
  const label =
    phase === "unlocked"
      ? credentialVerified === true
        ? "已解锁 · 凭据已验证"
        : credentialVerified === false
          ? "已解锁 · 凭据无效"
          : "已解锁 · 凭据未验证"
      : PHASE_LABEL[phase];
  const Icon = phase === "unlocked" && credentialVerified ? ShieldCheck : phase === "unlocked" ? ShieldAlert : Lock;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold", tone)}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const { phase } = useConsole();
  return (
    <nav className="mt-4 space-y-4 text-sm">
      {NAV.map((group) => (
        <div key={group.group}>
          <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-widest text-muted-foreground">{group.group}</div>
          {group.items.map((item) => {
            const disabled = item.needsUnlock && phase !== "unlocked";
            return (
              <NavLink
                key={item.to}
                to={disabled ? "/session" : item.to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    "block rounded-lg px-3 py-1.5",
                    isActive && !disabled ? "bg-primary font-semibold text-primary-foreground" : "hover:bg-accent",
                    disabled && "text-muted-foreground/50"
                  )
                }
                title={disabled ? "解锁后可用" : undefined}
              >
                {item.label}
              </NavLink>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function AppShell() {
  const { phase, credentialVerified, refresh, checking } = useConsole();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-[#f7f7fb] text-foreground">
      {/* desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-white px-3 py-5 lg:flex">
        <div className="px-3">
          <div className="text-lg font-bold">Platform Console</div>
          <div className="text-xs text-muted-foreground">运营者控制台</div>
          <div className="mt-3"><PhaseBadge /></div>
        </div>
        <SidebarNav />
      </aside>

      {/* mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-white px-3 py-5 shadow-xl">
            <div className="flex items-center justify-between px-3">
              <div className="text-lg font-bold">Platform Console</div>
              <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)}><X className="h-4 w-4" /></Button>
            </div>
            <div className="mt-2 px-3"><PhaseBadge /></div>
            <SidebarNav onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        {/* top bar (mobile menu + credential banner) */}
        <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-white/85 px-4 py-2.5 backdrop-blur lg:px-8">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)}>
            <Menu className="h-5 w-5" />
          </Button>
          <div className="lg:hidden"><PhaseBadge /></div>
          <div className="ml-auto">
            <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={checking}>
              <RefreshCw className={cn("h-4 w-4", checking && "animate-spin")} />
              刷新状态
            </Button>
          </div>
        </div>

        {phase === "unlocked" && credentialVerified === false && (
          <div className="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 lg:mx-8">
            <ShieldAlert className="h-4 w-4" />
            管理凭据无效——审批、计费、审计工具暂不可用。
            <Button size="sm" variant="outline" onClick={() => navigate("/credentials")}>去配置凭据 →</Button>
          </div>
        )}

        <main className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
