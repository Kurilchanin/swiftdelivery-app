// Tests for the delivery-secret storage: localStorage cache + Telegram
// CloudStorage backup. These two stores decide whether the client can still
// show the QR code weeks after creating an order, so the rules they follow are
// worth pinning down.
//
// src/telegram.js grabs window.Telegram.WebApp once, at module load time, so a
// fake CloudStorage must be installed BEFORE the module is imported. That is
// why every test re-imports the module dynamically after vi.resetModules().
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isTerminalStatus } from './orders'
import { NETWORK } from '../ton/network'

// A stand-in for Telegram CloudStorage, backed by a plain Map. It keeps the
// callback shape of the real SDK: fn(key, ..., (err, result) => {}).
const cloudData = new Map()
// How many of the next setItem calls must fail, so the retry can be tested.
let setFailures = 0
// When true, setItem answers "ok" but stores nothing — a write the read-back
// must catch.
let setLies = false
const fakeCloud = {
  getItem(key, cb) {
    cb(null, cloudData.has(key) ? cloudData.get(key) : '')
  },
  setItem(key, value, cb) {
    if (setFailures > 0) {
      setFailures -= 1
      return cb('failed')
    }
    if (setLies) return cb(null, true)
    cloudData.set(key, value)
    cb(null, true)
  },
  removeItem(key, cb) {
    cloudData.delete(key)
    cb(null, true)
  },
  getKeys(cb) {
    cb(null, [...cloudData.keys()])
  },
  getItems(keys, cb) {
    cb(null, Object.fromEntries(keys.map((k) => [k, cloudData.get(k) ?? ''])))
  },
}

// Two text forms of the same order address: raw (what the chain returns) and
// friendly (what TON Connect and the router use).
const RAW = '0:' + 'ab'.repeat(32)
const FRIENDLY = 'EQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq8Uk'
const WALLET = '0:' + '11'.repeat(32)
const SECRET = 'cd'.repeat(32)

// Load myOrders.js against a given window.Telegram value.
async function loadModule(telegram) {
  cloudData.clear()
  setFailures = 0
  setLies = false
  localStorage.clear()
  window.Telegram = telegram
  vi.resetModules()
  return import('./myOrders.js')
}

// The keys our backup wrote, ignoring anything else in the cloud.
function secretKeys() {
  return [...cloudData.keys()].filter((k) => k.startsWith('sp_sec_'))
}

describe('delivery secrets, with CloudStorage available', () => {
  let m
  beforeEach(async () => {
    m = await loadModule({ WebApp: { CloudStorage: fakeCloud } })
  })

  it('writes one cloud key that matches the documented Telegram format', async () => {
    await m.saveSecret(WALLET, RAW, SECRET)
    const keys = secretKeys()
    expect(keys).toHaveLength(1)
    // "0:<hex>" with the colon mapped to "_", because ":" is not allowed.
    expect(keys[0]).toBe('sp_sec_0_' + 'ab'.repeat(32))
    // Telegram limits: 1–128 chars from [A-Za-z0-9_-].
    expect(keys[0].length).toBeLessThanOrEqual(128)
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('stores the secret locally and in the cloud', async () => {
    await m.saveSecret(WALLET, RAW, SECRET)
    expect(m.getSecret(WALLET, RAW)).toBe(SECRET)
    expect(m.decodeCloudSecret(cloudData.get(secretKeys()[0])).hex).toBe(SECRET)
  })

  it('stamps the cloud copy with its network and write time', async () => {
    const before = Math.floor(Date.now() / 1000)
    await m.saveSecret(WALLET, RAW, SECRET)
    const meta = m.decodeCloudSecret(cloudData.get(secretKeys()[0]))
    expect(meta.network).toBe(NETWORK)
    expect(meta.createdAt).toBeGreaterThanOrEqual(before)
    // A value written before the stamp existed still reads as the bare secret.
    expect(m.decodeCloudSecret(SECRET)).toEqual({ hex: SECRET, network: null, createdAt: null })
  })

  it('recovers the secret on a new device and re-caches it locally', async () => {
    await m.saveSecret(WALLET, RAW, SECRET)
    localStorage.clear() // new device / cleared storage; the cloud still has it
    expect(m.getSecret(WALLET, RAW)).toBeNull()
    await expect(m.recoverSecret(WALLET, RAW)).resolves.toBe(SECRET)
    // The cloud hit is written back, so later reads are synchronous again.
    expect(m.getSecret(WALLET, RAW)).toBe(SECRET)
  })

  it('removes the secret from both stores', async () => {
    await m.saveSecret(WALLET, RAW, SECRET)
    m.removeSecret(RAW)
    expect(m.getSecret(WALLET, RAW)).toBeNull()
    expect(secretKeys()).toHaveLength(0)
  })

  it('returns null for an unknown address instead of throwing', async () => {
    await expect(m.recoverSecret(WALLET, RAW)).resolves.toBeNull()
  })

  it('reports the cloud backup and retries when a write fails', async () => {
    await expect(m.saveSecret(WALLET, RAW, SECRET)).resolves.toBe(true)

    localStorage.clear()
    cloudData.clear()
    setFailures = 2 // two writes fail, the third goes through
    await expect(m.saveSecret(WALLET, RAW, SECRET)).resolves.toBe(true)
    expect(secretKeys()).toHaveLength(1)

    localStorage.clear()
    cloudData.clear()
    setFailures = 3 // every try fails: this device holds the only copy
    await expect(m.saveSecret(WALLET, RAW, SECRET)).resolves.toBe(false)
    expect(secretKeys()).toHaveLength(0)
    expect(m.getSecret(WALLET, RAW)).toBe(SECRET) // the local copy still stands
  }, 10000)

  it('does not trust a write that says ok but did not store the code', async () => {
    setLies = true
    await expect(m.saveSecret(WALLET, RAW, SECRET)).resolves.toBe(false)
  }, 10000)

  it('puts a missing cloud copy back, and says so when it cannot', async () => {
    // Nothing to back up: this device does not have the code either.
    await expect(m.ensureCloudSecret(WALLET, RAW)).resolves.toBe(true)

    await m.saveSecret(WALLET, RAW, SECRET)
    cloudData.clear() // the backup never landed (old client, no network, …)
    await expect(m.ensureCloudSecret(WALLET, RAW)).resolves.toBe(true)
    expect(m.decodeCloudSecret(cloudData.get(secretKeys()[0])).hex).toBe(SECRET)

    cloudData.clear()
    setFailures = 3
    await expect(m.ensureCloudSecret(WALLET, RAW)).resolves.toBe(false)
  }, 10000)

  it('clears the code without being told which wallet holds it', async () => {
    // One Telegram user, two wallets: the cloud store is shared, and the startup
    // sweep runs before any wallet is connected. So a delete must find the local
    // entry on its own — and must not touch the other wallet's codes.
    const OTHER_WALLET = '0:' + '22'.repeat(32)
    const OTHER_RAW = '0:' + 'cc'.repeat(32)
    await m.saveSecret(WALLET, RAW, SECRET)
    await m.saveSecret(OTHER_WALLET, OTHER_RAW, SECRET)

    await m.removeSecret(RAW)
    expect(m.getSecret(WALLET, RAW)).toBeNull()
    expect(m.getSecret(OTHER_WALLET, OTHER_RAW)).toBe(SECRET)
    expect(secretKeys()).toEqual([m.secretCloudKey(OTHER_RAW)])
  })

  it('treats the raw and friendly address forms as the same order', async () => {
    await m.saveSecret(WALLET, FRIENDLY, SECRET)
    expect(secretKeys()).toHaveLength(1)
    expect(m.getSecret(WALLET, RAW)).toBe(SECRET)

    localStorage.clear()
    await expect(m.recoverSecret(WALLET, RAW)).resolves.toBe(SECRET)

    m.removeSecret(RAW)
    expect(secretKeys()).toHaveLength(0)
  })
})

// tracked() hands back plain address strings. The diagnostics screen once read
// them as objects, fed undefined into secretCloudKey and crashed the whole app
// to a black screen, so the shape is worth pinning down.
describe('tracked', () => {
  it('returns address strings, not objects', async () => {
    const m = await loadModule(undefined)
    m.track(WALLET, FRIENDLY, 'sent')
    const list = m.tracked(WALLET, 'sent')
    expect(list).toHaveLength(1)
    expect(typeof list[0]).toBe('string')
    expect(m.secretCloudKey(list[0])).toBe('sp_sec_0_' + 'ab'.repeat(32))
  })
})

describe('delivery secrets, without CloudStorage', () => {
  let m
  beforeEach(async () => {
    // Outside Telegram (a plain browser) there is no window.Telegram at all.
    m = await loadModule(undefined)
  })

  it('keeps working on localStorage alone and never throws', async () => {
    await expect(m.saveSecret(WALLET, RAW, SECRET)).resolves.toBe(false)
    expect(m.getSecret(WALLET, RAW)).toBe(SECRET)
    await expect(m.recoverSecret(WALLET, RAW)).resolves.toBe(SECRET)
    expect(() => m.removeSecret(RAW)).not.toThrow()
    expect(m.getSecret(WALLET, RAW)).toBeNull()
    // With no cloud copy, a cleared device simply has nothing to recover.
    await expect(m.recoverSecret(WALLET, RAW)).resolves.toBeNull()
  })
})

// isTerminalStatus guards every place that deletes a secret. In June 2026 a
// failed chain read deleted the code of a live order, so the rule is: delete
// only on a status we actually read and that is really terminal. Anything
// unknown must answer false.
describe('isTerminalStatus', () => {
  it('is false for unknown or still-active states', () => {
    for (const s of [undefined, null, '', 'Unknown', 'Open', 'Accepted']) {
      expect(isTerminalStatus(s)).toBe(false)
    }
  })

  it('is true for closed states', () => {
    for (const s of ['Completed', 'Cancelled', 'Expired']) {
      expect(isTerminalStatus(s)).toBe(true)
    }
  })
})

// ─── cloud cleanup ───────────────────────────────────────────────────────────
//
// A delivery code must disappear from the cloud once its order is over, and must
// NEVER disappear while the order can still be delivered. The cleanup asks
// toncenter about every stored code, so these tests fake that one response and
// check what each answer does to the stored key.
describe('cloud cleanup (reviewCloudSecrets / sweepCloudSecrets)', () => {
  let m
  let core
  let gen

  // Fake one /accountStates response. `accounts` is what toncenter would return
  // for the addresses asked about; anything not listed is an address the chain
  // has never heard of.
  // `txs` is what /transactions returns for any address; null makes that
  // endpoint fail.
  function answerWith(accounts, txs = []) {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/transactions')) {
        return txs === null ? { ok: false } : { ok: true, json: async () => ({ transactions: txs }) }
      }
      return { ok: true, json: async () => ({ accounts }) }
    })
  }

  // Overwrite the stored cloud value, as if it was written `ageS` seconds ago.
  function storedAgo(ageS, network = NETWORK) {
    const at = Math.floor(Date.now() / 1000) - ageS
    cloudData.set(m.secretCloudKey(RAW), `${SECRET}.${network}.${at}`)
  }
  const DAY = 24 * 60 * 60

  // A live Order account, with the storage cell this build's parser expects.
  async function liveOrder(rawAddress, status) {
    const { beginCell, Address } = core
    const { Order, OrderStorage, OrderExtra, OrderJetton } = gen
    const text = (s) => beginCell().storeStringTail(s).endCell()
    const storage = OrderStorage.create({
      client: Address.parse(WALLET),
      courier: null,
      description: text('parcel'),
      area: text('Paris'),
      origin: text('All world'),
      reward: 1000000000n,
      status: BigInt(status),
      nonce: 1n,
      createdAt: 1n,
      acceptedAt: 0n,
      deliveryTime: 1209600n,
      extra: {
        ref: OrderExtra.create({
          owner: Address.parse(WALLET),
          clientContact: text(''),
          courierContact: text(''),
          secretHash: 1n,
          referral: null,
          jetton: {
            ref: OrderJetton.create({ marketplace: Address.parse(WALLET), wallet: null }),
          },
        }),
      },
    })
    return {
      address: rawAddress,
      status: 'active',
      code_hash: Order.CodeCell.hash().toString('base64'),
      data_boc: OrderStorage.toCell(storage).toBoc().toString('base64'),
    }
  }

  beforeEach(async () => {
    m = await loadModule({ WebApp: { CloudStorage: fakeCloud } })
    core = await import('@ton/core')
    gen = await import('../../contract/wrappers-ts/Order.gen')
    await m.saveSecret(WALLET, RAW, SECRET)
    expect(secretKeys()).toHaveLength(1)
  })

  it('deletes the code of an order that settled and destroyed itself', async () => {
    answerWith([{ address: RAW, status: 'nonexist' }])
    await expect(m.sweepCloudSecrets()).resolves.toBe(1)
    expect(secretKeys()).toHaveLength(0)
    expect(m.getSecret(WALLET, RAW)).toBeNull()
  })

  it('deletes the code of an order that is still there but already closed', async () => {
    answerWith([await liveOrder(RAW, 2)]) // 2 = Completed
    await expect(m.sweepCloudSecrets()).resolves.toBe(1)
    expect(secretKeys()).toHaveLength(0)
  })

  it('keeps the code of an order that is still open', async () => {
    answerWith([await liveOrder(RAW, 0)]) // 0 = Open
    await expect(m.sweepCloudSecrets()).resolves.toBe(0)
    expect(secretKeys()).toHaveLength(1)
  })

  it('keeps the code when the chain does not answer', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(m.sweepCloudSecrets()).resolves.toBe(0)
    expect(secretKeys()).toHaveLength(1)
    expect(m.getSecret(WALLET, RAW)).toBe(SECRET)
  })

  it('keeps two wallets of one Telegram user apart', async () => {
    // The cloud store is per Telegram user, so both wallets write into it. Each
    // order has its own address, so each code has its own key: closing one
    // order must clear exactly that code and leave the other wallet's alone.
    const WALLET_B = '0:' + '22'.repeat(32)
    const ORDER_B = '0:' + 'cc'.repeat(32)
    await m.saveSecret(WALLET_B, ORDER_B, SECRET)
    expect(secretKeys()).toHaveLength(2)

    // Wallet A's order settled and destroyed itself; wallet B's is still open.
    answerWith([{ address: RAW, status: 'nonexist' }, await liveOrder(ORDER_B, 0)])
    await expect(m.sweepCloudSecrets()).resolves.toBe(1)

    expect(secretKeys()).toEqual([m.secretCloudKey(ORDER_B)])
    expect(m.getSecret(WALLET_B, ORDER_B)).toBe(SECRET)
    expect(m.getSecret(WALLET, RAW)).toBeNull()
    // And wallet B's code still comes back on a device that lost localStorage.
    localStorage.clear()
    await expect(m.recoverSecret(WALLET_B, ORDER_B)).resolves.toBe(SECRET)
  })

  it('never deletes on its own an address where no order was ever deployed', async () => {
    answerWith([]) // the chain answered, and knows nothing about this address
    await expect(m.sweepCloudSecrets()).resolves.toBe(0)
    expect(secretKeys()).toHaveLength(1)
    // The diagnostics screen still gets a clear verdict, so it can be deleted by hand.
    const rows = await m.reviewCloudSecrets()
    expect(rows).toHaveLength(1)
    expect(rows[0].verdict).toBe('never on chain')
    expect(rows[0].junk).toBe(false)
  })
  it('deletes the code of a create that never landed, once it is over a day old', async () => {
    storedAgo(DAY + 60)
    answerWith([], []) // no account, and not one transaction ever
    await expect(m.sweepCloudSecrets()).resolves.toBe(1)
    expect(secretKeys()).toHaveLength(0)
  })

  it('keeps a fresh code with no order yet: the create may still be landing', async () => {
    storedAgo(10 * 60)
    answerWith([], [])
    await expect(m.sweepCloudSecrets()).resolves.toBe(0)
    expect(secretKeys()).toHaveLength(1)
  })

  it('keeps an old code when the address has any transaction', async () => {
    storedAgo(DAY + 60)
    answerWith([], [{ hash: 'x' }]) // /accountStates missed it, but the chain saw it
    await expect(m.sweepCloudSecrets()).resolves.toBe(0)
    expect(secretKeys()).toHaveLength(1)
  })

  it('keeps an old code when the transaction check cannot answer', async () => {
    storedAgo(DAY + 60)
    answerWith([], null)
    await expect(m.sweepCloudSecrets()).resolves.toBe(0)
    expect(secretKeys()).toHaveLength(1)
  })

  it('keeps an old code written by a build of the other network', async () => {
    storedAgo(DAY + 60, NETWORK === 'mainnet' ? 'testnet' : 'mainnet')
    answerWith([], [])
    await expect(m.sweepCloudSecrets()).resolves.toBe(0)
    expect(secretKeys()).toHaveLength(1)
  })

  it('keeps an old-format code with no write time', async () => {
    cloudData.set(m.secretCloudKey(RAW), SECRET)
    answerWith([], [])
    await expect(m.sweepCloudSecrets()).resolves.toBe(0)
    expect(secretKeys()).toHaveLength(1)
  })
})
