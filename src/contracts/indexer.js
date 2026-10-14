// Feed discovery via a public read-only TON indexer (toncenter v3).
//
// An order's address is the hash of its initial state, so the frontend cannot
// enumerate other people's orders from chain state alone. Instead we read the
// Marketplace's transactions: every order it creates gets a deploy (and a small
// top-up) sent to the new order's address, next to a USDT transfer to the
// Marketplace's own jetton wallet. The order addresses are the destinations of
// all but that transfer. This needs no server of our own, just a public RPC.
const OP_JETTON_TRANSFER = '0x0f8a7ea5'
import { TONCENTER_V3, MARKETPLACE_ADDRESS, TONCENTER_API_KEY } from '../ton/network'

const MARKETPLACE = MARKETPLACE_ADDRESS
const API_KEY = TONCENTER_API_KEY
const HEADERS = API_KEY ? { headers: { 'X-API-Key': API_KEY } } : undefined

// One page of order addresses deployed by the Marketplace, newest first.
//
// Paginates via end_lt: the next page requests transactions with lt strictly
// less than the last lt seen, so pages never overlap when new orders arrive
// during browsing. We request limit+1 rows to detect a next page without a
// separate count query.
//
// Returns { addresses, next }, where `next` is the cursor for the following
// (older) page, or null when there are no more pages.
export async function listOrderPage({ limit = 40, lt, attempt = 0 } = {}) {
  if (!MARKETPLACE) return { addresses: [], next: null }
  try {
    let url =
      TONCENTER_V3 +
      '/transactions?account=' +
      encodeURIComponent(MARKETPLACE) +
      '&limit=' +
      (limit + 1) +
      '&sort=desc'
    if (lt) {
      // end_lt is inclusive (lt <= end_lt), so subtract 1 to exclude the cursor tx.
      url += '&end_lt=' + (BigInt(lt) - 1n).toString()
    }
    const r = await fetch(url, HEADERS)
    if (r.status === 429 && attempt < 3) {
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt + Math.random() * 400))
      return listOrderPage({ limit, lt, attempt: attempt + 1 })
    }
    // A failed request is NOT "no orders": the caller (Feed) must tell the two
    // apart, or a transient 429 on tab-switch wipes the whole Feed to empty.
    if (!r.ok) return { addresses: [], next: null, failed: true }
    const data = await r.json()

    const raw = data?.transactions || []
    const hasMore = raw.length > limit
    const txs = hasMore ? raw.slice(0, limit) : raw

    const seen = new Set()
    const addresses = []
    let last = null
    for (const tx of txs) {
      last = tx
      for (const out of tx.out_msgs || []) {
        // USDT moving on (to an order, or back to a client) is not an order.
        if (out.opcode === OP_JETTON_TRANSFER) continue
        // An empty-body message is the Marketplace's top-up of its unused
        // margin to the order it just deployed; the deploy itself (always an
        // InitWallet body) already named that address.
        if (!out.opcode) continue
        const dest = out.destination
        if (dest && !seen.has(dest)) {
          seen.add(dest)
          addresses.push(dest)
        }
      }
    }

    const next = hasMore && last?.lt ? { lt: last.lt } : null
    return { addresses, next }
  } catch {
    return { addresses: [], next: null, failed: true }
  }
}
