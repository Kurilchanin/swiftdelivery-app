// My Orders: orders this wallet created (Sent), accepted (Taken), or closed (History).
// All tabs read from localStorage only. The ↻ button triggers a blockchain sync
// that updates localStorage and re-renders the current tab.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTonAddress, useTonConnectUI } from '@tonconnect/ui-react'
import { readOrders, sameAddress } from '../contracts/orders'
import {
  tracked,
  untrack,
  getHistory,
  saveToHistory,
  getSnapshots,
  clearSnapshot,
  removeSecret,
} from '../contracts/myOrders'
import { scanChainHistory, recoverActiveSent, recoverActiveTaken } from '../contracts/historyScanner'
import OrderCard from '../components/OrderCard'
import Icon from '../components/Icon'
import { t } from '../i18n'

export default function MyOrders() {
  const wallet = useTonAddress()
  const [tonConnectUI] = useTonConnectUI()
  const [tab, setTab] = useState('sent')
  const [refreshing, setRefreshing] = useState(false)
  // The wallet we have already auto-synced for, so opening the tab triggers one
  // background sync per wallet (and not again on every render / StrictMode pass).
  const autoSyncedFor = useRef(null)
  const [refreshKey, setRefreshKey] = useState(0)
  // Chain-fetched details for the Sent/Taken tabs, tagged with the fetch key
  // they belong to. null until the first fetch for the current key completes.
  const [fetched, setFetched] = useState(null)

  // Addresses to load for the current Sent/Taken tab. Read from localStorage, so
  // this is synchronous and derived during render — no setState in an effect.
  // refreshKey is included so a ↻ sync re-reads the freshly written localStorage.
  const addrs = useMemo(
    () => (!wallet || tab === 'history' ? [] : tracked(wallet, tab)),
    // refreshKey is a trigger, not read inside: it forces a re-read of
    // localStorage after a ↻ sync rewrites the tracked addresses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet, tab, refreshKey],
  )

  // History is fully derivable from localStorage — newest first, no network.
  const historyOrders = useMemo(() => {
    if (!wallet || tab !== 'history') return []
    const cached = getHistory(wallet)
    cached.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return cached
    // refreshKey is a trigger, not read inside: re-read localStorage after ↻ sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, tab, refreshKey])

  // A stable id for what the current tab needs fetched. When it changes, the
  // fetched data no longer matches and we render the loading state again.
  const fetchKey = tab + '|' + addrs.join(',')

  // Fetch Sent/Taken order details from chain when there is something to load.
  // setState happens only in the async callback, never synchronously here.
  useEffect(() => {
    if (tab === 'history' || addrs.length === 0) return
    let alive = true
    readOrders(addrs).then((list) => {
      if (!alive) return
      let result = list
      if (tab === 'taken') {
        // Self-heal: drop addresses where we are no longer the courier on chain.
        list
          .filter((o) => !sameAddress(o.courier, wallet))
          .forEach((o) => untrack(wallet, o.address, 'taken'))
        result = list.filter((o) => sameAddress(o.courier, wallet))
      }
      // The chain now has these orders, so their optimistic snapshots are no
      // longer needed — the real data takes over.
      result.forEach((o) => clearSnapshot(wallet, o.address, tab))
      setFetched({ key: fetchKey, list: result })
    })
    return () => {
      alive = false
    }
  }, [fetchKey, tab, addrs, wallet])

  // The list to render, derived from the synchronous sources plus the fetch:
  //   history          → cached list
  //   sent/taken empty → []
  //   sent/taken       → chain list once it matches the key, merged with
  //                      optimistic snapshots for orders not yet on chain;
  //                      while the chain fetch is pending, snapshots alone so a
  //                      just-created order shows instantly (else null = loading)
  const orders = useMemo(() => {
    if (tab === 'history') return historyOrders
    if (addrs.length === 0) return []
    // Snapshots for orders still tracked under this tab (e.g. just created).
    const snaps = getSnapshots(wallet, tab).filter((s) =>
      addrs.some((a) => sameAddress(a, s.address)),
    )
    const chain = fetched && fetched.key === fetchKey ? fetched.list : null
    if (chain === null) return snaps.length ? snaps : null // still loading
    // Chain is the source of truth; add snapshots only for addresses the chain
    // does not return yet (order not deployed yet).
    const extra = snaps.filter((s) => !chain.some((o) => sameAddress(o.address, s.address)))
    // Newest first, like History. The chain list comes back in the batch read's
    // own order (readOrders via /accountStates), not by time, so sort by
    // createdAt — this puts a just-created order (snapshot) on top, not bottom.
    return [...chain, ...extra].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    // refreshKey re-reads snapshots from localStorage after a ↻ sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, addrs, fetched, fetchKey, historyOrders, wallet, refreshKey])

  // Sync all three tabs from the blockchain at once.
  // recoverActive* re-tracks active orders in localStorage.
  // scanChainHistory saves the latest closed orders to localStorage.
  // After sync, incrementing refreshKey re-runs the useEffect above.
  async function handleRefresh() {
    if (!wallet || refreshing) return
    setRefreshing(true)
    try {
      // Run sequentially so all three don't compete for the same Toncenter quota.
      // recoverActive* return the orders they confirmed are still active; we pass
      // those addresses to scanChainHistory so it skips them and the per-order
      // transaction lookup runs only for orders that just went terminal.
      const activeSent = await recoverActiveSent(wallet)
      const activeTaken = await recoverActiveTaken(wallet)
      const activeAddrs = [...activeSent, ...activeTaken].map((o) => o.address)
      const historyItems = await scanChainHistory(wallet, activeAddrs)
      // scanChainHistory returns terminal orders only, so this is also the moment
      // we learn an order is closed no matter who closed it or on which device.
      // Drop the client's delivery code here: OrderDetail only clears it when the
      // client happens to be watching that screen, which is the rarer case.
      historyItems.forEach((item) => {
        saveToHistory(wallet, item, item.role)
        if (item.role === 'sent') removeSecret(item.address)
      })
      // sweepCloudSecrets (contracts/myOrders.js) is NOT run here on purpose: it
      // audits every cloud key against the chain regardless of Marketplace or
      // history depth, which is real value only for the one-off case of a code
      // outliving an order under an OLD Marketplace — but running it on every
      // sync made the ↻ spinner take much longer as cloud history grew. It is
      // still reachable by hand from the hidden Debug screen (Clean junk).
      setRefreshKey((k) => k + 1)
    } finally {
      setRefreshing(false)
    }
  }

  // Auto-sync once when the tab opens (or the wallet changes). This is the same
  // blockchain sync as the ↻ button: it cleans stale tracked orders, rewrites the
  // active ones with their current status, and moves finished ones to History.
  // The cached tabs render instantly first; the fresh data replaces them when the
  // sync finishes (stale-while-revalidate).
  useEffect(() => {
    if (!wallet || autoSyncedFor.current === wallet) return
    autoSyncedFor.current = wallet
    handleRefresh()
    // handleRefresh is stable enough for a one-shot per wallet; re-running on its
    // identity would defeat the once-per-wallet guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet])

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t('my.title')}</h1>
        <button
          className={'icon-btn' + (refreshing ? ' spinning' : '')}
          onClick={handleRefresh}
          disabled={!wallet || refreshing}
          title={t('my.syncTitle')}
          aria-label={t('my.syncTitle')}
        >
          <Icon name="refresh" />
        </button>
      </div>

      {!wallet ? (
        <div className="empty-state">
          <p className="empty">{t('my.connectWallet')}</p>
          <button className="btn btn-primary" onClick={() => tonConnectUI.openModal()}>
            <Icon name="wallet" size={20} />
            {t('profile.connect')}
          </button>
        </div>
      ) : (
        <>
          <div className="tabs">
            <button
              className={'tab' + (tab === 'sent' ? ' active' : '')}
              aria-pressed={tab === 'sent'}
              onClick={() => setTab('sent')}
            >
              {t('my.tabSent')}
            </button>
            <button
              className={'tab' + (tab === 'taken' ? ' active' : '')}
              aria-pressed={tab === 'taken'}
              onClick={() => setTab('taken')}
            >
              {t('my.tabTaken')}
            </button>
            <button
              className={'tab' + (tab === 'history' ? ' active' : '')}
              aria-pressed={tab === 'history'}
              onClick={() => setTab('history')}
            >
              {t('my.tabHistory')}
            </button>
          </div>

          {orders === null ? null : orders.length === 0 ? (
            <div className="empty-state">
              <p className="empty">
                {tab === 'history' ? t('my.emptyHistory') : t('my.empty')}
              </p>
            </div>
          ) : (
            <div className="list">
              {orders.map((o) => (
                <OrderCard key={o.address + (o.role || '')} order={o} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
