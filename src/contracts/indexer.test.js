// The Feed lists orders from the Marketplace's OrderCreated events only, and
// leaves out rewards below the app's floor. Junk cannot get in: only the
// Marketplace sends messages whose source is the Marketplace.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { Address, beginCell } from '@ton/core'
import { OrderCreated } from '../../contract/wrappers-ts/Marketplace.gen'

const MARKET = 'kQACtbfXamGMeG_lcargOaWAdT3mGBMTmzjfAniEgCurbz8Q'
const addr = (b) => Address.parse('0:' + b.repeat(32))
const event = (order, usdt, lt) => ({
  opcode: '0xa00a0100',
  created_lt: String(lt),
  message_content: {
    body: OrderCreated.toCell(
      OrderCreated.create({
        orderAddress: addr(order),
        client: addr('33'),
        reward: BigInt(usdt * 1e6),
        area: beginCell().storeStringTail('Paris').endCell(),
      }),
    ).toBoc().toString('base64'),
  },
})

let listOrderPage
beforeAll(async () => {
  vi.stubEnv('VITE_TON_NETWORK', 'testnet')
  vi.stubEnv('VITE_MARKETPLACE_ADDRESS', MARKET)
  vi.resetModules()
  ;({ listOrderPage } = await import('./indexer.js'))
})
afterEach(() => vi.unstubAllGlobals())

function serve(messages) {
  const urls = []
  vi.stubGlobal('fetch', async (u) => {
    urls.push(u)
    return { ok: true, status: 200, json: async () => ({ messages }) }
  })
  return urls
}

describe('listOrderPage', () => {
  it('asks only for OrderCreated events of our Marketplace', async () => {
    const urls = serve([])
    await listOrderPage({ limit: 2 })
    expect(urls[0]).toContain('/messages?source=' + encodeURIComponent(MARKET))
    expect(urls[0]).toContain('opcode=0xa00a0100')
    expect(urls[0]).toContain('limit=3')
  })

  it('keeps orders from the floor up, drops cheap ones and junk', async () => {
    serve([
      event('01', 25, 300),
      event('02', 5, 200), // below the 10 USDT floor
      { opcode: '0xa00a0100', created_lt: '150', message_content: { body: 'junk' } },
      event('03', 10, 100),
    ])
    const { addresses, next } = await listOrderPage({ limit: 10 })
    expect(addresses).toEqual([addr('01').toRawString(), addr('03').toRawString()])
    expect(next).toBeNull()
  })

  it('pages with an lt cursor', async () => {
    const urls = serve([event('01', 20, 300), event('02', 20, 200), event('03', 20, 100)])
    const page = await listOrderPage({ limit: 2 })
    expect(page.addresses).toHaveLength(2)
    expect(page.next).toEqual({ lt: '200' })
    await listOrderPage({ limit: 2, lt: page.next.lt })
    expect(urls[1]).toContain('end_lt=199')
  })

  it('says when it could not read', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }))
    expect((await listOrderPage()).failed).toBe(true)
  })
})
