// Tests for referral capture. The referral goes into every order's init data and
// the Order contract pays it on every terminal path WITHOUT ignoring errors. A
// referral in a workchain that does not exist makes those payouts fail, so the
// order can never close and its USDT is locked forever (proven in the contract
// emulator). A crafted mini-app link must therefore never get such an address in.
//
// The binding is kept forever and the FIRST referral wins, in localStorage and
// in Telegram CloudStorage (mocked below as a plain map).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Address } from '@ton/core'
import { captureReferral, getReferral, referralReady, referralLocksOrder } from './referral'
import { reviewCloudSecrets } from './contracts/myOrders'

// The start_param the next captureReferral() sees, and a fake CloudStorage.
// `cloud.up = false` is a client without CloudStorage (or one that errors).
const tg = vi.hoisted(() => ({ startParam: null }))
const cloud = vi.hoisted(() => ({ up: true, store: new Map(), delay: 0 }))
vi.mock('./telegram', async (importOriginal) => {
  const later = (v) => new Promise((r) => setTimeout(() => r(v), cloud.delay))
  return {
    ...(await importOriginal()),
    getStartParam: () => tg.startParam,
    cloudRead: (k) => later(cloud.up ? { ok: true, value: cloud.store.get(k) ?? null } : { ok: false }),
    cloudGet: (k) => later(cloud.up ? (cloud.store.get(k) ?? null) : null),
    cloudSet: (k, v) => later(cloud.up ? (cloud.store.set(k, v), true) : false),
    cloudRemove: (k) => later(cloud.up ? (cloud.store.delete(k), true) : false),
    cloudGetKeys: () => later(cloud.up ? [...cloud.store.keys()] : null),
  }
})

const inWorkchain = (wc, byte = '07') => Address.parseRaw(wc + ':' + byte.repeat(32))
// The form a link carries: friendly, url-safe, non-bounceable (UQ…).
const link = (wc, byte) => inWorkchain(wc, byte).toString({ urlSafe: true, bounceable: false })
const A = inWorkchain(0, '0a')
const B = inWorkchain(0, '0b')
const record = (addr, t) => JSON.stringify({ a: addr.toRawString(), t })
const stored = (text) => (text ? JSON.parse(text).a : null)

// One app launch: a fresh start_param, then the capture runs to the end.
async function launch(startParam = null) {
  tg.startParam = startParam
  await captureReferral()
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  tg.startParam = null
  cloud.up = true
  cloud.store.clear()
  cloud.delay = 0
})

describe('captureReferral', () => {
  it('keeps a basechain address, locally and in the cloud', async () => {
    await launch(link(0, '0a'))
    expect(getReferral().equals(A)).toBe(true)
    expect(stored(localStorage.getItem('sd_referral'))).toBe(A.toRawString())
    expect(stored(cloud.store.get('sd_referral'))).toBe(A.toRawString())
  })

  it('survives a restart: a later launch without a link keeps it', async () => {
    await launch(link(0, '0a'))
    sessionStorage.clear()
    await launch(null)
    expect(getReferral().equals(A)).toBe(true)
  })

  it('the first referral wins: a later link of another one changes nothing', async () => {
    await launch(link(0, '0a'))
    await launch(link(0, '0b'))
    expect(getReferral().equals(A)).toBe(true)
    expect(stored(cloud.store.get('sd_referral'))).toBe(A.toRawString())
  })

  it('a new device takes the cloud referral, not its own first link', async () => {
    cloud.store.set('sd_referral', record(A, 100))
    await launch(link(0, '0b'))
    expect(getReferral().equals(A)).toBe(true)
    expect(stored(cloud.store.get('sd_referral'))).toBe(A.toRawString())
  })

  it('when the device and the cloud disagree, the earlier record wins in both', async () => {
    localStorage.setItem('sd_referral', record(B, 200))
    cloud.store.set('sd_referral', record(A, 100))
    await launch(null)
    expect(getReferral().equals(A)).toBe(true)
    expect(stored(localStorage.getItem('sd_referral'))).toBe(A.toRawString())

    localStorage.setItem('sd_referral', record(A, 100))
    cloud.store.set('sd_referral', record(B, 200))
    await launch(null)
    expect(stored(cloud.store.get('sd_referral'))).toBe(A.toRawString())
  })

  it('fills an empty cloud from the device', async () => {
    localStorage.setItem('sd_referral', record(A, 100))
    await launch(null)
    expect(stored(cloud.store.get('sd_referral'))).toBe(A.toRawString())
  })

  it('without CloudStorage works on localStorage alone', async () => {
    cloud.up = false
    await launch(link(0, '0a'))
    expect(getReferral().equals(A)).toBe(true)
    await launch(link(0, '0b'))
    expect(getReferral().equals(A)).toBe(true)
  })

  it('a cloud that cannot answer is never overwritten', async () => {
    cloud.store.set('sd_referral', record(A, 100))
    cloud.up = false
    await launch(link(0, '0b')) // new device, cloud unreachable: B for now
    cloud.up = true
    expect(stored(cloud.store.get('sd_referral'))).toBe(A.toRawString())
    await launch(null) // the cloud answers: the earlier A wins everywhere
    expect(getReferral().equals(A)).toBe(true)
  })

  it('refuses an address in a workchain that does not exist', async () => {
    // The exact string from the audit: valid base64 and checksum, workchain 1.
    const wc1 = 'UQEHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBxJ4'
    expect(Address.parse(wc1).workChain).toBe(1)
    await launch(wc1)
    expect(getReferral()).toBeNull()
    expect(cloud.store.has('sd_referral')).toBe(false)
  })

  it('refuses a masterchain address too — partners use basechain wallets', async () => {
    await launch(link(-1))
    expect(getReferral()).toBeNull()
    expect(cloud.store.has('sd_referral')).toBe(false)
  })

  it('ignores garbage', async () => {
    await launch('not-an-address')
    expect(getReferral()).toBeNull()
  })

  it('a bad link later keeps the good referral', async () => {
    await launch(link(0, '0a'))
    await launch(link(1))
    expect(getReferral().equals(A)).toBe(true)
  })

  it('moves a referral an older version left in sessionStorage', async () => {
    sessionStorage.setItem('sd_referral', A.toRawString())
    await launch(null)
    expect(getReferral().equals(A)).toBe(true)
    expect(sessionStorage.getItem('sd_referral')).toBeNull()
  })
})

describe('getReferral', () => {
  it('drops a bad address already in storage, so the next link can be first', async () => {
    localStorage.setItem('sd_referral', record(inWorkchain(1), 100))
    cloud.store.set('sd_referral', record(inWorkchain(1), 100))
    expect(getReferral()).toBeNull()
    expect(localStorage.getItem('sd_referral')).toBeNull()
    await launch(link(0, '0b'))
    expect(getReferral().equals(B)).toBe(true)
    expect(stored(cloud.store.get('sd_referral'))).toBe(B.toRawString())
  })

  it('drops a record that is not JSON', () => {
    localStorage.setItem('sd_referral', A.toRawString())
    expect(getReferral()).toBeNull()
  })
})

describe('referralReady', () => {
  it('waits for a slow-but-in-time cloud', async () => {
    cloud.store.set('sd_referral', record(A, 100))
    cloud.delay = 50
    tg.startParam = null
    captureReferral()
    expect(getReferral()).toBeNull() // the cloud has not answered yet
    await referralReady()
    expect(getReferral().equals(A)).toBe(true)
  })

  it('gives up on a cloud that is too slow', async () => {
    vi.useFakeTimers()
    try {
      cloud.delay = 60_000
      captureReferral()
      const done = vi.fn()
      referralReady().then(done)
      await vi.advanceTimersByTimeAsync(1600)
      expect(done).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the delivery-code cloud review', () => {
  it('never sees the referral key', async () => {
    await launch(link(0, '0a'))
    expect(cloud.store.has('sd_referral')).toBe(true)
    expect(await reviewCloudSecrets()).toEqual([])
  })
})

describe('referralLocksOrder', () => {
  it('only a missing workchain locks an order', () => {
    expect(referralLocksOrder(null)).toBe(false)
    expect(referralLocksOrder(inWorkchain(0))).toBe(false)
    expect(referralLocksOrder(inWorkchain(-1))).toBe(false) // exists, payout works
    expect(referralLocksOrder(inWorkchain(1))).toBe(true)
    expect(referralLocksOrder(inWorkchain(-2))).toBe(true)
  })
})
