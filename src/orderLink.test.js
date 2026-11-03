// Tests for order share links. The link shares start_param with the referral
// link, so an order link must never be taken as a referral, and a referral link
// must never be taken as an order.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Address } from '@ton/core'
import { orderLink, linkedOrder, requestLink, linkedRequest, openLinkedOrder } from './orderLink'
import { captureReferral, getReferral, APP_LINK } from './referral'

// The start_param the next call sees.
const tg = vi.hoisted(() => ({ startParam: null }))
const nav = vi.hoisted(() => ({ to: null }))
vi.mock('./router', () => ({ navigate: (to) => (nav.to = to) }))
vi.mock('./telegram', () => ({
  getStartParam: () => tg.startParam,
  // No CloudStorage here: the referral capture then works on localStorage alone.
  cloudRead: async () => ({ ok: false }),
  cloudSet: async () => false,
  cloudRemove: async () => false,
}))

const order = Address.parseRaw('0:' + '07'.repeat(32))
// What Telegram hands back for a link: the part after ?startapp=
const paramOf = (link) => link.slice((APP_LINK + '?startapp=').length)

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  tg.startParam = null
  nav.to = null
})

describe('orderLink', () => {
  it('fits Telegram start_param rules', () => {
    const p = paramOf(orderLink(order.toRawString()))
    expect(p).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it('round-trips the order address from any address form', () => {
    for (const form of [order.toRawString(), order.toString({ bounceable: false })]) {
      tg.startParam = paramOf(orderLink(form))
      expect(Address.parse(linkedOrder()).equals(order)).toBe(true)
    }
  })
})

describe('linkedOrder', () => {
  it('is null without a start_param', () => {
    expect(linkedOrder()).toBeNull()
  })

  it('ignores a referral link', () => {
    tg.startParam = order.toString({ urlSafe: true, bounceable: false })
    expect(linkedOrder()).toBeNull()
  })

  it('ignores a broken order link', () => {
    tg.startParam = 'sd_not-an-address'
    expect(linkedOrder()).toBeNull()
  })
})

describe('captureReferral', () => {
  it('does not take an order link as a referral', async () => {
    tg.startParam = paramOf(orderLink(order.toRawString()))
    await captureReferral()
    expect(getReferral()).toBeNull()
  })
})

describe('courier request link', () => {
  const courier = Address.parseRaw('0:' + '0a'.repeat(32))

  it('fits Telegram start_param rules', () => {
    expect(paramOf(requestLink(courier.toRawString()))).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it('round-trips the courier and opens the allow page', () => {
    tg.startParam = paramOf(requestLink(courier.toRawString()))
    expect(Address.parse(linkedRequest()).equals(courier)).toBe(true)
    expect(linkedOrder()).toBeNull()
    openLinkedOrder()
    expect(nav.to.startsWith('/allow/')).toBe(true)
    expect(Address.parse(decodeURIComponent(nav.to.slice(7))).equals(courier)).toBe(true)
  })

  it('an order link still opens the order', () => {
    tg.startParam = paramOf(orderLink(order.toRawString()))
    expect(linkedRequest()).toBeNull()
    openLinkedOrder()
    expect(nav.to.startsWith('/order/')).toBe(true)
  })

  it('is not taken as a referral', async () => {
    tg.startParam = paramOf(requestLink(courier.toRawString()))
    await captureReferral()
    expect(getReferral()).toBeNull()
  })
})
