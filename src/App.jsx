import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { StoreProvider } from './store.jsx'
import { I18nProvider } from './i18n/I18n.jsx'
import AppShell from './layouts/AppShell.jsx'
import AdminShell from './layouts/AdminShell.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Incoming from './pages/Incoming.jsx'
import Transactions from './pages/Transactions.jsx'
import Restrictions from './pages/Restrictions.jsx'
import CardPage from './pages/CardPage.jsx'
import Overview from './pages/admin/Overview.jsx'
import Connections from './pages/admin/Connections.jsx'
import NewConnection from './pages/admin/NewConnection.jsx'
import ConnectionDetail from './pages/admin/ConnectionDetail.jsx'
import Credits from './pages/admin/Credits.jsx'
import Cardholders from './pages/admin/Cardholders.jsx'
import NewCardholder from './pages/admin/NewCardholder.jsx'
import Declines from './pages/admin/Declines.jsx'
import Playground from './pages/admin/Playground.jsx'
import Settings from './pages/Settings.jsx'

export default function App() {
  return (
    <I18nProvider>
    <StoreProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Dashboard />} />
            <Route path="incoming" element={<Incoming />} />
            <Route path="transactions" element={<Transactions />} />
            <Route path="restrictions" element={<Restrictions />} />
            <Route path="card" element={<CardPage />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="admin" element={<AdminShell />}>
            <Route index element={<Overview />} />
            <Route path="connections" element={<Connections />} />
            <Route path="connections/new" element={<NewConnection />} />
            <Route path="connections/:id" element={<ConnectionDetail />} />
            <Route path="credits" element={<Credits />} />
            <Route path="cardholders" element={<Cardholders />} />
            <Route path="cardholders/new" element={<NewCardholder />} />
            <Route path="declines" element={<Declines />} />
            <Route path="playground" element={<Playground />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </StoreProvider>
    </I18nProvider>
  )
}
