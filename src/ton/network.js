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

// Public RPC used to read balances and order data.
export const TONCENTER = IS_TESTNET
  ? 'https://testnet.toncenter.com/api/v2'
  : 'https://toncenter.com/api/v2'

// toncenter v3 base. v3 exposes a /messages endpoint we use to decode the
// CreateOrder bodies sent to the Marketplace (the city filter and the history
// scanner both read it). Kept here so both callers share one URL.
export const TONCENTER_V3 = IS_TESTNET
  ? 'https://testnet.toncenter.com/api/v3'
  : 'https://toncenter.com/api/v3'

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

// Toncenter API key for the active network. Separate keys for testnet and mainnet
// so rate limits are tracked independently.
export const TONCENTER_API_KEY = IS_TESTNET
  ? import.meta.env.VITE_TONCENTER_API_KEY
  : import.meta.env.VITE_TONCENTER_API_KEY_MAINNET

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
