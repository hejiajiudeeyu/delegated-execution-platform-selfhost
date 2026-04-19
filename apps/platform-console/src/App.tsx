import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom"
import { Toaster } from "sonner"
import { AuthProvider, useAuth } from "@/hooks/useAuth"
import { getSessionToken } from "@/lib/api"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { AppShell } from "@/components/layout/AppShell"
import { SetupPage, UnlockPage } from "@/pages/auth/AuthPages"
import { OverviewPage } from "@/pages/OverviewPage"
import { RespondersPage, HotlinesAdminPage } from "@/pages/AdminListPage"
import { RequestsPage, AuditPage, ReviewsPage } from "@/pages/MonitorPages"
import { RelayPage } from "@/pages/RelayPage"

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { status, loading } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        加载中…
      </div>
    )
  }

  if (!status) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        读取会话状态中…
      </div>
    )
  }

  const next = `${location.pathname}${location.search}${location.hash}`

  if (status.auth.setup_required) {
    return <Navigate to="/auth/setup" replace state={{ next }} />
  }

  if (status.auth.locked || !getSessionToken()) {
    return <Navigate to="/auth/unlock" replace state={{ next }} />
  }

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
        <Route path="relay" element={<RelayPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ErrorBoundary>
          <AppRoutes />
        </ErrorBoundary>
        <Toaster position="bottom-right" richColors />
      </AuthProvider>
    </BrowserRouter>
  )
}
