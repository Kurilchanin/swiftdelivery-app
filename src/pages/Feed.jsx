// Feed: open orders, discovered via the toncenter indexer.
//
// The list is a paginated scan of the Marketplace's deploys, with a "Load more"
// button (cursor pagination, see listOrderPage). The city dropdown is built from
// the cities of the open orders already loaded, and filtering is a pure
// client-side view over that same list — so a city with no open orders never
// appears, and picking a city needs no extra network calls.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listOrderPage } from '../contracts/indexer'
import { readOrders, cityKey, normalizeCity, filterCityInput, filterPlaceInput, sameAddress, STATUS } from '../contracts/orders'
import { readFeedCache, writeFeedCache } from '../contracts/feedCache'
import OrderCard from '../components/OrderCard'
import FilterSheet from '../components/FilterSheet'
import Icon from '../components/Icon'
import { navigate } from '../router'
import { t } from '../i18n'

const PAGE = 40

// Merge order lists, keeping the first entry per address. Used so a page never
// adds an order already shown (cursor pagination already drops the boundary tx,
// this is a safe guard against any overlap).
function mergeUnique(prev, next) {
  const out = [...prev]
  for (const o of next) {
    if (!out.some((e) => sameAddress(e.address, o.address))) out.push(o)
  }
  return out
}

// Unique normalized cities of the given orders for one field ('area' = the "to"
// city, 'origin' = the "from" city). Returns { key, label } sorted by label, so
// the filter lists every city that has at least one open order, with its count.
function buildCityOptions(orders, field) {
  if (!orders) return []
  const byKey = new Map() // key -> { key, label (first seen), count }
  for (const o of orders) {
    const label = normalizeCity(o[field])
    if (!label) continue
    const key = cityKey(label)
    const city = byKey.get(key)
    if (city) city.count += 1
    else byKey.set(key, { key, label, count: 1 })
  }
  return Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label))
}

export default function Feed() {
  // Start from the cached list (instant on reload / return to tab); null = loading
  // when there is no cache. The mount effect replaces it with a fresh first page.
  const [orders, setOrders] = useState(readFeedCache) // accumulated Open orders
  const [cursor, setCursor] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  // The first page failed and there is nothing to show: an error with a retry,
  // not "no open orders", which would be a false answer.
  const [loadFailed, setLoadFailed] = useState(false)
  const [toQuery, setToQuery] = useState('') // "to" city search; '' = all
  const [fromQuery, setFromQuery] = useState('') // "from" city search; '' = all
  const [filterOpen, setFilterOpen] = useState(false)
  const closeFilter = useCallback(() => setFilterOpen(false), [])

  // Pull one page of deploys, read the new orders, keep the Open ones. An order
  // whose referral locks it (see referralLocksOrder) can never pay a courier, so
  // it is never shown.
  async function fetchPage(cur) {
    const { addresses, next, failed } = await listOrderPage({ limit: PAGE, ...(cur || {}) })
    const loaded = await readOrders(addresses)
    return {
      open: loaded.filter((o) => o.status === STATUS.Open && !o.referralLocked),
      next,
      failed: failed || loaded.failed,
    }
  }

  // First page. Show the cached list at once (so a reload / a return to this tab
  // is instant), then fetch the fresh first page in the background and replace
  // it. writeFeedCache clears the old cache before saving the new list.
  // A failed fetch (e.g. a 429 right as the tab mounts) must NOT replace a
  // populated cache with an empty list — that wiped the Feed to "no open
  // orders" on a plain tab switch, with the real list one navigation away.
  function applyFirstPage({ open, next, failed }) {
    if (failed && orders && orders.length > 0) return
    const fresh = mergeUnique([], open)
    setOrders(fresh)
    setCursor(next)
    setLoadFailed(Boolean(failed) && fresh.length === 0)
    writeFeedCache(fresh)
  }

  useEffect(() => {
    let alive = true
    ;(async () => {
      const page = await fetchPage(null)
      if (alive) applyFirstPage(page)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function retry() {
    setLoadFailed(false)
    setOrders(null) // back to "Loading orders…"
    applyFirstPage(await fetchPage(null))
  }

  async function loadMore() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const { open, next } = await fetchPage(cursor)
      setOrders((prev) => mergeUnique(prev || [], open))
      setCursor(next)
    } finally {
      setLoadingMore(false)
    }
  }

  // Cities for the dropdowns: unique normalized cities of the loaded open orders,
  // built separately for the "to" (destination) and "from" (origin) fields. A
  // city only appears if it has at least one open order in the list, so closed or
  // cancelled-only cities never show.
  const toOptions = useMemo(() => buildCityOptions(orders, 'area'), [orders])
  const fromOptions = useMemo(() => buildCityOptions(orders, 'origin'), [orders])

  // Each search text is the source of truth for its filter; a city tile just
  // fills it. We match by substring (so "par" finds "Paris"), normalized so case
  // and spacing don't matter. An order must match BOTH the "to" and "from" queries.
  const toQ = cityKey(toQuery)
  const fromQ = cityKey(fromQuery)
  const filtering = toQ.length > 0 || fromQ.length > 0
  // Newest first. The batch read (readOrdersBatch via /accountStates) returns
  // orders in the endpoint's own order, not the newest-first order the indexer
  // gave us, so we sort by createdAt here to guarantee new orders sit on top.
  const shown =
    orders === null
      ? null
      : orders
          .filter(
            (o) =>
              (toQ.length === 0 || cityKey(o.area).includes(toQ)) &&
              (fromQ.length === 0 || cityKey(o.origin || '').includes(fromQ)),
          )
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t('feed.title')}</h1>
        {(toOptions.length > 0 || fromOptions.length > 0) && (
          <button
            type="button"
            className="icon-btn"
            aria-label={t('feed.filter')}
            aria-haspopup="dialog"
            onClick={() => setFilterOpen(true)}
          >
            <Icon name="filter" />
            {filtering && <span className="dot" />}
          </button>
        )}
      </div>

      {/* The filters in use, each a chip that clears itself. */}
      {filtering && (
        <div className="chips">
          {toQ && (
            <button type="button" className="chip" onClick={() => setToQuery('')}>
              {t('label.to')}: {toQuery}
              <Icon name="close" size={16} />
            </button>
          )}
          {fromQ && (
            <button type="button" className="chip" onClick={() => setFromQuery('')}>
              {t('label.from')}: {fromQuery}
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
      )}

      {filterOpen && (
        <FilterSheet
          onClose={closeFilter}
          sections={[
            {
              label: t('label.to'),
              placeholder: t('feed.toPlaceholder'),
              allLabel: t('feed.toAll'),
              options: toOptions,
              total: orders?.length || 0,
              query: toQuery,
              onQuery: (v) => setToQuery(filterCityInput(v)),
            },
            {
              label: t('label.from'),
              placeholder: t('feed.fromPlaceholder'),
              allLabel: t('feed.fromAll'),
              options: fromOptions,
              total: orders?.length || 0,
              query: fromQuery,
              onQuery: (v) => setFromQuery(filterPlaceInput(v)),
            },
          ]}
        />
      )}

      {shown === null ? (
        <div className="empty-state">
          <p className="empty" role="status">
            {t('feed.loading')}
          </p>
        </div>
      ) : shown.length === 0 ? (
        loadFailed ? (
          <div className="empty-state">
            <p className="error" role="alert">
              {t('feed.loadFailed')}
            </p>
            <button type="button" className="btn" onClick={retry}>
              <Icon name="refresh" size={20} />
              {t('feed.retry')}
            </button>
          </div>
        ) : filtering ? (
          <div className="empty-state">
            <p className="empty">{t('feed.emptyFiltered')}</p>
          </div>
        ) : (
          <div className="empty-state">
            <p className="empty">{t('feed.empty')}</p>
            {/* Nothing to take yet: the next useful step is to post one. */}
            <button type="button" className="btn btn-primary" onClick={() => navigate('/create')}>
              <Icon name="plus" size={20} />
              {t('create.submit')}
            </button>
          </div>
        )
      ) : (
        <div className="list">
          {shown.map((o) => (
            <OrderCard key={o.address} order={o} />
          ))}
        </div>
      )}

      {cursor && (
        <button
          type="button"
          className="btn load-more"
          onClick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? t('feed.loadingMore') : t('feed.loadMore')}
        </button>
      )}
    </div>
  )
}
