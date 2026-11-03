// The invite mailbox in our Worker (worker/src/router.js, /invite/<net>/<order>). A
// signed invite is 86+ chars and a Telegram mini-app link carries at most 64, so
// the client's app puts the invite here and the courier's app reads it back by
// the order's address. The server is only a mailbox: it checks the signature
// against the order on chain before storing, and the courier's app checks it
// again (verifyInvite) before using it — nothing from here is trusted as is.
// One invite per order: a new one replaces the old.
import { Address } from '@ton/core'
import { API_BASE, APP_KEY, NETWORK } from '../ton/network'

const API = `${API_BASE}/invite/${NETWORK}`
const KEY = APP_KEY ? { 'X-API-Key': APP_KEY } : {}

const url = (order) => API + '/' + Address.parse(order).toString({ urlSafe: true })

// Store the client's invite. Resolves { ok } or { ok: false, status } (429 =
// sent too often, 400 = refused by the server's checks).
export async function putInvite(order, { courier, validUntil, signature }) {
  try {
    const r = await fetch(url(order), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...KEY },
      body: JSON.stringify({ courier, validUntil, signature }),
    })
    return r.ok ? { ok: true } : { ok: false, status: r.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

// The order's current invite { courier, validUntil, signature }, or null (none,
// expired, or the server did not answer).
export async function getInvite(order) {
  try {
    const r = await fetch(url(order), { cache: 'no-store', headers: KEY })
    if (!r.ok) return null
    const j = await r.json()
    if (!j || typeof j.courier !== 'string' || typeof j.signature !== 'string') return null
    return { courier: j.courier, validUntil: Number(j.validUntil), signature: j.signature }
  } catch {
    return null
  }
}
