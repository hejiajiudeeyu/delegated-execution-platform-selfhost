import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom"
import { useEffect } from "react"
import { AuthProvider, useAuth } from "@/hooks/useAuth"
import { getSessionToken } from "@/lib/api"
import { AppShell } from "@/components/layout/AppShell"
import { SetupPage, UnlockPage } from "@/pages/auth/AuthPages"
import { OverviewPage } from "@/pages/OverviewPage"
import { RespondersPage, HotlinesAdminPage } from "@/pages/AdminListPage"
import { RequestsPage, AuditPage, ReviewsPage } from "@/pages/MonitorPages"

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { status, loading } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (loading || !status) return
    if (status.auth.setup_required) navigate("/auth/setup", { replace: true })
    else if (status.auth.locked || !getSessionToken()) navigate("/auth/unlock", { replace: true })
  }, [status, loading, navigate])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        加载中…
      </div>
    )
  }
  if (!status || status.auth.setup_required || status.auth.locked || !getSessionToken()) return null
  return <>{children}</>
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/auth/setup" element={<SetupPage />} />
      <Route path="/auth/unlock" element={<UnlockPage />} />
      <Route
        path="/"
        element={
          <AuthGuard>
            <AppShell />
          </AuthGuard>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="responders" element={<RespondersPage />} />
        <Route path="hotlines" element={<HotlinesAdminPage />} />
        <Route path="requests" element={<RequestsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="reviews" element={<ReviewsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
