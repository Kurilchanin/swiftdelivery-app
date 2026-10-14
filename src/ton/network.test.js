// Tests for displayAddr: one wallet or contract must show as one string,
// whatever text form it came in.
import { describe, it, expect } from 'vitest'
import { Address } from '@ton/core'
import { displayAddr, IS_TESTNET } from './network'

const a = Address.parseRaw('0:' + '07'.repeat(32))
const forms = [
  a.toRawString(),
  a.toString({ bounceable: true }),
  a.toString({ bounceable: false, testOnly: true }),
  a,
]

describe('displayAddr', () => {
  it('shows a wallet non-bounceable, flagged for our network', () => {
    for (const f of forms) {
      const p = Address.parseFriendly(displayAddr(f, 'wallet'))
      expect(p.isBounceable).toBe(false)
      expect(p.isTestOnly).toBe(IS_TESTNET)
      expect(p.address.equals(a)).toBe(true)
    }
    expect(displayAddr(forms[0], 'wallet')).toMatch(IS_TESTNET ? /^0Q/ : /^UQ/)
  })

  it('shows a contract bounceable, flagged for our network', () => {
    for (const f of forms) {
      expect(displayAddr(f, 'contract')).toBe(displayAddr(forms[0], 'contract'))
    }
    expect(displayAddr(forms[0], 'contract')).toMatch(IS_TESTNET ? /^kQ/ : /^EQ/)
  })

  it('leaves text that is not an address as it is', () => {
    expect(displayAddr('', 'wallet')).toBe('')
    expect(displayAddr(null, 'wallet')).toBe('')
    expect(displayAddr('nope', 'contract')).toBe('nope')
  })
})
