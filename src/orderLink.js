// Share links to one order. The link is the mini-app link with
// ?startapp=sd_<order address>; Telegram hands that value to us as start_param,
// and at startup we open that order's page.
//
// start_param is also where a referral chat's wallet address comes in (see
// referral.js). The "sd_" prefix keeps the two apart: "_" never appears at that
// place in a friendly TON address, so Address.parse rejects an order link and
// captureReferral ignores it. Telegram allows only [A-Za-z0-9_-], up to 64
// chars, in start_param; "sd_" + a 48-char url-safe address fits.
//
// A courier's request to be let in (see invite.js) uses the same scheme:
// ?startapp=rq_<courier address>. The client opens it and picks which of their
// open orders the courier may accept.
import { Address } from '@ton/core'
import { getStartParam } from './telegram'
import { APP_LINK } from './referral'
import { navigate } from './router'

const PREFIX = 'sd_'
const REQUEST_PREFIX = 'rq_'

// The mini-app link that opens the order at `address` (any address form).
export function orderLink(address) {
  return APP_LINK + '?startapp=' + PREFIX + Address.parse(address).toString({ urlSafe: true })
}

// The order address from this launch's start_param, or null when the app was
// not opened through an order link (or the link is broken).
export function linkedOrder() {
  const raw = getStartParam()
  if (!raw || !raw.startsWith(PREFIX)) return null
  try {
    return Address.parse(raw.slice(PREFIX.length)).toString({ urlSafe: true })
  } catch {
    return null
  }
}

// The mini-app link a courier sends the client to ask for an invite.
export function requestLink(courier) {
  return APP_LINK + '?startapp=' + REQUEST_PREFIX + Address.parse(courier).toString({ urlSafe: true })
}

// The courier address from this launch's start_param, or null.
export function linkedRequest() {
  const raw = getStartParam()
  if (!raw || !raw.startsWith(REQUEST_PREFIX)) return null
  try {
    return Address.parse(raw.slice(REQUEST_PREFIX.length)).toString({ urlSafe: true })
  } catch {
    return null
  }
}

// Call once at startup: when the app was opened through an order link, go
// straight to that order; through a courier's request, to the page that lets
// the client invite them. A normal navigation, so "Back" leads to the feed.
export function openLinkedOrder() {
  const address = linkedOrder()
  if (address) return navigate('/order/' + encodeURIComponent(address))
  const courier = linkedRequest()
  if (courier) navigate('/allow/' + encodeURIComponent(courier))
}
