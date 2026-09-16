import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { StoreProvider } from './store.jsx'
import { I18nProvider } from './i18n/I18n.jsx'
import AppShell from './layouts/AppShell.jsx'
import Gate from './layouts/Gate.jsx'
import Login from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Incoming from './pages/Incoming.jsx'
import Transactions from './pages/Transactions.jsx'
import Restrictions from './pages/Restrictions.jsx'
import CardPage from './pages/CardPage.jsx'
import Disputes from './pages/Disputes.jsx'
import Settings from './pages/Settings.jsx'
import { useI18n } from './i18n/I18n.jsx'

// The admin console is only downloaded when an operator opens it.
const AdminShell = lazy(() => import('./layouts/AdminShell.jsx'))
const Overview = lazy(() => import('./pages/admin/Overview.jsx'))
const Connections = lazy(() => import('./pages/admin/Connections.jsx'))
const NewConnection = lazy(() => import('./pages/admin/NewConnection.jsx'))
const ConnectionDetail = lazy(() => import('./pages/admin/ConnectionDetail.jsx'))
const Credits = lazy(() => import('./pages/admin/Credits.jsx'))
const Cardholders = lazy(() => import('./pages/admin/Cardholders.jsx'))
const AdminSettings = lazy(() => import('./pages/admin/Settings.jsx'))
const NewCardholder = lazy(() => import('./pages/admin/NewCardholder.jsx'))
const CardholderDetail = lazy(() => import('./pages/admin/CardholderDetail.jsx'))
const Declines = lazy(() => import('./pages/admin/Declines.jsx'))
const Rules = lazy(() => import('./pages/admin/Rules.jsx'))
const Asa = lazy(() => import('./pages/admin/Asa.jsx'))
const Integrations = lazy(() => import('./pages/admin/Integrations.jsx'))
const Ledger = lazy(() => import('./pages/admin/Ledger.jsx'))
const Cases = lazy(() => import('./pages/admin/Cases.jsx'))
const Sandbox = lazy(() => import('./pages/admin/Sandbox.jsx'))
const Audit = lazy(() => import('./pages/admin/Audit.jsx'))
const Approvals = lazy(() => import('./pages/admin/Approvals.jsx'))

function Loading() {
  const { tx } = useI18n()
  return <p className="empty" style={{ padding: 24 }}>{tx("Loading…")}</p>
}

export default function App() {
  return (
    <I18nProvider>
      <StoreProvider>
        <BrowserRouter>
          <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="login" element={<Login />} />
            <Route element={<Gate />}>
              <Route element={<AppShell />}>
                <Route index element={<Dashboard />} />
                <Route path="incoming" element={<Incoming />} />
                <Route path="transactions" element={<Transactions />} />
                <Route path="restrictions" element={<Restrictions />} />
                <Route path="card" element={<CardPage />} />
                <Route path="disputes" element={<Disputes />} />
                <Route path="settings" element={<Settings />} />
              </Route>
            </Route>
            <Route element={<Gate role="admin" />}>
              <Route path="admin" element={<AdminShell />}>
                <Route index element={<Overview />} />
                <Route path="connections" element={<Connections />} />
                <Route path="connections/new" element={<NewConnection />} />
                <Route path="connections/:id" element={<ConnectionDetail />} />
                <Route path="credits" element={<Credits />} />
                <Route path="cardholders" element={<Cardholders />} />
                <Route path="cardholders/new" element={<NewCardholder />} />
                <Route path="cardholders/:id" element={<CardholderDetail />} />
                <Route path="declines" element={<Declines />} />
                <Route path="rules" element={<Rules />} />
                <Route path="asa" element={<Asa />} />
                <Route path="integrations" element={<Integrations />} />
                <Route path="ledger" element={<Ledger />} />
                <Route path="cases" element={<Cases />} />
                <Route path="approvals" element={<Approvals />} />
                <Route path="sandbox" element={<Sandbox />} />
                <Route path="audit" element={<Audit />} />
                <Route path="settings" element={<AdminSettings />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
      </StoreProvider>
    </I18nProvider>
  )
}
