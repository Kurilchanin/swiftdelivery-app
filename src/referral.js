// Referral capture. A partner Telegram chat shares the mini app as
// t.me/<bot>/<app>?startapp=<TON-address of the chat's wallet>; Telegram hands
// that value to us as start_param. If it parses as a TON address it becomes this
// user's referral FOREVER, and only the FIRST one counts: a later link of another
// referral changes nothing (owner decision 2026-10-09). Every order the user
// creates carries it on-chain (OrderExtra.referral) and the Order contract itself
// pays that address half of the fee pool when the order settles.
//
// The binding is one record {a: raw address, t: capture time in seconds}, kept
// in localStorage (the fast, synchronous read) and in Telegram CloudStorage (the
// copy shared by all the user's devices). `t` only decides which record is first
// when two devices wrote different ones while the cloud was unreachable.
//
// Address.parse accepts every text form — bounceable (EQ/kQ), non-bounceable
// (UQ/0Q) and raw — and they all decode to the same workchain+hash, so a chat
// admin can paste their address in whatever form their wallet shows. Anything
// that is not a TON address is silently ignored: garbage in the link must
// never break order creation.
//
// Only basechain (workchain 0) addresses are kept. The text forms can carry ANY
// workchain number, but only 0 and -1 exist, and every terminal path of the
// Order contract pays the referral without IGNORE_ERRORS. A payout to a missing
// workchain fails the whole transaction, so such an order can never close and
// its USDT is locked forever. Wallets always give basechain addresses, so this
// costs a real partner nothing.
import { Address } from '@ton/core'
import { getStartParam, cloudRead, cloudSet, cloudRemove } from './telegram'

// The same key in localStorage, CloudStorage, and (before this version)
// sessionStorage. It fits the cloud's key rules ([A-Za-z0-9_-]).
const KEY = 'sd_referral'
// How long creating an order waits for the startup cloud read (see referralReady).
const CLOUD_WAIT_MS = 1500

// The referral as an Address when it is a basechain address, else null.
function basechainOnly(raw) {
  const a = Address.parse(String(raw).trim())
  return a.workChain === 0 ? a : null
}

// True when an order's referral makes it impossible to settle: an address in a
// workchain the chain does not have (anything but 0 and -1). The Feed hides such
// orders and OrderDetail refuses to accept them.
export function referralLocksOrder(referral) {
  return referral != null && referral.workChain !== 0 && referral.workChain !== -1
}

// A stored record as { a: raw address, t: seconds }, or null when it is missing,
// not JSON, or not a basechain address (such a record must never reach an order).
function parseRecord(text) {
  if (!text) return null
  try {
    const r = JSON.parse(text)
    if (typeof r?.a !== 'string' || !Number.isFinite(r.t)) return null
    const a = basechainOnly(r.a)
    return a ? { a: a.toRawString(), t: r.t } : null
  } catch {
    return null
  }
}

const recordText = (r) => JSON.stringify({ a: r.a, t: r.t })
const sameRecord = (x, y) => Boolean(x && y && x.a === y.a && x.t === y.t)

// The localStorage record. A broken one is removed, so the next valid link can
// become the first.
function readLocal() {
  try {
    const text = localStorage.getItem(KEY)
    const r = parseRecord(text)
    if (text && !r) localStorage.removeItem(KEY)
    return r
  } catch {
    return null
  }
}

function writeLocal(r) {
  try {
    localStorage.setItem(KEY, recordText(r))
  } catch {
    // storage unavailable — the cloud copy (if any) still keeps the binding
  }
}

// This launch's referral link as a raw basechain address, or null. Also picks
// up a referral an older version left in sessionStorage (the user opened the
// app through a link in that version and the session is still open), once.
function linkReferral() {
  let found = null
  const raw = getStartParam()
  if (raw) {
    try {
      found = basechainOnly(raw)
    } catch {
      // not a TON address (an order link, garbage) — no referral in this link
    }
  }
  try {
    const old = sessionStorage.getItem(KEY)
    if (old) {
      sessionStorage.removeItem(KEY)
      if (!found) found = basechainOnly(old)
    }
  } catch {
    // storage unavailable or not an address — nothing to move
  }
  return found ? found.toRawString() : null
}

// Settled when the startup capture has finished (see captureReferral).
let ready = Promise.resolve()

// Call once at startup. The order matters: the cloud is read FIRST, then the
// link. On a new device localStorage is empty, so taking the link first would
// let a second referral's link replace the first one.
//   1. A record in the cloud or locally → it stays, whatever the link says. If
//      the two differ, the earlier one wins and is written to both.
//   2. No record anywhere → this launch's valid link (if any) becomes the one.
//   3. The cloud could not answer → decide by localStorage alone and leave the
//      cloud alone; it is filled on a later launch where it answers empty.
// Returns the promise referralReady waits for.
export function captureReferral() {
  ready = (async () => {
    const fromLink = linkReferral()
    const local = readLocal()
    const read = await cloudRead(KEY)
    const cloud = read.ok ? parseRecord(read.value) : null
    if (read.ok && read.value && !cloud) await cloudRemove(KEY) // broken record

    let first = local && cloud ? (cloud.t < local.t ? cloud : local) : local || cloud
    if (!first && fromLink) first = { a: fromLink, t: Math.floor(Date.now() / 1000) }
    if (!first) return

    if (!sameRecord(local, first)) writeLocal(first)
    if (read.ok && !sameRecord(cloud, first)) await cloudSet(KEY, recordText(first))
  })().catch(() => {
    // a failed capture must never break the app or order creation
  })
  return ready
}

// Wait for the startup capture, but not longer than CLOUD_WAIT_MS: the cloud
// answers through a callback, and an order created in the first seconds after
// launch must still carry the right referral. A cloud that is too slow is not
// waited for; the order then goes with the localStorage value.
export function referralReady() {
  return Promise.race([ready, new Promise((r) => setTimeout(r, CLOUD_WAIT_MS))])
}

// Base link of the mini app. Overridable per deployment; the default is the
// production bot.
export const APP_LINK = import.meta.env.VITE_MINIAPP_URL || 'https://t.me/SwiftDelivery_bot/app'

// The mini-app link that credits `friendlyAddr` (a TON Connect user-friendly
// address, already base64url) as the referral. Anyone opening the app through
// it creates orders that pay this address half of the fee pool.
export function referralLink(friendlyAddr) {
  return APP_LINK + '?startapp=' + friendlyAddr
}

// The user's referral as an Address, or null. Synchronous: reads localStorage,
// which captureReferral keeps in line with the cloud copy.
export function getReferral() {
  const r = readLocal()
  return r ? Address.parseRaw(r.a) : null
}
