// Tracks the order addresses this user has touched, in localStorage, keyed by
// wallet address. We need this because the chain has no "orders by user" index.
//   role: 'sent'  — orders this wallet created
//   role: 'taken' — orders this wallet accepted as a courier
//
// History: completed/cancelled orders are saved as full snapshots, so the
// History tab does not depend on a chain read (it can fail, and orders of an
// older Marketplace run a different Order code that the app does not read).
import { Address } from '@ton/core'
import { MARKETPLACE_TAG, NETWORK } from '../ton/network'
import { cloudGet, cloudRead, cloudSet, cloudRemove, cloudGetKeys, cloudGetItems } from '../telegram'
import { classifyOrderAddresses, hasAnyTransaction } from './orders'

// All of these are scoped to the active Marketplace (see MARKETPLACE_TAG): when
// the Marketplace is redeployed the keys change, so orders, history, snapshots
// and secrets from another deploy never surface.
const BASE_KEYS = {
  orders:    'swiftparcel.myorders',
  history:   'swiftparcel.history',
  snapshots: 'swiftparcel.snapshots',
  secrets:   'swiftparcel.secrets',
  feed:      'swiftparcel.feed',
}
const ns           = (base) => `${base}.${MARKETPLACE_TAG}`
const KEY          = ns(BASE_KEYS.orders)
const HISTORY_KEY  = ns(BASE_KEYS.history)
const SNAPSHOT_KEY = ns(BASE_KEYS.snapshots)
const SECRETS_KEY  = ns(BASE_KEYS.secrets)

// Normalize any address string to raw 0:... format for consistent comparison.
// Toncenter returns raw; TON Connect and the router use kQ.../EQ... — they all
// point to the same contract but fail a plain string equality check.
function normalizeAddr(addr) {
  try { return Address.parse(addr).toRawString() } catch { return addr }
}

function readAll(storageKey) {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || '{}')
  } catch {
    return {}
  }
}

function writeAll(storageKey, obj) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(obj))
  } catch {
    // ignore quota / private-mode errors
  }
}

// ─── active order address tracking ──────────────────────────────────────────

// Remember an order address for a wallet under a role.
export function track(wallet, address, role) {
  if (!wallet || !address) return
  const norm = normalizeAddr(address)
  const all = readAll(KEY)
  const list = all[wallet] || []
  if (!list.some((e) => normalizeAddr(e.address) === norm && e.role === role)) {
    list.push({ address: norm, role })
    all[wallet] = list
    writeAll(KEY, all)
  }
}

// Forget an order address for a wallet. Optionally limit to one role.
export function untrack(wallet, address, role) {
  if (!wallet || !address) return
  const norm = normalizeAddr(address)
  const all = readAll(KEY)
  const list = all[wallet]
  if (!list) return
  all[wallet] = list.filter(
    (e) => !(normalizeAddr(e.address) === norm && (!role || e.role === role)),
  )
  writeAll(KEY, all)
  clearSnapshot(wallet, address, role)
}

// All tracked addresses for a wallet, optionally filtered by role.
// Deduplicates by normalized address (the same contract can be stored in several forms).
export function tracked(wallet, role) {
  if (!wallet) return []
  const list = readAll(KEY)[wallet] || []
  const seen = new Set()
  return list
    .filter((e) => !role || e.role === role)
    .filter((e) => {
      const key = normalizeAddr(e.address) + ':' + e.role
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((e) => e.address)
}

// ─── optimistic snapshots (active orders not yet readable on chain) ───────────
//
// A just-created order's contract is not deployed for a few seconds, so a chain
// read returns null and the order would not show in My Orders until a later
// sync. We save a full snapshot at creation so the Sent tab can render it right
// away. The snapshot is a fallback only: once the chain returns the real order,
// MyOrders clears the snapshot (clearSnapshot) and the chain data takes over.

export function saveSnapshot(wallet, order, role) {
  if (!wallet || !order || !role) return
  const all = readAll(SNAPSHOT_KEY)
  const list = all[wallet] || []
  const norm = normalizeAddr(order.address)
  const idx = list.findIndex((e) => normalizeAddr(e.address) === norm && e.role === role)
  const entry = { ...order, role }
  if (idx >= 0) list[idx] = entry
  else list.push(entry)
  all[wallet] = list
  writeAll(SNAPSHOT_KEY, all)
}

export function getSnapshots(wallet, role) {
  if (!wallet) return []
  const list = readAll(SNAPSHOT_KEY)[wallet] || []
  return role ? list.filter((e) => e.role === role) : list
}

export function clearSnapshot(wallet, address, role) {
  if (!wallet || !address) return
  const norm = normalizeAddr(address)
  const all = readAll(SNAPSHOT_KEY)
  const list = all[wallet]
  if (!list) return
  all[wallet] = list.filter(
    (e) => !(normalizeAddr(e.address) === norm && (!role || e.role === role)),
  )
  writeAll(SNAPSHOT_KEY, all)
}

// ─── delivery secrets (client's codes: local cache + cloud backup) ────────────
//
// When the client creates an order, the app picks a 256-bit secret and puts only
// its hash on-chain. The raw secret is kept here, keyed by wallet + order address,
// so the client can show it to the courier (as a QR) at hand-off — sometimes weeks
// later.
//
// localStorage is device-local, so clearing it or switching devices would lose
// the code (the order could then only settle by expiry — no money lost, but the
// convenience gone). So we also back the secret up in Telegram
// CloudStorage (per Telegram user, synced across that user's devices, no backend).
// localStorage stays the fast path; the cloud is the recovery fallback used by
// recoverSecret when the local cache misses.

// CloudStorage keys allow only [A-Za-z0-9_-], but the raw address form is
// "0:<hex>" (a colon). Map any disallowed char to "_" to get a valid, stable key.
// Order addresses are globally unique, so no Marketplace tag is needed here.
export const SECRET_KEY_PREFIX = 'sp_sec_'

export function secretCloudKey(address) {
  return SECRET_KEY_PREFIX + normalizeAddr(address).replace(/[^a-zA-Z0-9_-]/g, '_')
}

// The reverse of secretCloudKey: "sp_sec_0_<hex>" back to the order address
// "0:<hex>". Only the workchain colon was replaced, so one "_" maps back to ":".
// Returns null for a key that is not one of ours. Used by the diagnostics screen
// to ask the chain what happened to the order behind a leftover key.
export function addressFromSecretCloudKey(key) {
  if (!key?.startsWith(SECRET_KEY_PREFIX)) return null
  const body = key.slice(SECRET_KEY_PREFIX.length)
  const at = body.indexOf('_')
  if (at < 0) return null
  const addr = body.slice(0, at) + ':' + body.slice(at + 1)
  try {
    Address.parse(addr)
    return addr
  } catch {
    return null
  }
}

// The cloud value is "<secret hex>.<network>.<unix seconds when written>". The
// time and network let the cleanup tell an old create that never reached the
// chain from a fresh one, and keep a testnet build from judging a mainnet code
// (the cloud store is shared by every build of the bot). Values written before
// this format are a bare hex string: they decode with no time and no network,
// and the cleanup never deletes them on its own.
function encodeCloudSecret(secretHex) {
  return `${secretHex}.${NETWORK}.${Math.floor(Date.now() / 1000)}`
}

export function decodeCloudSecret(value) {
  if (!value) return null
  const [hex, network, at] = String(value).split('.')
  const createdAt = Number(at)
  return {
    hex,
    network: network || null,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null,
  }
}

// A Telegram call whose callback never fires (the connection dropped) must not
// hang the caller forever: after `ms` it counts as failed.
function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))])
}

const BACKUP_TRIES = 3
const BACKUP_RETRY_MS = 1500
const CLOUD_CALL_MS = 8000

// Write the cloud backup and read it back. A setItem that answers "ok" is not
// trusted on its own: only a read that returns the same secret counts. Retried,
// because the client gets no second chance to save this code. Resolves true
// only when the cloud is proven to hold the secret.
async function backupSecret(address, secretHex) {
  const key = secretCloudKey(address)
  for (let i = 0; i < BACKUP_TRIES; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, BACKUP_RETRY_MS))
    const wrote = await withTimeout(cloudSet(key, encodeCloudSecret(secretHex)), CLOUD_CALL_MS, false)
    if (!wrote) continue
    const back = await withTimeout(cloudRead(key), CLOUD_CALL_MS, { ok: false })
    if (back.ok && decodeCloudSecret(back.value)?.hex === secretHex) return true
  }
  return false
}

// The local write stays synchronous — the QR renders straight from it. The
// returned promise says whether the cloud copy is confirmed (see backupSecret).
// CreateOrder waits for it and does not open the wallet without it.
export function saveSecret(wallet, address, secretHex) {
  if (!wallet || !address || !secretHex) return Promise.resolve(false)
  const all = readAll(SECRETS_KEY)
  const forWallet = all[wallet] || {}
  forWallet[normalizeAddr(address)] = secretHex
  all[wallet] = forWallet
  writeAll(SECRETS_KEY, all)
  return backupSecret(address, secretHex)
}

// Make sure an active order's code also exists in the cloud, writing it again if
// it does not. Resolves false only when this device holds the only copy — that
// is the case worth telling the client about. Orders whose code this device does
// not have are none of our business here, so they resolve true.
export async function ensureCloudSecret(wallet, address) {
  const local = getSecret(wallet, address)
  if (!local) return true
  if (await cloudGet(secretCloudKey(address))) return true
  return backupSecret(address, local)
}

// Synchronous local-only read — the fast path used directly in render.
export function getSecret(wallet, address) {
  if (!wallet || !address) return null
  const forWallet = readAll(SECRETS_KEY)[wallet] || {}
  return forWallet[normalizeAddr(address)] || null
}

// Get the secret, falling back to the CloudStorage backup when this device's
// localStorage doesn't have it (cleared storage, or a different device). On a
// cloud hit we re-cache it locally so later reads are synchronous. Async because
// CloudStorage is callback-based.
export async function recoverSecret(wallet, address) {
  const local = getSecret(wallet, address)
  if (local) return local
  const hex = decodeCloudSecret(await cloudGet(secretCloudKey(address)))?.hex
  if (hex) saveSecret(wallet, address, hex) // re-cache locally (and re-affirm cloud)
  return hex || null
}

// Drop a secret from both stores. Called when an order reaches a terminal state,
// where the code is no longer needed, to keep the 1024-key cloud budget tidy.
// Returns the cloud delete as a promise so a caller that wants to know the key
// is really gone (the sweep below) can wait for it; most callers ignore it.
//
// Takes no wallet on purpose. An order address belongs to exactly one client, so
// the local entry can live under one wallet only — but the caller does not always
// know which one: the cloud store is shared by every wallet of one Telegram user,
// and the startup sweep runs with no wallet connected at all. So we clear the
// address under every wallet this device holds; at most one of them has it.
export function removeSecret(address) {
  if (!address) return Promise.resolve(false)
  const norm = normalizeAddr(address)
  const all = readAll(SECRETS_KEY)
  let changed = false
  for (const forWallet of Object.values(all)) {
    if (forWallet && norm in forWallet) {
      delete forWallet[norm]
      changed = true
    }
  }
  if (changed) writeAll(SECRETS_KEY, all)
  return cloudRemove(secretCloudKey(address))
}

// ─── cloud cleanup ───────────────────────────────────────────────────────────
//
// A code is written to the cloud when the order is created and deleted when the
// app SEES the order close (OrderDetail after a terminal action, MyOrders on
// sync). Both need the app to be running at the right moment, so codes survive
// their orders whenever an order settles elsewhere: on another device, by expiry,
// or under a Marketplace this build no longer scans. The review below asks the
// chain about every code still in the cloud and says which ones are dead weight.
//
// The one rule that matters: a code is deleted only on a definite answer from
// the chain. A failed request answers 'unknown' and changes nothing — deleting a
// live order's code would leave the client unable to ever pay the courier.
//
// Codes of creates that never reached the chain (wallet closed, rejected, the
// connection dropped) are written BEFORE the wallet opens, so they stay behind.
// The app cannot tell at that moment whether the transaction went out — the
// wallet window can be closed while the order is still created — so such a
// code is removed only later, and only when ALL of this holds:
//   - its cloud value carries a write time and this build's network;
//   - it was written over STALE_AFTER_S ago. A create message is valid for 5
//     minutes (validUntil in ton/tx.js), so after that it can no longer land;
//   - /accountStates answered and knows nothing about the address, AND
//     /transactions answered and the address never had a single transaction.

// 24 hours: far past the 5-minute validUntil, with room for a wrong phone clock.
export const STALE_AFTER_S = 24 * 60 * 60

// For 'never' rows: is this code an old create that provably never landed?
async function provenUnsent(rows) {
  const out = new Set()
  if (!rows.length) return out
  const values = await cloudGetItems(rows.map((r) => r.key))
  if (!values) return out
  const now = Math.floor(Date.now() / 1000)
  for (const r of rows) {
    const meta = decodeCloudSecret(values[r.key])
    if (!meta?.createdAt || meta.network !== NETWORK) continue
    if (now - meta.createdAt < STALE_AFTER_S) continue
    if ((await hasAnyTransaction(r.address)) === false) out.add(r.key)
  }
  return out
}

// Ask the chain about every delivery code in the cloud. Returns one row per
// stored key: { key, address, verdict, label, junk }. `junk` is true only where
// the chain proved the order is over, so the caller may delete it unattended.
export async function reviewCloudSecrets() {
  const keys = await cloudGetKeys()
  if (!keys) return null // CloudStorage cannot answer — nothing to review
  const rows = keys
    .filter((k) => k.startsWith(SECRET_KEY_PREFIX))
    .map((key) => ({ key, address: addressFromSecretCloudKey(key) }))
  if (!rows.length) return []

  const withAddr = rows.filter((r) => r.address)
  const verdicts = await classifyOrderAddresses(withAddr.map((r) => r.address))
  const unsent = await provenUnsent(withAddr.filter((r) => verdicts.get(r.address)?.kind === 'never'))
  return rows.map((r) => {
    if (!r.address) {
      return { ...r, verdict: 'invalid', label: 'not an order address', junk: false }
    }
    const { kind, status } = verdicts.get(r.address) || { kind: 'unknown' }
    switch (kind) {
      case 'live':
        return { ...r, verdict: 'active', label: 'live on chain' + (status ? ': ' + status : ''), junk: false }
      case 'closed':
        return { ...r, verdict: 'junk', label: 'closed on chain: ' + status, junk: true }
      case 'gone':
        return { ...r, verdict: 'junk', label: 'order settled, contract destroyed', junk: true }
      case 'never':
        // No order was ever deployed at this address. A just-created order looks
        // the same for a few seconds, so it is junk only when provenUnsent says
        // so; otherwise the diagnostics screen offers a manual delete.
        if (unsent.has(r.key)) {
          return { ...r, verdict: 'never on chain', label: 'create never sent (over 24h ago)', junk: true }
        }
        return { ...r, verdict: 'never on chain', label: 'no order was ever deployed here', junk: false }
      default:
        return { ...r, verdict: 'unknown', label: 'no answer from chain', junk: false }
    }
  })
}

// Delete every cloud code whose order the chain says is over. Needs no wallet:
// the cloud store is shared by every wallet of one Telegram user, and each key
// is judged by the chain alone. Costs one batched /accountStates request and
// never touches a code the chain did not rule on. Returns how many were deleted.
export async function sweepCloudSecrets() {
  const rows = await reviewCloudSecrets()
  if (!rows) return 0
  const junk = rows.filter((row) => row.junk)
  // Each removal is an independent cloud key, so run them together instead of
  // one round-trip at a time — with many closed orders the sequential version
  // made a sync visibly slower the more history a wallet had.
  await Promise.all(junk.map((row) => removeSecret(row.address)))
  return junk.length
}

// ─── history (terminal orders) ───────────────────────────────────────────────

// Save a full order snapshot to history. Called when an order transitions to
// Completed or Cancelled, so the History tab keeps the data without reading the
// chain (see the note at the top of this file).
export function saveToHistory(wallet, order, role) {
  if (!wallet || !order || !role) return
  const all = readAll(HISTORY_KEY)
  const list = all[wallet] || []
  // Overwrite if the same address already exists. Compare by normalized address:
  // the same contract is written here in different string forms (EQ/kQ from the
  // live flow, raw 0:... from the chain scanner), so a plain === check misses the
  // match and stores the order twice. normalizeAddr makes the forms comparable.
  const norm = normalizeAddr(order.address)
  const idx = list.findIndex((e) => normalizeAddr(e.address) === norm && e.role === role)
  const entry = { ...order, role }
  if (idx >= 0) {
    list[idx] = entry
  } else {
    list.push(entry)
  }
  all[wallet] = list
  writeAll(HISTORY_KEY, all)
}

// All history entries for a wallet, optionally filtered by role.
export function getHistory(wallet, role) {
  if (!wallet) return []
  const list = readAll(HISTORY_KEY)[wallet] || []
  const filtered = role ? list.filter((e) => e.role === role) : list
  // Deduplicate by normalized address + role (the same contract can sit in the
  // list under EQ/kQ and raw 0:... forms). Last entry wins (newest).
  const byKey = new Map()
  for (const e of filtered) byKey.set(normalizeAddr(e.address) + ':' + e.role, e)
  return [...byKey.values()]
}

// Find a single history entry by order address (for lookup in OrderDetail).
export function findInHistory(wallet, address) {
  if (!wallet || !address) return null
  const list = readAll(HISTORY_KEY)[wallet] || []
  const norm = normalizeAddr(address)
  return list.find((e) => normalizeAddr(e.address) === norm) || null
}

// ─── localStorage namespaces ────────────────────────────────────────────────

// Remove namespaces that belong to other (old) Marketplace deploys so their data
// does not linger in storage. Keeps only the current tag.
export function purgeForeignNamespaces() {
  const re = /^(swiftparcel\.(?:myorders|history|snapshots|secrets|feed))\.(.+)$/
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      const m = k && re.exec(k)
      if (m && m[2] !== MARKETPLACE_TAG) localStorage.removeItem(k)
    }
  } catch {
    // ignore private-mode errors
  }
}
