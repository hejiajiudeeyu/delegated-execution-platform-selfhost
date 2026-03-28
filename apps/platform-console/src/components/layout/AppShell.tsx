import { NavLink, useNavigate, Outlet } from "react-router-dom"
import { Activity, Users, BookOpen, List, ClipboardList, Star, LogOut, RefreshCw, Shield } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/components/ui/utils"
import { useAuth } from "@/hooks/useAuth"

function BrandBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-40">
        {["#FACC15", "#8B5CF6", "#3B82F6", "#EC4899", "#A3E635", "#F97316", "#6366F1", "#EF4444", "#14B8A6"].map(
          (color, i) => <div key={i} style={{ backgroundColor: color }} />
        )}
      </div>
      <div className="absolute inset-0 opacity-20">
        <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="brand-grid" x="0" y="0" width="200" height="200" patternUnits="userSpaceOnUse">
              <rect width="200" height="200" fill="none" />
              <rect x="0" y="0" width="200" height="200" fill="none" stroke="#111111" strokeWidth="5" strokeLinecap="square" />
              <g stroke="#111111" strokeWidth="5" fill="none" strokeLinecap="square">
                <line x1="0" y1="0" x2="60" y2="60" />
                <line x1="200" y1="0" x2="140" y2="60" />
                <line x1="0" y1="200" x2="60" y2="140" />
                <line x1="200" y1="200" x2="140" y2="140" />
                <rect x="60" y="60" width="80" height="80" />
                <circle cx="100" cy="100" r="40" />
                <line x1="60" y1="60" x2="140" y2="140" />
                <line x1="140" y1="60" x2="60" y2="140" />
              </g>
              <g fill="#111111" fontFamily="'Inter', 'Helvetica Neue', Arial, sans-serif" fontWeight="900" letterSpacing="0.05em">
                <text x="12" y="38" fontSize="22" textAnchor="start">CALL</text>
                <text x="188" y="180" fontSize="22" textAnchor="end">ANYTHING</text>
              </g>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#brand-grid)" />
        </svg>
      </div>
      <div className="absolute left-[10%] top-24 h-52 w-64 bg-black/10" />
      <div className="absolute bottom-32 right-[15%] h-60 w-72 bg-black/10 -rotate-6" />
      <div className="absolute top-[42%] right-[8%] h-56 w-56 rounded-full bg-black/10" />
      <div className="absolute bottom-[48%] left-[12%] h-48 w-48 rounded-full bg-black/10" />
      <div className="absolute left-20 top-20 h-64 w-64 rotate-12 bg-[#A3E635]/30" />
      <div className="absolute bottom-20 right-20 h-80 w-80 -rotate-12 bg-[#8B5CF6]/25" />
    </div>
  )
}

const NAV = [
  { label: "Overview", path: "/", icon: Activity, end: true },
  { label: "Responder 管理", path: "/responders", icon: Users },
  { label: "Hotline 管理", path: "/hotlines", icon: BookOpen },
  { label: "Request 监控", path: "/requests", icon: List },
  { label: "Audit 日志", path: "/audit", icon: ClipboardList },
  { label: "Review 队列", path: "/reviews", icon: Star },
]

function Sidebar() {
  const { logout, refresh } = useAuth()
  const navigate = useNavigate()

  return (
    <aside className="flex w-52 flex-col border-r border-border bg-sidebar/90 backdrop-blur-sm h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Shield className="h-4 w-4 text-purple-500" />
        <span className="text-sm font-bold">Platform Console</span>
      </div>
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {NAV.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors mb-0.5",
                  isActive
                    ? "bg-purple-500/10 text-purple-700"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0 text-purple-500" />
              {item.label}
            </NavLink>
          )
        })}
      </nav>
      <div className="border-t border-border px-2 py-2 flex gap-1">
        <Button variant="ghost" size="icon" onClick={refresh} title="刷新">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" onClick={async () => { await logout(); navigate("/auth/unlock") }} title="退出">
          <LogOut className="h-3.5 w-3.5" />
        </Button>
      </div>
    </aside>
  )
}

export function AppShell() {
  return (
    <div className="isolate relative flex h-screen flex-col overflow-hidden">
      <BrandBackdrop />
      <div className="relative z-10 flex h-full overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
