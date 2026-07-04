import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { derivePhase, gateway, getSessionToken, setSessionToken, type SessionEnvelope, type SessionInfo, type SessionPhase } from "@/lib/api";

interface ConsoleState {
  phase: SessionPhase;
  session: SessionInfo | null;
  checking: boolean;
  credentialVerified: boolean | null; // null = unknown/not probed yet
  refresh: () => Promise<void>;
  markUnlocked: (token: string | null | undefined) => Promise<void>;
  logout: () => Promise<void>;
  setCredentialVerified: (v: boolean | null) => void;
}

const Ctx = createContext<ConsoleState | null>(null);

/** Probe whether the stored admin key actually works (design rule R3: the
 * badge means "verified", not "something was saved"). Uses a cheap admin
 * list read through the frozen proxy surface. */
export async function probeAdminCredential(): Promise<boolean | null> {
  const result = await gateway.proxy("/v2/admin/responders?limit=1");
  if (result.ok) return true;
  if (result.failure === "auth") return false;
  return null; // gateway/platform down — unknown, don't claim either way
}

export function ConsoleProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<SessionPhase>("unreachable");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [credentialVerified, setCredentialVerified] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    const result = await gateway.session();
    const nextPhase = derivePhase(result);
    setPhase(nextPhase);
    setSession(((result.body as SessionEnvelope | null)?.session as SessionInfo) || null);
    if (nextPhase === "unlocked" && getSessionToken()) {
      setCredentialVerified(await probeAdminCredential());
    } else {
      setCredentialVerified(null);
    }
    setChecking(false);
  }, []);

  const markUnlocked = useCallback(
    async (token: string | null | undefined) => {
      if (token) setSessionToken(token);
      await refresh();
    },
    [refresh]
  );

  const logout = useCallback(async () => {
    await gateway.logout();
    setSessionToken(null);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ phase, session, checking, credentialVerified, refresh, markUnlocked, logout, setCredentialVerified }),
    [phase, session, checking, credentialVerified, refresh, markUnlocked, logout]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConsole(): ConsoleState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useConsole outside provider");
  return ctx;
}

export const PHASE_LABEL: Record<SessionPhase, string> = {
  unreachable: "网关不可达",
  setup: "未初始化",
  locked: "已锁定",
  unlocked: "已解锁"
};
