// The CSP counter on the /debug screen is what decides when the policy may be
// switched from Report-Only to enforcing, so what it records must be right.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { watchCspViolations, readCspViolations, clearCspViolations } from './cspReport'

// jsdom has no SecurityPolicyViolationEvent; a plain event with its fields works
// the same for a listener.
function violate(fields) {
  document.dispatchEvent(Object.assign(new Event('securitypolicyviolation'), fields))
}

beforeAll(() => watchCspViolations())
beforeEach(() => clearCspViolations())

describe('CSP violation counter', () => {
  it('records the directive, the blocked URL and the source', () => {
    violate({
      effectiveDirective: 'connect-src',
      blockedURI: 'http://example.com/x',
      sourceFile: 'https://swiftdelivery.pages.dev/assets/index.js',
    })
    const [v] = readCspViolations()
    expect(v.directive).toBe('connect-src')
    expect(v.blocked).toBe('http://example.com/x')
    expect(v.source).toBe('https://swiftdelivery.pages.dev/assets/index.js')
    expect(typeof v.at).toBe('number')
  })

  it('keeps at most 50, so a loop cannot fill the storage', () => {
    for (let i = 0; i < 70; i++) violate({ effectiveDirective: 'img-src', blockedURI: 'x' + i })
    expect(readCspViolations()).toHaveLength(50)
  })

  it('clear empties it', () => {
    violate({ effectiveDirective: 'script-src', blockedURI: 'inline' })
    clearCspViolations()
    expect(readCspViolations()).toEqual([])
  })

  it('a broken stored value reads as no violations', () => {
    localStorage.setItem('sd_csp_violations', '{not json')
    expect(readCspViolations()).toEqual([])
  })
})
