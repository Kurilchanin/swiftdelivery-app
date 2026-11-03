import { Address } from '@ton/core'

// Which TON network we talk to, picked from the VITE_TON_NETWORK env flag.
// Defaults to testnet so we never touch real coins by accident.
export const NETWORK =
  import.meta.env.VITE_TON_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'

export const IS_TESTNET = NETWORK === 'testnet'

// TON Connect chain id for our network. Used in two places that MUST agree:
//   1. setConnectionNetwork — pins the chain the wallet connects on, and
//   2. sendTransaction.network — pins the chain the wallet sends on.
// If the connect chain and the send chain ever differ, the wallet blocks the
// send ("transaction failed"), so both read this one value.
export const CONNECT_NETWORK = IS_TESTNET ? '-3' : '-239'

// Our Worker (worker/ in this repo): a proxy to toncenter that holds the real
// toncenter key, and the accept-invite mailbox. The app never sees a toncenter
// key; it sends APP_KEY instead (below).
export const API_BASE = import.meta.env.VITE_API_URL || 'https://swiftdelivery.fatherslab.workers.dev'

// The app's own key for the Worker, sent as X-API-Key wherever the code used to
// send the toncenter key. It is PUBLIC (it is in this bundle): it only filters
// stray traffic. Must equal APP_KEY in worker/wrangler.toml.
export const APP_KEY = import.meta.env.VITE_APP_KEY || ''

// toncenter v2 (balances, network config, get-methods) and v3 (account states,
// transactions, messages, jetton wallets) — only through the Worker. The app
// never calls toncenter directly and holds no toncenter key.
export const TONCENTER = `${API_BASE}/ton/${NETWORK}/v2`
export const TONCENTER_V3 = `${API_BASE}/ton/${NETWORK}/v3`

// Where wallets fetch our manifest. Must be https in production.
export const MANIFEST_URL =
  import.meta.env.VITE_TONCONNECT_MANIFEST_URL ||
  window.location.origin + '/tonconnect-manifest.json'

// Marketplace contract address for the active network. Each network has its own
// deployed Marketplace, so the address MUST follow VITE_TON_NETWORK. Testnet keeps
// the original VITE_MARKETPLACE_ADDRESS name (no migration needed); mainnet reads
// its own VITE_MARKETPLACE_ADDRESS_MAINNET.
export const MARKETPLACE_ADDRESS = IS_TESTNET
  ? import.meta.env.VITE_MARKETPLACE_ADDRESS
  : import.meta.env.VITE_MARKETPLACE_ADDRESS_MAINNET

// A short, stable tag for the active Marketplace, used to namespace all
// per-Marketplace localStorage (My Orders, history, snapshots, secrets, feed
// cache). When the Marketplace is redeployed the tag changes, so data from an old
// deploy lands under a dead namespace and never shows again — that is what keeps
// stale orders out of My Orders and History. Normalized to the raw address form
// so EQ/kQ inputs map to the same tag.
export const MARKETPLACE_TAG = (() => {
  try {
    return Address.parse(MARKETPLACE_ADDRESS).toRawString().split(':')[1].slice(0, 12)
  } catch {
    return 'none'
  }
})()

// The one text form an address takes on screen. Wallets (the user, client,
// courier) show non-bounceable, UQ… (0Q… on testnet) — the form TON Connect and
// the wallet apps show, so a user knows their own address. Contracts (the
// Marketplace, an order) show bounceable, EQ… (kQ… on testnet), like explorers.
export function displayAddr(addr, kind) {
  try {
    const a = typeof addr === 'string' ? Address.parse(addr) : addr
    return a.toString({ urlSafe: true, bounceable: kind === 'contract', testOnly: IS_TESTNET })
  } catch {
    return addr ? String(addr) : ''
  }
}
