// Tests for the courier history the client sees. The chain is faked at two
// seams: apiFetch (the courier's messages, by opcode) and readOrdersBatch (the
// orders' current state — it returns genuine orders only, as the real one does).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const chain = vi.hoisted(() => ({ messages: {}, orders: [] }))

vi.mock('./historyScanner', () => ({
  apiFetch: async (path) => {
    const list = chain.messages[/opcode=(0x[0-9a-f]+)/.exec(path)[1]]
    return list === null ? null : { messages: (list || []).map((destination) => ({ destination })) }
  },
}))
vi.mock('./orders', async (importOriginal) => ({
  ...(await importOriginal()),
  readOrdersBatch: async (addresses) => chain.orders.filter((o) => addresses.includes(o.address)),
}))

const { courierReputation } = await import('./reputation')

const ACCEPT = '0xa00a0001'
const RELEASE = '0xa00a0005'
const COURIER = '0:' + '44'.repeat(32)
const OTHER = '0:' + '55'.repeat(32)
const at = (n) => '0:' + String(n).repeat(64)

beforeEach(() => {
  chain.messages = {}
  chain.orders = []
})

describe('courierReputation', () => {
  it('counts delivered, gave up and missed from genuine orders only', async () => {
    chain.orders = [
      { address: at(1), status: 'Completed', courier: COURIER }, // delivered
      { address: at(2), status: 'Expired', courier: COURIER }, // missed
      { address: at(3), status: 'Open', courier: null }, // given up, open again
      { address: at(4), status: 'Completed', courier: OTHER }, // given up, another delivered
      { address: at(5), status: 'Accepted', courier: COURIER }, // still running
    ]
    chain.messages[ACCEPT] = [at(1), at(2), at(3), at(4), at(5), at(9)]
    // at(9) is not a genuine order (readOrdersBatch drops it): it must not count.
    chain.messages[RELEASE] = [at(3), at(4), at(9)]
    expect(await courierReputation(COURIER)).toEqual({ delivered: 1, missed: 1, gaveUp: 2 })
  })

  it('an order given up twice counts twice', async () => {
    chain.orders = [{ address: at(3), status: 'Open', courier: null }]
    chain.messages[ACCEPT] = [at(3), at(3)]
    chain.messages[RELEASE] = [at(3), at(3)]
    expect(await courierReputation(COURIER)).toEqual({ delivered: 0, missed: 0, gaveUp: 2 })
  })

  it('a new courier has an empty record', async () => {
    expect(await courierReputation(COURIER)).toEqual({ delivered: 0, missed: 0, gaveUp: 0 })
  })

  it('a failed request gives null, never a clean "new courier" record', async () => {
    chain.messages[ACCEPT] = null
    expect(await courierReputation(COURIER)).toBeNull()
  })
})
