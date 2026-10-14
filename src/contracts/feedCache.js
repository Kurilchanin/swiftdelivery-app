// Feed cache: the last loaded page of Open orders, kept in localStorage so a
// reload (or a return to the Feed tab) can show the list instantly while a fresh
// copy loads in the background (stale-while-revalidate).
//
// The cache is global (not per-wallet): the Feed shows everyone's open orders.
// Only the first page is cached; "Load more" results are not, so a reload always
// restarts from page one with fresh data.
//
// Order objects are plain JSON (strings, numbers, null — see orderFromStorage in
// orders.js), so they serialize directly.

import { MARKETPLACE_TAG } from '../ton/network'

// Scoped to the active Marketplace: a redeploy changes the key so the cache from
// an old deploy is never shown. Mirrors the base name in myOrders.js (BASE_KEYS).
const FEED_KEY = `swiftparcel.feed.${MARKETPLACE_TAG}`

// Read the cached open orders, or null if there is nothing usable saved.
export function readFeedCache() {
  try {
    const v = JSON.parse(localStorage.getItem(FEED_KEY) || 'null')
    return Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

// Replace the cache with a fresh list. The old data is removed first, then the
// new data is written — so stale orders never linger next to the fresh ones.
export function writeFeedCache(orders) {
  try {
    localStorage.removeItem(FEED_KEY)
    if (Array.isArray(orders) && orders.length) {
      localStorage.setItem(FEED_KEY, JSON.stringify(orders))
    }
  } catch {
    // ignore quota / private-mode errors
  }
}
