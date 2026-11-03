// The invite mailbox behind functions/api/invite/[order].js. Pure: the caller
// passes the time, the store and a way to read an account, so tests run it with
// fakes and the Pages function wires in D1 and toncenter.
//
//   GET /api/invite/<order>  → 200 { courier, validUntil, signature } | 404
//   PUT /api/invite/<order>  { courier, validUntil, signature } → 204 | 400 | 429
//
// A PUT is stored only when the order is a genuine, Open order of OUR
// Marketplace and the signature is its client's invite key (see invite.js). So
// nobody but the client can fill or overwrite an order's slot, and a fake order
// (our code, made-up data) cannot be used to fill the store. One slot per order;
// a client may replace it at most once every MIN_GAP seconds.
import { Address } from '@ton/core'
import { genuineOrderStorage } from '../contracts/orderState.js'
import { verifyInvite, INVITE_MAX_TTL } from '../contracts/invite.js'

export const MIN_GAP = 30
const MAX_BODY = 1024
const OPEN = 0 // OrderStatus.Open

const json = (status, obj) => ({
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: obj == null ? null : JSON.stringify(obj),
})

const parseAddress = (s) => {
  try {
    return Address.parse(String(s))
  } catch {
    return null
  }
}

// `db`: { get(key) → { courier, validUntil, signature } | null,
//         put(key, row, now, minGap) → true when written, false when too soon }
// `fetchAccount(address)` → a toncenter v3 /accountStates account or null.
// `marketplace`: Address of OUR Marketplace.
export async function handleInvite({ method, orderParam, bodyText, now, db, fetchAccount, marketplace }) {
  const order = parseAddress(orderParam)
  if (!order) return json(400, { error: 'bad order' })
  const key = order.toRawString()

  if (method === 'GET') {
    const row = await db.get(key)
    if (!row || row.validUntil < now) return json(404, { error: 'none' })
    return json(200, row)
  }

  if (method !== 'PUT') return json(405, { error: 'method' })
  if (!marketplace) return json(503, { error: 'not configured' })
  if (typeof bodyText !== 'string' || bodyText.length > MAX_BODY) return json(400, { error: 'body' })
  let body
  try {
    body = JSON.parse(bodyText)
  } catch {
    return json(400, { error: 'body' })
  }
  const courier = parseAddress(body?.courier)
  const validUntil = Number(body?.validUntil)
  const signature = body?.signature
  if (!courier || !Number.isInteger(validUntil) || typeof signature !== 'string') {
    return json(400, { error: 'fields' })
  }
  if (validUntil <= now || validUntil > now + INVITE_MAX_TTL) return json(400, { error: 'validUntil' })

  const acc = await fetchAccount(order.toString({ urlSafe: true }))
  const s = genuineOrderStorage(key, acc, marketplace)
  if (!s || Number(s.status) !== OPEN) return json(400, { error: 'order' })
  const invite = { order: key, courier: courier.toRawString(), validUntil, signature }
  if (!verifyInvite(invite, s.extra.ref.jetton.ref.acceptKey)) return json(400, { error: 'signature' })

  const row = { courier: invite.courier, validUntil, signature }
  if (!(await db.put(key, row, now, MIN_GAP))) return json(429, { error: 'too soon' })
  return json(204, null)
}
