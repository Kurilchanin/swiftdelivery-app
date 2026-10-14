// Recover orders from the blockchain for wallets that lost localStorage.
//
// "sent"  — the wallet's USDT transfers to the Marketplace (the forward payload
//           of each carries all of the order's fields).
// "taken" — AcceptOrder messages (opcode 0xa00a0001) sent by the wallet.
// A closed order is NOT destroyed: it stays on chain in its
// terminal status, so closed and active orders are both read the same way — in
// one batched /accountStates call.

import { Cell, Address } from '@ton/core'
import { computeOrderAddress, readOrdersBatch, cellToText, isTerminalStatus, sameAddress } from './orders'
import { track, untrack, getHistory } from './myOrders'
import { fromUsdtUnits, parseJettonTransfer, parseCreateOrderPayload } from '../ton/jetton'
import { TONCENTER_V3, MARKETPLACE_ADDRESS, TONCENTER_API_KEY } from '../ton/network'

const MARKETPLACE = MARKETPLACE_ADDRESS
const API_KEY = TONCENTER_API_KEY
const BASE = TONCENTER_V3

// A create is a jetton `transfer` the wallet sends to its own USDT wallet.
const OP_JETTON_TRANSFER = '0x0f8a7ea5'

// Max orders to scan per role (sent / taken) in one sync.
const HISTORY_LIMIT = 50

function toRaw(addr) {
  try {
    return Address.parse(addr).toRawString()
  } catch {
    return addr
  }
}

// Fetch with exponential backoff + jitter on 429. Also used by reputation.js.
export async function apiFetch(path, attempt = 0) {
  try {
    const headers = API_KEY ? { 'X-API-Key': API_KEY } : {}
    const r = await fetch(BASE + path, { headers })
    if (r.status === 429 && attempt < 4) {
      // Jitter spreads retries so simultaneous 429s don't fire at the same time.
      const delay = 1000 * 2 ** attempt + Math.random() * 800
      await new Promise((res) => setTimeout(res, delay))
      return apiFetch(path, attempt + 1)
    }
    if (!r.ok) return null
    return r.json()
  } catch {
    return null
  }
}

// Collect all order addresses this wallet accepted, newest first.
// Uses /messages?opcode=0xa00a0001 to get AcceptOrder messages directly,
// avoiding the need to scan all wallet transactions.
async function fetchAcceptedAddresses(wallet) {
  const data = await apiFetch(
    `/messages?source=${encodeURIComponent(toRaw(wallet))}&opcode=0xa00a0001&limit=${HISTORY_LIMIT}&sort=desc`,
  )
  const seen = new Set()
  const orderAddresses = []
  for (const msg of data?.messages || []) {
    if (msg.destination && !seen.has(msg.destination)) {
      seen.add(msg.destination)
      orderAddresses.push(msg.destination)
    }
  }
  return orderAddresses
}

// Collect the addresses of all orders this wallet created, newest first. A
// create is a USDT transfer to the Marketplace whose forward payload holds the
// order's fields, so each one lets us recompute its order's address. Transfers
// to anyone else, and creates the Marketplace refused (their address was never
// deployed), fall out here or in the batched read that follows.
async function fetchSentAddresses(wallet) {
  if (!MARKETPLACE) return []
  const data = await apiFetch(
    `/messages?source=${encodeURIComponent(toRaw(wallet))}` +
      `&opcode=${OP_JETTON_TRANSFER}&limit=${HISTORY_LIMIT}&sort=desc`,
  )
  const orderAddresses = []
  for (const msg of data?.messages || []) {
    try {
      const boc = msg.message_content?.body
      if (!boc) continue
      const tr = parseJettonTransfer(Cell.fromBase64(boc))
      if (!tr?.payload || !sameAddress(tr.destination.toString(), MARKETPLACE)) continue
      const co = parseCreateOrderPayload(tr.payload)
      if (!co) continue
      const orderAddr = await computeOrderAddress({
        client: wallet,
        reward: fromUsdtUnits(tr.amount),
        nonce: co.nonce.toString(),
        createdAt: co.createdAt,
        deliveryTime: co.deliveryTime,
        description: cellToText(co.description),
        area: cellToText(co.area),
        origin: cellToText(co.origin),
        clientContact: cellToText(co.clientContact),
        secretHash: co.secretHash,
        // The referral is part of the order's init data, so it MUST go in here
        // too: without it the recomputed address does not match the deployed
        // order, and every order created through a referral link stays invisible
        // to the sync (and its delivery code is never cleaned up).
        referral: co.referral,
      })
      orderAddresses.push(orderAddr)
    } catch {
      // skip malformed message
    }
  }
  return orderAddresses
}

// The closed orders among these addresses, as History entries for `role`.
// `known` holds raw addresses already saved in local history (or known to be
// active); they are skipped so a closed order is fetched from chain only once.
async function closedOrders(orderAddresses, known, role) {
  const fresh = orderAddresses.filter((a) => !known.has(toRaw(a)))
  const read = await readOrdersBatch(fresh)
  return read.filter((o) => isTerminalStatus(o.status)).map((o) => ({ ...o, role }))
}

// Scan chain for all closed orders related to this wallet (sent + taken).
// `activeAddrs` are the order addresses the caller already confirmed are still
// active (via recoverActiveSent/Taken, which read them in ONE batched
// /accountStates call). We skip them here, and the orders already in History,
// so in steady state this reads ~nothing.
export async function scanChainHistory(wallet, activeAddrs = []) {
  if (!wallet) return []
  // Terminal orders never change, so skip any already saved in local history.
  // Active orders are added to the same skip set so they are not read twice.
  const known = new Set([
    ...getHistory(wallet).map((e) => toRaw(e.address)),
    ...activeAddrs.map((a) => toRaw(a)),
  ])
  const [sentAddrs, takenAddrs] = await Promise.all([
    fetchSentAddresses(wallet),
    fetchAcceptedAddresses(wallet),
  ])
  const [sent, taken] = await Promise.all([
    closedOrders(sentAddrs, known, 'sent'),
    closedOrders(takenAddrs, known, 'taken'),
  ])
  const seen = new Set()
  return [...sent, ...taken].filter((e) => {
    const key = `${e.address}:${e.role}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Recover active taken orders and re-add them to localStorage tracking.
export async function recoverActiveTaken(wallet) {
  if (!wallet) return []
  const orderAddresses = await fetchAcceptedAddresses(wallet)

  // One batched /accountStates call for all candidates instead of one per order.
  // readOrdersBatch also drops orders on a different code version, so an order
  // accepted on a previous Marketplace never lands in the Taken tab.
  const live = await readOrdersBatch(orderAddresses)
  // Keep only orders that are still active AND where we are still the courier.
  // An order we released went back to Open (courier cleared / re-taken), so it
  // must leave the Taken tab too.
  const mine = live.filter((o) => !isTerminalStatus(o.status) && sameAddress(o.courier, wallet))
  const keep = new Set(mine.map((o) => toRaw(o.address)))
  // `live` only has addresses /accountStates actually answered for. A brand-new
  // order can be missing from it for a moment — its /messages entry (which built
  // orderAddresses) is indexed slightly ahead of /accountStates — and that lag
  // must never read as "gone": untrack only a candidate the chain DID answer for
  // but ruled out, never one it stayed silent on (see the same rule in
  // sweepCloudSecrets, above).
  const answered = new Set(live.map((o) => toRaw(o.address)))
  for (const addr of orderAddresses) {
    const raw = toRaw(addr)
    if (answered.has(raw) && !keep.has(raw)) untrack(wallet, addr, 'taken')
  }
  mine.forEach((o) => track(wallet, o.address, 'taken'))
  return mine
}

// Recover active sent orders and re-add them to localStorage tracking.
export async function recoverActiveSent(wallet) {
  if (!wallet || !MARKETPLACE) return []
  const orderAddresses = await fetchSentAddresses(wallet)
  if (!orderAddresses.length) return []

  // One batched /accountStates call for all candidates instead of one per order.
  const live = await readOrdersBatch(orderAddresses)
  const active = live.filter((o) => !isTerminalStatus(o.status))
  const keep = new Set(active.map((o) => toRaw(o.address)))
  // Same rule as recoverActiveTaken: only untrack a candidate /accountStates
  // actually answered for and ruled out. One still missing from `live` (e.g. a
  // just-created order that /messages sees before /accountStates catches up)
  // must stay tracked — untracking it here was making a fresh order vanish from
  // the Sent tab on ↻ and only reappear after the next visit re-tracked it.
  const answered = new Set(live.map((o) => toRaw(o.address)))
  for (const addr of orderAddresses) {
    const raw = toRaw(addr)
    if (answered.has(raw) && !keep.has(raw)) untrack(wallet, addr, 'sent')
  }
  active.forEach((o) => track(wallet, o.address, 'sent'))
  return active
}
