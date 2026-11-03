// Pack / unpack of the stored code: the delivery code and the invite seed live
// in one value (see packCode in myOrders.js), and a fresh seed gives a key the
// invite check accepts.
import { describe, it, expect } from 'vitest'
import { packCode, deliveryCodeOf, inviteSeedOf } from './myOrders'
import { newInviteSeed, acceptKeyOf, signInvite, verifyInvite } from './invite'

const ORDER = '0:' + '01'.repeat(32)
const COURIER = '0:' + '02'.repeat(32)

describe('stored code', () => {
  it('keeps the delivery code and the invite seed apart', () => {
    const code = 'ab'.repeat(32)
    const seed = newInviteSeed()
    const stored = packCode(code, seed)
    expect(deliveryCodeOf(stored)).toBe(code)
    expect(inviteSeedOf(stored)).toBe(seed)
  })

  it('reads a value with no seed', () => {
    expect(deliveryCodeOf('cd'.repeat(32))).toBe('cd'.repeat(32))
    expect(inviteSeedOf('cd'.repeat(32))).toBeNull()
    expect(deliveryCodeOf(null)).toBeNull()
    expect(inviteSeedOf(null)).toBeNull()
  })
})

describe('invite key', () => {
  it('a fresh seed signs invites its own key accepts, and no other key', () => {
    const seed = newInviteSeed()
    expect(seed).toMatch(/^[0-9a-f]{64}$/)
    const signature = signInvite(seed, ORDER, COURIER, 1700000000)
    const inv = { order: ORDER, courier: COURIER, validUntil: 1700000000, signature }
    expect(verifyInvite(inv, acceptKeyOf(seed))).toBe(true)
    expect(verifyInvite(inv, acceptKeyOf(newInviteSeed()))).toBe(false)
  })
})
