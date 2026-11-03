// Telegram contact sharing between the two parties of an order.
//
// When a courier accepts an order, both sides should be able to message each
// other on Telegram. There is no backend, so the only channel between the two
// phones is the chain: each side's contact travels inside the order (client's
// at create time, courier's at accept time) and is read back by the other side.
//
// What we put on-chain is PUBLIC and PERMANENT, so we carry only Telegram's own
// shareable identifiers — @username, numeric id, first name — never a phone or
// the exact street address. A chat link can only be built from a @username
// (Telegram does not let you open a chat by numeric id without a bot); the id
// is stored as a forward-looking hook for a future notification bot.

import { getUser } from './telegram'
import { sanitizeText } from './utils/security'

// Telegram usernames are 5-32 chars of [A-Za-z0-9_]. We validate strictly
// before building any t.me link so a malformed handle can never inject a path.
const USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/

// Read the current user's Telegram contact from initData. Returns a plain
// object; any field may be empty when run outside Telegram or with no username.
export function getMyContact() {
  const u = getUser()
  if (!u) return { username: '', id: '', firstName: '' }
  const username = typeof u.username === 'string' && USERNAME_RE.test(u.username) ? u.username : ''
  return {
    username,
    id: u.id != null ? String(u.id).slice(0, 20) : '',
    firstName: sanitizeText(u.first_name || '', 64),
  }
}

// Pack a contact into a compact JSON string for on-chain storage. Empty fields
// are dropped. Returns '' when there is nothing useful to store.
export function packContact(c) {
  if (!c) return ''
  const out = {}
  if (c.username) out.u = c.username
  if (c.id) out.i = c.id
  if (c.firstName) out.n = c.firstName
  return Object.keys(out).length ? JSON.stringify(out) : ''
}

// Parse a packed contact string back into an object. Tolerant: returns a fully
// empty contact on any malformed input.
export function parseContact(str) {
  const empty = { username: '', id: '', firstName: '' }
  if (!str || typeof str !== 'string') return empty
  try {
    const o = JSON.parse(str)
    const username = typeof o.u === 'string' && USERNAME_RE.test(o.u) ? o.u : ''
    return {
      username,
      id: typeof o.i === 'string' ? o.i.slice(0, 20) : '',
      firstName: sanitizeText(o.n || '', 64),
    }
  } catch {
    return empty
  }
}

// Build a t.me chat link for a contact, or null when no usable @username.
export function telegramLink(c) {
  return c && USERNAME_RE.test(c.username || '') ? 'https://t.me/' + c.username : null
}

// True when the current user has a usable Telegram @username.
export function hasTelegramUsername() {
  return Boolean(telegramLink(getMyContact()))
}

export const REQUIRE_TG_USERNAME = true

// Whether the @username requirement is satisfied. Always true while the
// requirement is disabled for local dev (see REQUIRE_TG_USERNAME).
export function usernameRequirementMet() {
  return !REQUIRE_TG_USERNAME || hasTelegramUsername()
}

// A short human label for a contact: "@handle", or the first name, or ''.
export function contactLabel(c) {
  if (!c) return ''
  if (c.username) return '@' + c.username
  return c.firstName || ''
}
