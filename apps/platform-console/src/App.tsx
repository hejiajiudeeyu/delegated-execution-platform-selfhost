import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { ConsoleProvider } from "@/state/console";
import { OverviewPage } from "@/pages/OverviewPage";
import { SessionPage } from "@/pages/SessionPage";
import { CredentialsPage } from "@/pages/CredentialsPage";
import { ReviewQueuePage } from "@/pages/ReviewQueuePage";
import { BillingPage } from "@/pages/BillingPage";
import { AuditPage, HotlinesPage, MarketplacePage, RequestsPage, RespondersPage } from "@/pages/ListPages";

export default function App() {
  return (
    <ConsoleProvider>
      <HashRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/session" element={<SessionPage />} />
            <Route path="/credentials" element={<CredentialsPage />} />
            <Route path="/reviews" element={<ReviewQueuePage />} />
            <Route path="/requests" element={<RequestsPage />} />
            <Route path="/responders" element={<RespondersPage />} />
            <Route path="/hotlines" element={<HotlinesPage />} />
            <Route path="/marketplace" element={<MarketplacePage />} />
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Route>
        </Routes>
      </HashRouter>
      <Toaster position="top-right" richColors />
    </ConsoleProvider>
  );
}
