import React, { createContext, useCallback, useContext, useEffect, useState } from "react"
import { clearSessionToken, requestJson, setSessionToken } from "@/lib/api"

export interface AuthState {
  configured: boolean
  locked: boolean
  authenticated: boolean
  setup_required: boolean
  expires_at: string | null
  admin_api_key_configured?: boolean
  platform_url?: string | null
}

export interface SessionStatus {
  ok: boolean
  auth: AuthState
  credentials?: { platform_admin_api_key_configured: boolean }
}

interface GatewaySessionResponse {
  ok: boolean
  session: AuthState
}

interface AuthContextValue {
  status: SessionStatus | null
  loading: boolean
  refresh: () => Promise<void>
  login: (passphrase: string) => Promise<{ ok: boolean; error?: string }>
  logout: () => Promise<void>
  setup: (passphrase: string, bootstrapSecret?: string) => Promise<{ ok: boolean; error?: string }>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const res = await requestJson<GatewaySessionResponse>("/session")
      if (res.body?.session) {
        setStatus({ ok: res.body.ok, auth: res.body.session })
      }
    } catch { /* ignore */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const login = useCallback(async (passphrase: string) => {
    const res = await requestJson<{ token?: string; error?: { message: string } }>(
      "/session/login", { method: "POST", body: { passphrase } }
    )
    if (res.status === 200 && res.body?.token) {
      setSessionToken(res.body.token)
      await refresh()
      return { ok: true }
    }
    return { ok: false, error: res.body?.error?.message ?? "认证失败" }
  }, [refresh])

  const logout = useCallback(async () => {
    await requestJson("/session/logout", { method: "POST" })
    clearSessionToken()
    await refresh()
  }, [refresh])

  const setup = useCallback(async (passphrase: string, bootstrapSecret?: string) => {
    const res = await requestJson<{ token?: string; error?: { code?: string; message: string } }>(
      "/session/setup",
      { method: "POST", body: { passphrase, bootstrap_secret: bootstrapSecret } }
    )
    if ((res.status === 200 || res.status === 201) && res.body?.token) {
      setSessionToken(res.body.token)
      await refresh()
      return { ok: true }
    }
    await refresh()
    if (res.body?.error?.code === "AUTH_SECRET_STORE_EXISTS") {
      return { ok: false, error: "加密密钥库已存在，请使用口令解锁" }
    }
    return { ok: false, error: res.body?.error?.message ?? "Setup 失败" }
  }, [refresh])

  return (
    <AuthContext.Provider value={{ status, loading, refresh, login, logout, setup }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
