// The frontend must compute exactly what the contracts compute. If the create
// payload differs, the Marketplace refuses the order and sends the USDT back; if
// the order address differs, the delivery code is saved under the wrong address
// and can never be shown. So both are pinned to values the contracts produced:
//
//   contract/scripts/xcheck.tolk — a Marketplace deployed in the emulator with
//   the owner below, asked for the payload hash and orderAddress() of the fixed
//   order below.
//
// When the Order code changes, these values change too: regenerate the TS
// wrappers (acton wrapper Order --ts --output-dir wrappers-ts, same for
// Marketplace), re-run that script and paste its values here. A stale wrapper
// fails this test — that is how it was caught once.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { Address, beginCell, contractAddress } from '@ton/core'
import { Order, OrderExtra, OrderJetton, OrderStorage } from '../../contract/wrappers-ts/Order.gen'

const OWNER = '0:' + '11'.repeat(32)
const REFERRAL = '0:' + '22'.repeat(32)
const CLIENT = '0:' + '33'.repeat(32)
const MARKET = 'kQDiO-rVKkx1OE2F_mSVxYZYFMzr_klAyPVDuaxRfA18LRX8'
const SECRET_HASH = 0xc0de1234c0de1234c0de1234c0de1234c0de1234c0de1234c0de1234c0de1234n
const DELIVERY_TIME = 14 * 24 * 60 * 60 // the script's delivery time: 14 days

const PAYLOAD_HASH = 48566882241072268398069478752263583860898833727627128952780908044642622513089n
const PAYLOAD_NULL_HASH = 73074449624457809048837951373276515600004078069286563914516533411664244896762n
const ORDER = 'kQDyD7qy3tb54sbgCCAx3HXM297UBufliQBWHzUu-TylE5Bp'
const ORDER_NULL = 'kQCY3uSANAxrfxRo_CTl0PqUm1ChP6FAtQvqe84EiHNFLZDj'

// The Marketplace owner is part of every order's init data; the app reads it
// from the chain. Here the "chain" answers with OWNER.
vi.mock('./client', () => ({
  getClient: () => ({ open: () => ({ getOwner: async () => Address.parse(OWNER) }) }),
}))

// One-byte text cells: the script used storeUint(n, 8), the app stores text.
const byte = (n) => beginCell().storeUint(n, 8).endCell()
const cellHash = (c) => BigInt('0x' + c.hash().toString('hex'))

let orders
let jetton
beforeAll(async () => {
  vi.stubEnv('VITE_TON_NETWORK', 'testnet')
  vi.stubEnv('VITE_MARKETPLACE_ADDRESS', MARKET)
  vi.resetModules()
  orders = await import('./orders.js')
  jetton = await import('../ton/jetton.js')
})

function payloadFields(referral) {
  return {
    nonce: 12345n,
    createdAt: 1700000000,
    deliveryTime: DELIVERY_TIME,
    description: byte(1),
    area: byte(2),
    origin: byte(3),
    clientContact: byte(4),
    secretHash: SECRET_HASH,
    referral,
  }
}

describe('create payload matches the contract', () => {
  it('with a referral', () => {
    const p = jetton.createOrderPayload(payloadFields(Address.parse(REFERRAL)))
    expect(cellHash(p)).toBe(PAYLOAD_HASH)
  })

  it('without a referral', () => {
    expect(cellHash(jetton.createOrderPayload(payloadFields(null)))).toBe(PAYLOAD_NULL_HASH)
  })

  it('reads back what it wrote', () => {
    const back = jetton.parseCreateOrderPayload(
      jetton.createOrderPayload(payloadFields(Address.parse(REFERRAL))),
    )
    expect(back.nonce).toBe(12345n)
    expect(back.createdAt).toBe(1700000000)
    expect(back.deliveryTime).toBe(DELIVERY_TIME)
    expect(back.secretHash).toBe(SECRET_HASH)
    expect(back.referral.equals(Address.parse(REFERRAL))).toBe(true)
    expect(back.area.hash().equals(byte(2).hash())).toBe(true)
  })
})

describe('order address matches the contract', () => {
  const fields = (referral) => ({
    client: CLIENT,
    reward: 10, // USDT — 10_000_000 units, as in the script
    nonce: '12345',
    createdAt: 1700000000,
    deliveryTime: DELIVERY_TIME,
    description: '\x01',
    area: '\x02',
    origin: '\x03',
    clientContact: '\x04',
    secretHash: SECRET_HASH,
    referral,
  })

  it('with a referral', async () => {
    const addr = await orders.computeOrderAddress(fields(REFERRAL))
    expect(Address.parse(addr).equals(Address.parse(ORDER))).toBe(true)
  })

  it('without a referral', async () => {
    const addr = await orders.computeOrderAddress(fields(null))
    expect(Address.parse(addr).equals(Address.parse(ORDER_NULL))).toBe(true)
  })
})

describe('the create transfer', () => {
  it('reads back what it wrote', () => {
    const payload = jetton.createOrderPayload(payloadFields(null))
    const body = jetton.jettonTransferBody({
      amount: jetton.toUsdtUnits(10),
      destination: Address.parse(MARKET),
      responseDestination: Address.parse(CLIENT),
      forwardTonAmount: 200000000n,
      forwardPayload: payload,
    })
    const back = jetton.parseJettonTransfer(body)
    expect(back.amount).toBe(10000000n)
    expect(back.destination.equals(Address.parse(MARKET))).toBe(true)
    expect(back.payload.hash().equals(payload.hash())).toBe(true)
  })

  it('uses 6 decimals, never 9', () => {
    expect(jetton.toUsdtUnits(12.34)).toBe(12340000n)
    expect(jetton.fromUsdtUnits(12340000n)).toBe(12.34)
  })
})

// Orders read from chain must be ones our Marketplace deployed. Anyone can deploy
// our Order code with made-up data (status Open, a big reward, no USDT behind it)
// and send a courier a link to it. isGenuineOrder rebuilds the order's INITIAL
// state from its stored create-time fields, with OUR Marketplace in it, and wants
// that to hash to the order's address. The real address is ORDER above — the
// contract itself computed it — so this is checked against the contract, not
// against the app's own math.
describe('orders read from chain', () => {
  const ATTACKER = '0:' + '66'.repeat(32)
  const COURIER = Address.parse('0:' + '44'.repeat(32))
  const WALLET = Address.parse('0:' + '55'.repeat(32))
  const LOCKED = Address.parseRaw('1:' + '07'.repeat(32)) // a workchain that does not exist
  const CODE = Order.CodeCell.hash().toString('base64')

  // The storage cell of the order behind ORDER once funded (Open, wallet set).
  // `over` changes single fields to get a later state, or a fake.
  function storedCell(over = {}) {
    const o = {
      status: 0n,
      courier: null,
      courierContact: beginCell().endCell(),
      acceptedAt: 0n,
      reward: 10000000n,
      owner: OWNER,
      marketplace: MARKET,
      referral: Address.parse(REFERRAL),
      ...over,
    }
    return OrderStorage.toCell(
      OrderStorage.create({
        client: Address.parse(CLIENT),
        courier: o.courier,
        description: byte(1),
        area: byte(2),
        origin: byte(3),
        reward: o.reward,
        status: o.status,
        nonce: 12345n,
        createdAt: 1700000000n,
        acceptedAt: o.acceptedAt,
        deliveryTime: BigInt(DELIVERY_TIME),
        extra: {
          ref: OrderExtra.create({
            owner: Address.parse(o.owner),
            clientContact: byte(4),
            courierContact: o.courierContact,
            secretHash: SECRET_HASH,
            referral: o.referral,
            jetton: {
              ref: OrderJetton.create({ marketplace: Address.parse(o.marketplace), wallet: WALLET }),
            },
          }),
        },
      }),
    )
  }
  const stored = (over) => OrderStorage.fromSlice(storedCell(over).beginParse())
  // Where an attacker's contract lands: our code, their data.
  const deployedAt = (cell) => contractAddress(0, { code: Order.CodeCell, data: cell }).toString()
  const account = (address, cell, code = CODE) => ({
    address: Address.parse(address).toRawString(),
    status: 'active',
    code_hash: code,
    data_boc: cell.toBoc().toString('base64'),
  })
  const serve = (accounts) =>
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ accounts }) }))

  it('accepts the real order in every state', () => {
    const taken = { courier: COURIER, courierContact: byte(5), acceptedAt: 1700000100n }
    expect(orders.isGenuineOrder(ORDER, stored())).toBe(true) // Open
    expect(orders.isGenuineOrder(ORDER, stored({ ...taken, status: 1n }))).toBe(true) // Accepted
    expect(orders.isGenuineOrder(ORDER, stored({ ...taken, status: 2n }))).toBe(true) // Completed
  })

  it('rejects our code deployed with made-up data', () => {
    for (const over of [{ owner: ATTACKER }, { marketplace: ATTACKER }, { reward: 1000000000n }]) {
      const cell = storedCell(over)
      expect(orders.isGenuineOrder(deployedAt(cell), stored(over))).toBe(false)
    }
    // A foreign Marketplace is refused even at the real address.
    expect(orders.isGenuineOrder(ORDER, stored({ marketplace: ATTACKER }))).toBe(false)
    // The right data at another address (ORDER_NULL = the same order, no referral).
    expect(orders.isGenuineOrder(ORDER_NULL, stored())).toBe(false)
  })

  it('readOrdersBatch keeps real orders, drops fakes, flags a locked referral', async () => {
    const fakeCell = storedCell({ owner: ATTACKER })
    const fake = deployedAt(fakeCell)
    // A genuine order whose referral locks it (see src/referral.js).
    const locked = await orders.computeOrderAddress({
      client: CLIENT,
      reward: 10,
      nonce: '12345',
      createdAt: 1700000000,
      deliveryTime: DELIVERY_TIME,
      description: '\x01',
      area: '\x02',
      origin: '\x03',
      clientContact: '\x04',
      secretHash: SECRET_HASH,
      referral: LOCKED,
    })
    serve([
      account(ORDER, storedCell()),
      account(fake, fakeCell),
      account(locked, storedCell({ referral: LOCKED })),
    ])
    try {
      const read = await orders.readOrdersBatch([ORDER, fake, locked])
      expect(read.map((o) => [o.address, o.referralLocked])).toEqual([
        [ORDER, false],
        [locked, true],
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('readOrder tells a fake from a real order', async () => {
    const fakeCell = storedCell({ reward: 1000000000n })
    const fake = deployedAt(fakeCell)
    const read = async (address, accounts) => {
      serve(accounts)
      return orders.readOrder(address)
    }
    try {
      const real = await read(ORDER, [account(ORDER, storedCell())])
      expect(real.status).toBe('Open')
      expect(real.reward).toBe(10)
      expect(Address.parse(real.client).equals(Address.parse(CLIENT))).toBe(true)
      expect(real.clientContact).toBe('\x04')
      expect(real.genuine).toBeUndefined()
      expect(await read(fake, [account(fake, fakeCell)])).toEqual({ address: fake, genuine: false })
      // Some other contract entirely.
      expect(await read(fake, [account(fake, fakeCell, 'b3RoZXI=')])).toEqual({
        address: fake,
        genuine: false,
      })
      // Nothing at that address.
      expect(await read(fake, [])).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
