// The invite mailbox must store only real invites: from the client of a genuine,
// Open order of our Marketplace — or a stranger could fill or overwrite an
// order's slot and keep honest couriers out.
import { describe, it, expect } from 'vitest'
import { Address, beginCell, contractAddress } from '@ton/core'
import { Order, OrderExtra, OrderJetton, OrderStorage } from '../../contract/wrappers-ts/Order.gen'
import { initialOrderAddress, ORDER_CODE_HASH_B64 } from '../contracts/orderState'
import { acceptKeyOf, signInvite, INVITE_MAX_TTL } from '../contracts/invite'
import { handleInvite, MIN_GAP } from './inviteHandler'

const MARKET = Address.parse('0:' + 'aa'.repeat(32))
const ATTACKER = Address.parse('0:' + 'bb'.repeat(32))
const CLIENT = Address.parse('0:' + '33'.repeat(32))
const COURIER = '0:' + '44'.repeat(32)
const SEED = '5eed'.repeat(16)
const NOW = 1800000000
const text = (t) => beginCell().storeStringTail(t).endCell()

// An order's create-time fields and its stored state; `over` changes fields.
function orderOf(over = {}) {
  const f = {
    client: CLIENT,
    description: text('box'),
    area: text('Paris'),
    origin: text('All world'),
    reward: 10000000n,
    nonce: 1n,
    createdAt: 1700000000n,
    deliveryTime: 86400n,
    owner: Address.parse('0:' + '11'.repeat(32)),
    clientContact: text('@client'),
    secretHash: 7n,
    referral: null,
    acceptKey: acceptKeyOf(SEED),
    marketplace: MARKET,
    status: 0n,
    ...over,
  }
  const cell = OrderStorage.toCell(
    OrderStorage.create({
      client: f.client,
      courier: null,
      description: f.description,
      area: f.area,
      origin: f.origin,
      reward: f.reward,
      status: f.status,
      nonce: f.nonce,
      createdAt: f.createdAt,
      acceptedAt: 0n,
      deliveryTime: f.deliveryTime,
      extra: {
        ref: OrderExtra.create({
          owner: f.owner,
          clientContact: f.clientContact,
          courierContact: text(''),
          secretHash: f.secretHash,
          referral: f.referral,
          jetton: {
            ref: OrderJetton.create({
              marketplace: f.marketplace,
              wallet: Address.parse('0:' + '55'.repeat(32)),
              acceptKey: f.acceptKey,
            }),
          },
        }),
      },
    }),
  )
  // Genuine orders sit at the address of their initial state; a fake one at
  // wherever its own data puts it.
  const address = over.fake
    ? contractAddress(0, { code: Order.CodeCell, data: cell }).toRawString()
    : initialOrderAddress(f, f.marketplace).toRawString()
  const account = {
    address,
    status: 'active',
    code_hash: ORDER_CODE_HASH_B64,
    data_boc: cell.toBoc().toString('base64'),
  }
  return { address, account }
}

function memoryDb() {
  const rows = new Map()
  return {
    rows,
    async get(key) {
      return rows.get(key)?.row || null
    },
    async put(key, row, now, minGap) {
      const old = rows.get(key)
      if (old && old.at > now - minGap) return false
      rows.set(key, { row, at: now })
      return true
    },
  }
}

function call({ method = 'PUT', o, body, now = NOW, db, account, marketplace = MARKET }) {
  return handleInvite({
    method,
    orderParam: o.address,
    bodyText: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
    now,
    db,
    fetchAccount: async () => (account === undefined ? o.account : account),
    marketplace,
  })
}

const inviteFor = (o, courier = COURIER, validUntil = NOW + 3600, seed = SEED) => ({
  courier,
  validUntil,
  signature: signInvite(seed, o.address, courier, validUntil),
})

describe('invite mailbox', () => {
  it('stores the client invite and hands it back', async () => {
    const o = orderOf()
    const db = memoryDb()
    const inv = inviteFor(o)
    expect((await call({ o, db, body: inv })).status).toBe(204)
    const got = await call({ method: 'GET', o, db })
    expect(got.status).toBe(200)
    expect(JSON.parse(got.body)).toEqual(inv)
    // Any address form of the order reaches the same slot.
    const friendly = { ...o, address: Address.parse(o.address).toString({ urlSafe: true }) }
    expect((await call({ method: 'GET', o: friendly, db })).status).toBe(200)
  })

  it('refuses an invite not signed with the order key', async () => {
    const o = orderOf()
    const db = memoryDb()
    const forged = inviteFor(o, COURIER, NOW + 3600, 'ab'.repeat(32))
    expect((await call({ o, db, body: forged })).status).toBe(400)
    // A real signature with another courier written in.
    const swapped = { ...inviteFor(o), courier: '0:' + '66'.repeat(32) }
    expect((await call({ o, db, body: swapped })).status).toBe(400)
    expect(db.rows.size).toBe(0)
  })

  it('refuses a fake order and an order that is not Open', async () => {
    const db = memoryDb()
    for (const o of [
      orderOf({ marketplace: ATTACKER }),
      orderOf({ fake: true, reward: 999000000n }),
      orderOf({ status: 1n }),
    ]) {
      expect((await call({ o, db, body: inviteFor(o) })).status).toBe(400)
    }
    const o = orderOf()
    expect((await call({ o, db, body: inviteFor(o), account: null })).status).toBe(400)
    expect(
      (await call({ o, db, body: inviteFor(o), account: { ...o.account, code_hash: 'b3RoZXI=' } }))
        .status,
    ).toBe(400)
    expect(db.rows.size).toBe(0)
  })

  it('refuses a past or too long validUntil', async () => {
    const o = orderOf()
    const db = memoryDb()
    expect((await call({ o, db, body: inviteFor(o, COURIER, NOW) })).status).toBe(400)
    expect((await call({ o, db, body: inviteFor(o, COURIER, NOW + INVITE_MAX_TTL + 1) })).status).toBe(400)
    expect((await call({ o, db, body: inviteFor(o, COURIER, NOW + INVITE_MAX_TTL) })).status).toBe(204)
  })

  it('lets the client replace the invite, but not too often', async () => {
    const o = orderOf()
    const db = memoryDb()
    expect((await call({ o, db, body: inviteFor(o) })).status).toBe(204)
    const next = inviteFor(o, '0:' + '77'.repeat(32), NOW + 3700)
    expect((await call({ o, db, body: next, now: NOW + MIN_GAP - 1 })).status).toBe(429)
    expect((await call({ o, db, body: next, now: NOW + MIN_GAP })).status).toBe(204)
    const got = await call({ method: 'GET', o, db, now: NOW + MIN_GAP })
    expect(JSON.parse(got.body).courier).toBe(next.courier)
  })

  it('does not hand out an expired invite', async () => {
    const o = orderOf()
    const db = memoryDb()
    await call({ o, db, body: inviteFor(o, COURIER, NOW + 60) })
    expect((await call({ method: 'GET', o, db, now: NOW + 60 })).status).toBe(200)
    expect((await call({ method: 'GET', o, db, now: NOW + 61 })).status).toBe(404)
  })

  it('rejects junk requests', async () => {
    const o = orderOf()
    const db = memoryDb()
    expect((await call({ o, db, body: 'not json' })).status).toBe(400)
    expect((await call({ o, db, body: 'x'.repeat(2000) })).status).toBe(400)
    expect((await call({ o, db, body: { courier: 'nope', validUntil: NOW + 60, signature: 'a' } })).status).toBe(400)
    expect((await call({ method: 'POST', o, db, body: inviteFor(o) })).status).toBe(405)
    expect((await call({ o: { ...o, address: 'bad' }, db, body: inviteFor(o) })).status).toBe(400)
    expect((await call({ o, db, body: inviteFor(o), marketplace: null })).status).toBe(503)
    expect(db.rows.size).toBe(0)
  })
})
