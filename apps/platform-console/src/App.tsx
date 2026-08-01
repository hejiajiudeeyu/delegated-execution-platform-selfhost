import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { ConsoleProvider } from "@/state/console";
import { AttentionPage } from "@/pages/AttentionPage";
import { CallDetailPage } from "@/pages/CallDetailPage";
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
            {/* Home is now the attention feed rather than a health panel. The
                old /overview path redirects so existing links and bookmarks
                land somewhere useful instead of 404ing. */}
            <Route path="/" element={<Navigate to="/attention" replace />} />
            <Route path="/attention" element={<AttentionPage />} />
            <Route path="/overview" element={<Navigate to="/attention" replace />} />
            <Route path="/calls/:requestId" element={<CallDetailPage />} />
            <Route path="/session" element={<SessionPage />} />
            <Route path="/credentials" element={<CredentialsPage />} />
            <Route path="/reviews" element={<ReviewQueuePage />} />
            <Route path="/requests" element={<RequestsPage />} />
            <Route path="/responders" element={<RespondersPage />} />
            <Route path="/hotlines" element={<HotlinesPage />} />
            <Route path="/marketplace" element={<MarketplacePage />} />
            <Route path="/billing" element={<BillingPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="*" element={<Navigate to="/attention" replace />} />
          </Route>
        </Routes>
      </HashRouter>
      <Toaster position="top-right" richColors />
    </ConsoleProvider>
  );
}
