// USDT on TON — a TEP-74 jetton with 6 decimals. The delivery reward is locked
// in USDT; every fee and all gas stay in the native coin (GRAM).
//
// A jetton balance does not live in the user's wallet but in a separate "jetton
// wallet" contract per owner, and tokens move with a `transfer` message the owner
// sends to their OWN jetton wallet. This module knows the USDT master for each
// network, finds jetton wallets, reads balances and builds / reads the bodies.
import { Address, beginCell } from '@ton/core'
import { JettonMaster } from '@ton/ton'
import { getClient } from '../contracts/client'
import { IS_TESTNET, TONCENTER_V3, TONCENTER_API_KEY } from './network'

// Tether's USD₮ on mainnet. On testnet, the master of a test USDT: the public
// one's faucet stopped working (2026-09), so testnet runs use our own, deployed
// with contract/scripts/deploy-test-usdt.tolk and set in VITE_USDT_MASTER_TESTNET.
// It MUST be the master the Marketplace was deployed with — a Marketplace
// accepts no other jetton.
export const USDT_MASTER = IS_TESTNET
  ? import.meta.env.VITE_USDT_MASTER_TESTNET || 'kQCLDGJo8VGRXAZKSR9cPtn1uT7kEtEDKV38vgpoyg9HtSt2'
  : 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

// 1 USDT = 1_000_000 base units. A USDT amount must NEVER go through toNano
// (that is 1e9, the native coin's unit).
const UNITS = 1_000_000

export function toUsdtUnits(usdt) {
  return BigInt(Math.round(Number(usdt) * UNITS))
}

export function fromUsdtUnits(units) {
  return Number(units) / UNITS
}

const OP_TRANSFER = 0x0f8a7ea5

// The owner's USDT wallet, asked from the master — right even before that
// wallet exists. It never changes, so it is cached for the session.
const walletCache = new Map()
export async function usdtWalletOf(owner) {
  const key = Address.parse(owner).toRawString()
  if (!walletCache.has(key)) {
    const master = getClient().open(JettonMaster.create(Address.parse(USDT_MASTER)))
    walletCache.set(key, await master.getWalletAddress(Address.parse(owner)))
  }
  return walletCache.get(key)
}

// USDT balance, as a number of USDT, of an `owner` or of a jetton `wallet`
// given directly. 0 when the wallet does not exist yet (nothing was ever sent
// to it); null when the request failed and we do not know.
export async function fetchUsdtBalance({ owner, wallet }, attempt = 0) {
  const headers = TONCENTER_API_KEY ? { 'X-API-Key': TONCENTER_API_KEY } : {}
  const qs = wallet
    ? 'address=' + encodeURIComponent(wallet)
    : 'owner_address=' + encodeURIComponent(owner) + '&jetton_address=' + encodeURIComponent(USDT_MASTER)
  try {
    const r = await fetch(`${TONCENTER_V3}/jetton/wallets?${qs}&limit=1`, { headers })
    if (r.status === 429 && attempt < 3) {
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt + Math.random() * 400))
      return fetchUsdtBalance({ owner, wallet }, attempt + 1)
    }
    if (!r.ok) return null
    const data = await r.json()
    const w = data?.jetton_wallets?.[0]
    return w ? fromUsdtUnits(BigInt(w.balance)) : 0
  } catch {
    return null
  }
}

// The body of a jetton `transfer`, which an owner sends to their OWN jetton
// wallet: move `amount` (base units) to `destination`'s wallet, send the unused
// native coin back to `responseDestination`, and — when forwardTonAmount > 0 —
// notify `destination` with `forwardPayload`. The payload goes in a ref (TL-B
// `Either Cell ^Cell`, right branch), the only form the Marketplace reads.
export function jettonTransferBody({
  amount,
  destination,
  responseDestination,
  forwardTonAmount,
  forwardPayload = null,
}) {
  return beginCell()
    .storeUint(OP_TRANSFER, 32)
    .storeUint(0, 64) // query id
    .storeCoins(amount)
    .storeAddress(destination)
    .storeAddress(responseDestination)
    .storeBit(false) // no custom payload
    .storeCoins(forwardTonAmount)
    .storeMaybeRef(forwardPayload)
    .endCell()
}

// Read a `transfer` body back: { amount, destination, payload }, where payload
// is the forward payload's ref cell (or null). Null when it is not a transfer.
export function parseJettonTransfer(body) {
  try {
    const s = body.beginParse()
    if (s.loadUint(32) !== OP_TRANSFER) return null
    s.loadUintBig(64) // query id
    const amount = s.loadCoins()
    const destination = s.loadAddress()
    s.loadMaybeAddress() // response destination
    s.loadMaybeRef() // custom payload
    s.loadCoins() // forward TON amount
    const payload = s.loadBit() ? s.loadRef() : null
    return { amount, destination, payload }
  } catch {
    return null
  }
}

// The order's parameters, carried in the create transfer's forward payload.
// MUST match `struct (0xa00a0000) CreateOrder` in contract/contracts/types.tolk
// field for field: the Marketplace reads the order from it, and a mismatch makes
// it refuse the order and send the USDT back. (It is not an incoming message of
// its own, so the generated wrapper does not include it.)
const OP_CREATE_ORDER = 0xa00a0000

export function createOrderPayload({
  nonce,
  createdAt,
  deliveryTime,
  description,
  area,
  origin,
  clientContact,
  secretHash,
  referral,
}) {
  return beginCell()
    .storeUint(OP_CREATE_ORDER, 32)
    .storeUint(BigInt(nonce), 64)
    .storeUint(createdAt, 32)
    .storeUint(deliveryTime, 32) // seconds the courier gets after accepting
    .storeRef(description)
    .storeRef(area)
    .storeRef(origin)
    .storeRef(clientContact)
    .storeUint(BigInt(secretHash), 256)
    .storeAddress(referral) // null → addr_none, as Tolk stores `address?`
    .endCell()
}

// Read a CreateOrder payload back (cells stay cells), or null.
export function parseCreateOrderPayload(cell) {
  try {
    const s = cell.beginParse()
    if (s.loadUint(32) !== OP_CREATE_ORDER) return null
    const p = {
      nonce: s.loadUintBig(64),
      createdAt: s.loadUint(32),
      deliveryTime: s.loadUint(32),
      description: s.loadRef(),
      area: s.loadRef(),
      origin: s.loadRef(),
      clientContact: s.loadRef(),
      secretHash: s.loadUintBig(256),
      referral: s.loadMaybeAddress(),
    }
    s.endParse()
    return p
  } catch {
    return null
  }
}
