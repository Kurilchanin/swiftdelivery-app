// CSP check without DevTools. The app is used inside the Telegram apps, where no
// browser console is at hand, so every Content-Security-Policy violation is kept
// on this device and listed on the hidden /debug screen. The policy is enforced
// (public/_headers), so each one is something the browser blocked.
const KEY = 'sd_csp_violations'
const MAX = 50 // enough to see what would break; a loop cannot fill the storage

export function readCspViolations() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function clearCspViolations() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // storage unavailable
  }
}

// Call once, as early as possible: a violation that happens before this runs is
// not seen (only the page's own first loads come before it).
export function watchCspViolations() {
  document.addEventListener('securitypolicyviolation', (e) => {
    const list = readCspViolations()
    if (list.length >= MAX) return
    list.push({
      at: Date.now(),
      directive: e.effectiveDirective || e.violatedDirective || '',
      blocked: String(e.blockedURI || '').slice(0, 200),
      source: String(e.sourceFile || '').slice(0, 200),
    })
    try {
      localStorage.setItem(KEY, JSON.stringify(list))
    } catch {
      // storage unavailable
    }
  })
}
