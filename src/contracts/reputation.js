// Courier history, shown to the client once a courier took their order. There is
// no backend, so it comes from the chain alone: the courier's own messages say
// which orders they took (AcceptOrder) and gave up (CourierRelease), and each
// order's current state says how the rest ended. Only orders our Marketplace
// deployed count (readOrdersBatch drops fakes), so a courier cannot pad the
// record with made-up orders of their own.
import { Address } from '@ton/core'
import { apiFetch } from './historyScanner'
import { readOrdersBatch, sameAddress, STATUS } from './orders'

const OP_ACCEPT = '0xa00a0001'
const OP_RELEASE = '0xa00a0005'
// How many of the courier's latest messages of each kind are looked at.
const LIMIT = 50

const raw = (a) => Address.parse(a).toRawString()

// The destinations of the courier's latest messages with this opcode — one entry
// per message, so an order given up twice counts twice — or null when the
// request failed.
async function destinations(courier, opcode) {
  const data = await apiFetch(
    `/messages?source=${encodeURIComponent(raw(courier))}&opcode=${opcode}&limit=${LIMIT}&sort=desc`,
  )
  if (!data) return null
  return (data.messages || []).map((m) => m.destination).filter(Boolean)
}

// { delivered, gaveUp, missed } for a courier, or null when the chain could not
// be asked (then the page shows nothing rather than a wrong "new courier").
export async function courierReputation(courier) {
  const [accepted, released] = await Promise.all([
    destinations(courier, OP_ACCEPT),
    destinations(courier, OP_RELEASE),
  ])
  if (!accepted || !released) return null
  const orders = await readOrdersBatch([...new Set([...accepted, ...released])])
  const genuine = new Set(orders.map((o) => raw(o.address)))
  // Orders that ended with this courier still holding them.
  const endedWith = (status) =>
    orders.filter((o) => o.status === status && o.courier && sameAddress(o.courier, courier)).length
  return {
    delivered: endedWith(STATUS.Completed),
    missed: endedWith(STATUS.Expired),
    gaveUp: released.filter((a) => genuine.has(raw(a))).length,
  }
}
