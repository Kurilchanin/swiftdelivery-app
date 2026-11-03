// Small security helpers. Keep this file tiny.
// Budget: Phase 1 + Phase 2 security code stays under 200 lines total.

// Clean user text before we show or store it.
// Strips control characters and trims to a max length.
export function sanitizeText(s, max = 500) {
  if (typeof s !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max)
}

// Allow only http/https links. Returns a safe URL string, or null.
export function assertHttpUrl(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return null
  }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
}

// Show a long TON address in a short form: UQAb12…7x9Q. Pass it through
// displayAddr (ton/network.js) first, so the form is the same everywhere.
export function shortAddr(addr) {
  if (typeof addr !== 'string' || addr.length <= 12) return addr || ''
  return addr.slice(0, 6) + '…' + addr.slice(-4)
}
