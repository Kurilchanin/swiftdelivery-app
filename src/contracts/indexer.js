// Feed discovery via toncenter v3, through our Worker.
//
// An order's address is the hash of its initial state, so the frontend cannot
// enumerate other people's orders from chain state alone. Instead we read the
// OrderCreated events: the Marketplace emits one for every order it deploys (an
// external-out message, see types.tolk), and only the Marketplace can send a
// message whose source is the Marketplace. Reading its transactions instead let
// anyone push every real order off the first pages with cheap empty messages.
import { Cell } from '@ton/core'
import { OrderCreated } from '../../contract/wrappers-ts/Marketplace.gen'
import { TONCENTER_V3, MARKETPLACE_ADDRESS, APP_KEY } from '../ton/network'
import { toUsdtUnits } from '../ton/jetton'
import { MIN_REWARD_USD } from './orders'

const OP_ORDER_CREATED = '0xa00a0100'
const MARKETPLACE = MARKETPLACE_ADDRESS
const API_KEY = APP_KEY
const HEADERS = API_KEY ? { headers: { 'X-API-Key': API_KEY } } : undefined
// The contract takes rewards from 1 USDT; the app's floor is MIN_REWARD_USD.
// Smaller orders are not shown, so cheap spam orders cannot fill the Feed.
const MIN_REWARD_UNITS = toUsdtUnits(MIN_REWARD_USD)

// One page of order addresses from OrderCreated events, newest first, with
// rewards below the app's floor left out.
//
// Paginates via end_lt: the next page requests events with lt strictly less
// than the last one seen, so pages never overlap when new orders arrive during
// browsing. We request limit+1 rows to detect a next page without a separate
// count query.
//
// Returns { addresses, next }, where `next` is the cursor for the following
// (older) page, or null when there are no more pages.
export async function listOrderPage({ limit = 40, lt, attempt = 0 } = {}) {
  if (!MARKETPLACE) return { addresses: [], next: null }
  try {
    let url =
      TONCENTER_V3 +
      '/messages?source=' +
      encodeURIComponent(MARKETPLACE) +
      '&opcode=' +
      OP_ORDER_CREATED +
      '&limit=' +
      (limit + 1) +
      '&sort=desc'
    if (lt) {
      // end_lt is inclusive (lt <= end_lt), so subtract 1 to exclude the cursor event.
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

    const raw = data?.messages || []
    const hasMore = raw.length > limit
    const msgs = hasMore ? raw.slice(0, limit) : raw

    const seen = new Set()
    const addresses = []
    for (const m of msgs) {
      try {
        if (m.opcode !== OP_ORDER_CREATED) continue
        const ev = OrderCreated.fromSlice(Cell.fromBase64(m.message_content.body).beginParse())
        if (ev.reward < MIN_REWARD_UNITS) continue
        const addr = ev.orderAddress.toRawString()
        if (!seen.has(addr)) {
          seen.add(addr)
          addresses.push(addr)
        }
      } catch {
        // skip an event we cannot read
      }
    }

    const last = msgs[msgs.length - 1]
    const next = hasMore && last?.created_lt ? { lt: last.created_lt } : null
    return { addresses, next }
  } catch {
    return { addresses: [], next: null, failed: true }
  }
}
