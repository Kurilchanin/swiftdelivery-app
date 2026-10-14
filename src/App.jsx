import { usePath } from './router'
import BottomNav from './components/BottomNav'
import TopBanner from './components/TopBanner'
import UsernameBanner from './components/UsernameBanner'
import TxPreview from './components/TxPreview'
import Welcome from './components/Welcome'
import ProofManager from './ton/ProofManager'
import Feed from './pages/Feed'
import CreateOrder from './pages/CreateOrder'
import OrderDetail from './pages/OrderDetail'
import MyOrders from './pages/MyOrders'
import Profile from './pages/Profile'
import Debug from './pages/Debug'

// Map the current path to a page. Tiny by design.
function renderPage(path) {
  if (path === '/' || path === '') return <Feed />
  if (path === '/create') return <CreateOrder />
  if (path === '/my') return <MyOrders />
  if (path === '/profile') return <Profile />
  // Hidden diagnostics screen, no link in the nav (see pages/Debug.jsx).
  if (path === '/debug') return <Debug />
  if (path.startsWith('/order/')) {
    const address = decodeURIComponent(path.slice('/order/'.length))
    return <OrderDetail address={address} />
  }
  return <Feed />
}

export default function App() {
  const path = usePath()
  return (
    <div className="app">
      {/* Requests and checks ton_proof on connect. Renders nothing. */}
      <ProofManager />
      <TopBanner />
      {/* The @username nudge only matters on the create tab, where a missing
          handle actually blocks the flow. Hidden everywhere else. */}
      {path === '/create' && <UsernameBanner />}
      <main className="content">{renderPage(path)}</main>
      <BottomNav />
      {/* The transaction preview modal lives here, shown on demand. */}
      <TxPreview />
      {/* One-time intro on the first visit (see components/Welcome.jsx). */}
      <Welcome />
    </div>
  )
}
