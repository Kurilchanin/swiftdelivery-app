// High-level order API: read orders, compute addresses, build transactions.
// Sends go through TON Connect (see sendTx); reads go through a TON RPC client.
import { Address, Cell, beginCell, toNano } from '@ton/core'
import { Order, OrderExtra, OrderJetton, OrderStorage } from '../../contract/wrappers-ts/Order.gen'
import { Marketplace } from '../../contract/wrappers-ts/Marketplace.gen'
import { emulateCallFee } from '../ton/emulateFee'
import { getClient } from './client'
import { shortAddr } from '../utils/security'
import { getReferral, referralReady, referralLocksOrder } from '../referral'
import { t, durationWords } from '../i18n'
import { gramLabel } from '../ton/price'
import { toUsdtUnits, fromUsdtUnits, jettonTransferBody, createOrderPayload } from '../ton/jetton'
import { IS_TESTNET, MARKETPLACE_ADDRESS, TONCENTER_V3, TONCENTER_API_KEY, displayAddr } from '../ton/network'

const MARKETPLACE = MARKETPLACE_ADDRESS

// Fetch /accountStates with exponential backoff + jitter on 429. Without this,
// a rate limit here silently emptied the whole chunk (readOrdersBatch treated
// it the same as "no accounts"), which made a just-synced order vanish from
// the Sent/Taken tabs on ↻ — the sync itself fires several Toncenter calls
// right before this one, so hitting 429 here is common, not rare.
async function fetchAccountStates(qs, attempt = 0) {
  const headers = API_KEY ? { 'X-API-Key': API_KEY } : {}
  try {
    const r = await fetch(`${TONCENTER_V3}/accountStates?${qs}&include_boc=true`, { headers })
    if (r.status === 429 && attempt < 3) {
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt + Math.random() * 400))
      return fetchAccountStates(qs, attempt + 1)
    }
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

// Base64 hash of the Order code this frontend knows. Used to drop accounts that
// run a different Order version (e.g. orders deployed by a previous Marketplace)
// from batch reads — for free, since the hash comes back in the same response.
const ORDER_CODE_HASH_B64 = Order.CodeCell.hash().toString('base64')
const API_KEY = TONCENTER_API_KEY

// The delivery time the client picks per order: how long a courier has to deliver
// once they accept, whole days from 1 to 14. MUST match MIN/MAX_DELIVERY_TIME in
// contract/contracts/Marketplace.tolk (it refunds anything outside the range).
export const DAY_SECONDS = 24 * 60 * 60
export const DELIVERY_DAYS_MIN = 1
export const DELIVERY_DAYS_MAX = 14

// What a courier attaches to accept an order. There is no courier stake any
// more: this is a flat 0.1 TON service fee. It stays on the contract and is NOT
// refunded — together with the 0.1 TON the client pays at create time it makes
// the ~0.2 TON the platform keeps when the order completes.
// Mirrors MIN_ACCEPT_FEE in Order.tolk.
export const ACCEPT_FEE_TON = 0.1

// What the client pays on top of the reward at create time: a flat 0.1 TON
// service fee. Non-refundable; it stays with the platform (as the create half of
// the ~0.2 TON earned on a completed order, and it is also kept on top of the
// cancel fee if the order is cancelled while still Open). Mirrors buildCreateOrder.
// It is ALL the native coin the create transfer carries: every network fee of the
// create comes out of it and the rest stays on the order (Marketplace.tolk).
export const CREATE_FEE_TON = 0.1

// What the client pays to CANCEL an order they created while it is still Open.
// This is ON TOP of the 0.1 TON create fee they already paid (which is kept too),
// so a cancelled order costs the client 0.4 TON in total and the reward is
// returned in full. The 0.3 is all the cancel attaches: its network fees, the USDT
// payout included, come out of the order's fee pool. Mirrors CANCEL_FEE in
// Order.tolk; the whole amount goes to the platform.
export const CANCEL_FEE_TON = 0.3

// What the courier pays to give up (RELEASE) an order they already accepted. This
// is ON TOP of the 0.1 TON accept fee they already paid (which is not
// refunded), so a release costs the courier 0.3 TON in total. The order reopens
// for the next courier and the reward stays locked. Mirrors RELEASE_FEE in
// Order.tolk; both fees accumulate on the contract and reach the platform owner
// only when the order finally settles (complete / cancel / expire).
export const RELEASE_FEE_TON = 0.2

// Native coin a Rescue attaches for its USDT payout: a closed order is empty, so
// the caller brings the gas, and the USDT wallet sends the unused part back to
// them. Order.tolk requires at least 0.02. Confirm / claim / cancel attach no
// payout gas — the order pays it from its fee pool.
export const PAYOUT_GAS_TON = 0.1

// The part of the 0.1 create fee the create transfer forwards to the Marketplace
// with the USDT. It pays the Marketplace, the USDT hop to the order and the
// order's deploy; the other 0.02 is gas for the client's own USDT wallet. What
// either does not use goes to the order too, so the whole 0.1 ends up on the
// order minus the network fees. Marketplace.tolk sends the USDT back when this is
// below 0.05.
export const CREATE_FORWARD_TON = 0.08

// Default "from" written to the order when the client does not pick an origin:
// the parcel can start anywhere. The origin is free text — it does not have to
// be a city. It can be a shop, an airport zone, a landmark — any place (e.g.
// "Duty Free", "H&M", "McDonald's"). Stored on-chain like any other text field.
export const DEFAULT_ORIGIN = 'All world'

// Minimum reward the client must pay, in USDT (1 USDT ≈ $1). There is no maximum.
export const MIN_REWARD_USD = 10

// Fetch and cache the Marketplace owner address. The owner is stored in the
// Marketplace contract and must be included in each Order's init data (it
// receives the platform fee). Cached for the session lifetime.
let _ownerCache = null
export async function getMarketplaceOwner({ retries = 2 } = {}) {
  if (_ownerCache) return _ownerCache
  // Retry a few times before giving up: computeOrderAddress needs the owner, and
  // order creation cannot go on without it. See computeOrderAddress + CreateOrder.
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const market = getClient().open(Marketplace.fromAddress(Address.parse(MARKETPLACE)))
      const addr = await market.getOwner()
      _ownerCache = addr.toString({ urlSafe: true, bounceable: true, testOnly: IS_TESTNET })
      return _ownerCache
    } catch {
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
    }
  }
  return null
}

// Serialize an address with the test-only flag that matches our network.
// This MUST be used for every message destination: a wallet (e.g. Tonkeeper on
// testnet) silently drops a sendTransaction whose destination is flagged for
// the other network. `Address.toString()` defaults to the mainnet form (EQ…),
// which is why a testnet order address must be re-flagged to kQ… here.
function toNetworkAddress(addr) {
  const a = typeof addr === 'string' ? Address.parse(addr) : addr
  return a.toString({ urlSafe: true, bounceable: true, testOnly: IS_TESTNET })
}

// Order status names, contiguous with the on-chain enum:
// Open=0, Accepted=1, Completed=2, Cancelled=3, Expired=4, Funding=5.
// Funding: deployed, but its USDT has not arrived yet (seconds); it cannot be
// accepted and the Feed (Open only) does not show it.
export const STATUS = {
  Open: 'Open',
  Accepted: 'Accepted',
  Completed: 'Completed',
  Cancelled: 'Cancelled',
  Expired: 'Expired',
  Funding: 'Funding',
}
const STATUS_BY_NUM = {
  0: 'Open',
  1: 'Accepted',
  2: 'Completed',
  3: 'Cancelled',
  4: 'Expired',
  5: 'Funding',
}
export function statusName(s) {
  return STATUS_BY_NUM[Number(s)] || 'Unknown'
}

// True for states where the order is closed and its contract is destroyed.
export function isTerminalStatus(status) {
  return status === STATUS.Completed || status === STATUS.Cancelled || status === STATUS.Expired
}

// Compare two TON addresses regardless of their text form (EQ / kQ / raw).
export function sameAddress(a, b) {
  try {
    return Address.parse(a).equals(Address.parse(b))
  } catch {
    return false
  }
}

// Pack a short text into a cell. Long text (> ~127 bytes spills into refs).
export function textToCell(text) {
  return beginCell().storeStringTail(text || '').endCell()
}
export function cellToText(cell) {
  try {
    return cell.beginParse().loadStringTail()
  } catch {
    return ''
  }
}

// City normalization. `area` is free text, so "Paris", "paris" and " Paris "
// must not become different filter entries. normalizeCity is the display form
// (trim + collapse inner whitespace, case kept); cityKey is the match key
// (also lower-cased). Used on create (light cleanup) and in the Feed filter.
export function normalizeCity(s) {
  return (s || '').trim().replace(/\s+/g, ' ')
}
export function cityKey(s) {
  return normalizeCity(s).toLowerCase()
}

// City names are public and shared across users, so they must be written in
// English (Latin) letters only — that way the same city groups together no
// matter the writer's own language, and the Feed filter stays consistent. Only
// the city fields are restricted; the parcel description can be any language.
// Allowed: Latin letters, spaces, and a few marks used in city names (hyphen,
// apostrophe, period — e.g. "St. John's", "Stratford-upon-Avon"). Everything
// else (Cyrillic, digits, symbols) is stripped. Applied live on input so the
// field simply refuses anything that is not a valid city character.
export function filterCityInput(s) {
  return (s || '').replace(/[^A-Za-z \-'.]/g, '')
}

// The "from" (origin) field is NOT restricted to a city: it can be a shop, an
// airport zone, a landmark — any place ("Duty Free", "H&M", "7-Eleven", "Gate
// 12"). So it allows more than filterCityInput: digits and a few symbols common
// in place and brand names (& , / ( ) # +) on top of the city characters. It
// stays Latin-only for the same public/shared reason as the city: the origin is
// written once and read by couriers in any language.
export function filterPlaceInput(s) {
  return (s || '').replace(/[^A-Za-z0-9 \-'.,/&()#+]/g, '')
}

// A 64-bit random nonce so each order gets a unique address.
function randomNonce() {
  const a = new Uint32Array(2)
  crypto.getRandomValues(a)
  return (BigInt(a[0]) << 32n) | BigInt(a[1])
}

// ---- delivery code (hash-lock) ----
//
// The client's app picks a 256-bit random secret at create time. Only its HASH
// goes on-chain (OrderExtra.secretHash); the secret itself stays on the client's
// device and is shown to the courier at hand-off as a QR code. The courier reveals
// it with ConfirmWithCode and the contract pays the reward only when
// hash(secret) == secretHash. So the courier is paid ONLY with the client's code.
//
// The secret must be long (256 bits, not a 6-digit code): the hash is public on
// chain, so a short code could be brute-forced from it and the order closed before
// delivery. 256 random bits cannot be guessed.

// 32 random bytes as a uint256 secret.
export function randomSecret() {
  const a = new Uint8Array(32)
  crypto.getRandomValues(a)
  let hex = ''
  for (const b of a) hex += b.toString(16).padStart(2, '0')
  return BigInt('0x' + hex)
}

// The on-chain commitment: the representation hash of a cell holding the 256-bit
// secret. MUST match the contract, which computes
// beginCell().storeUint(secret, 256).endCell().hash() (see Order.tolk).
export function secretCommit(secret) {
  const cell = beginCell().storeUint(BigInt(secret), 256).endCell()
  return BigInt('0x' + cell.hash().toString('hex'))
}

// Render a secret as a fixed-length 64-char hex string for the QR code, and parse
// it back. The QR carries just the hex digits; the courier's scanner reads them.
export function secretToHex(secret) {
  return BigInt(secret).toString(16).padStart(64, '0')
}
export function secretFromHex(hex) {
  const clean = String(hex || '').trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{1,64}$/.test(clean)) return null
  try {
    return BigInt('0x' + clean)
  } catch {
    return null
  }
}

// Compute an order's address locally from the fields the creator controls.
// `owner` must match the Marketplace owner (fetched via getMarketplaceOwner).
// The address is the hash of the Order's init data, which now includes `owner`.
// `secretHash` is part of the init data, so it must be supplied to match the
// on-chain address. Pass either a ready `secretHash` (bigint) or the raw `secret`
// (we hash it). Without it the address will not match the deployed order.
// `referral` (Address, address string, or null) is part of the init data too:
// it must be EXACTLY what went into CreateOrder, or the computed address will
// not match the deployed order (same failure mode as a wrong secretHash).
export async function computeOrderAddress({
  client,
  reward,
  nonce,
  createdAt,
  deliveryTime,
  description,
  area,
  origin = DEFAULT_ORIGIN,
  clientContact = '',
  secret,
  secretHash,
  referral = null,
}) {
  const ownerStr = await getMarketplaceOwner()
  // Fail loud instead of letting Address.parse(null) throw an opaque error. The
  // caller (CreateOrder) computes the address BEFORE sending, so this aborts the
  // create with no money locked, rather than after — where the delivery secret
  // could be lost.
  if (!ownerStr) throw new Error('marketplace-owner-unavailable')
  const commit = secretHash != null ? BigInt(secretHash) : secretCommit(secret)
  return toNetworkAddress(
    initialOrderAddress({
      client: Address.parse(client),
      description: textToCell(description),
      area: textToCell(area),
      origin: textToCell(origin),
      // USDT base units, exactly as the create transfer carries them.
      reward: toUsdtUnits(reward),
      nonce: BigInt(nonce),
      createdAt: BigInt(createdAt),
      deliveryTime: BigInt(deliveryTime),
      owner: Address.parse(ownerStr),
      clientContact: textToCell(clientContact),
      secretHash: commit,
      referral: typeof referral === 'string' ? Address.parse(referral) : referral,
    }),
  )
}

// The address of an order's INITIAL state, the one the Marketplace deploys, from
// the fields fixed at create time (`f`: Address / Cell / bigint values). Shared by
// computeOrderAddress (a new order) and isGenuineOrder (an order read from
// chain), so the two can never disagree.
function initialOrderAddress(f) {
  return Order.fromStorage({
    client: f.client,
    courier: null,
    description: f.description,
    area: f.area,
    origin: f.origin,
    reward: f.reward,
    // Every order is deployed Funding; it turns Open when its USDT arrives.
    status: 5n,
    nonce: f.nonce,
    createdAt: f.createdAt,
    deliveryTime: f.deliveryTime,
    // 0 in the initial state, so it does not affect the order's address.
    acceptedAt: 0n,
    // owner + contacts live in a referenced cell (Cell<OrderExtra>) so the root
    // storage cell stays under 1023 bits. courierContact is empty at deploy
    // time; the client's contact and owner are part of the init data and so
    // must be included to match the on-chain address.
    extra: {
      ref: OrderExtra.create({
        owner: f.owner,
        clientContact: f.clientContact,
        courierContact: textToCell(''),
        secretHash: f.secretHash,
        referral: f.referral,
        // The Marketplace that deploys the order is part of its init data; the
        // order's USDT wallet is not (null until the Marketplace hands it over).
        jetton: {
          ref: OrderJetton.create({ marketplace: Address.parse(MARKETPLACE), wallet: null }),
        },
      }),
    },
  }).address
}

// True when the order stored at `address` (`s`, a parsed OrderStorage) is one OUR
// Marketplace deployed. Anyone can deploy our Order code with made-up data —
// status Open, a big reward, no USDT behind it, themselves as owner — and send a
// courier a link to it; the code hash alone cannot tell. So we rebuild the
// order's initial state from its create-time fields, with OUR Marketplace in it,
// and require that it hashes to this very address.
//
// The owner is taken from the storage and needs no network check: a fake owner
// gives either a different address, or an order our Marketplace never deployed
// — and only that Marketplace can give an order its USDT wallet, so such an
// order stays Funding forever and can never be accepted.
export function isGenuineOrder(address, s) {
  try {
    const x = s.extra.ref
    if (!x.jetton.ref.marketplace.equals(Address.parse(MARKETPLACE))) return false
    return initialOrderAddress({
      client: s.client,
      description: s.description,
      area: s.area,
      origin: s.origin,
      reward: s.reward,
      nonce: s.nonce,
      createdAt: s.createdAt,
      deliveryTime: s.deliveryTime,
      owner: x.owner,
      clientContact: x.clientContact,
      secretHash: x.secretHash,
      referral: x.referral,
    }).equals(Address.parse(address))
  } catch {
    return false
  }
}

// Read one order from chain (the order page opens ANY address from a link, so
// this is where fakes must be caught). Returns:
//   - the normalized order (the readOrdersBatch shape) for a genuine order;
//   - { address, genuine: false } when the address holds something else: another
//     contract, or our Order code with made-up data (see isGenuineOrder) — the
//     page then warns and offers no action;
//   - null when there is no such account or the request failed.
// One /accountStates call gives both the code hash and the storage.
export async function readOrder(addressStr) {
  const fake = { address: addressStr, genuine: false }
  const qs = 'address=' + encodeURIComponent(addressStr)
  const data = await fetchAccountStates(qs)
  const acc = data?.accounts?.[0]
  if (!acc || acc.status !== 'active' || !acc.data_boc) return null
  if (acc.code_hash !== ORDER_CODE_HASH_B64) return fake
  try {
    const s = OrderStorage.fromSlice(Cell.fromBase64(acc.data_boc).beginParse())
    return isGenuineOrder(addressStr, s) ? orderFromStorage(addressStr, s) : fake
  } catch {
    return null
  }
}

// Normalized raw key for matching addresses across text forms (EQ/kQ/raw).
function rawKey(addr) {
  try {
    return Address.parse(addr).toRawString().toUpperCase()
  } catch {
    return String(addr).toUpperCase()
  }
}

// Build the normalized order object from a parsed storage cell. Mirrors the
// shape readOrder returns, so callers can use either interchangeably.
function orderFromStorage(address, s) {
  const acceptedAt = Number(s.acceptedAt)
  return {
    address,
    client: s.client.toString(),
    courier: s.courier ? s.courier.toString() : null,
    description: cellToText(s.description),
    area: cellToText(s.area),
    origin: cellToText(s.origin),
    clientContact: cellToText(s.extra.ref.clientContact),
    courierContact: cellToText(s.extra.ref.courierContact),
    reward: fromUsdtUnits(s.reward), // USDT
    usdtWallet: s.extra.ref.jetton.ref.wallet ? s.extra.ref.jetton.ref.wallet.toString() : null,
    status: statusName(s.status),
    nonce: s.nonce.toString(),
    createdAt: Number(s.createdAt),
    acceptedAt,
    // Seconds the courier has after accepting, chosen by the client (1..14 days).
    deliveryTime: Number(s.deliveryTime),
    deadlineAt: acceptedAt ? acceptedAt + Number(s.deliveryTime) : null,
    referralLocked: referralLocksOrder(s.extra.ref.referral),
  }
}

// Read many orders in as few network calls as possible. toncenter v3
// /accountStates returns many account states (storage data cell + code hash) in
// ONE request, so a whole Feed page costs a single call instead of one
// get-method per order. We parse the storage cell directly (same layout the
// history scanner reads from a destroyed order's stateInit). Accounts that are
// missing/destroyed (terminal orders) or that run a different Order code version
// are dropped. Returns objects in the readOrder shape.
export async function readOrdersBatch(addresses) {
  if (!addresses?.length) return []
  // Map raw → original input string so we echo back the caller's address form.
  const byRaw = new Map()
  for (const a of addresses) byRaw.set(rawKey(a), a)

  const out = []
  // `out.failed` (true when any chunk's request never got an answer, even after
  // fetchAccountStates' own retries) lets a caller like Feed tell "the chain
  // truly has nothing to show" apart from "we don't know" — treating the two the
  // same wiped the Feed to "no open orders" whenever this ran right behind a
  // burst of other Toncenter calls (e.g. MY's own sync) and got rate-limited.
  out.failed = false
  const CHUNK = 100 // stay within the endpoint's per-request address limit
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK)
    const qs = chunk.map((a) => 'address=' + encodeURIComponent(a)).join('&')
    const data = await fetchAccountStates(qs)
    if (!data) {
      out.failed = true
      continue
    }
    for (const acc of data?.accounts || []) {
      // Skip uninit/destroyed accounts and any order on a different code version.
      if (acc.status !== 'active' || !acc.data_boc) continue
      if (acc.code_hash !== ORDER_CODE_HASH_B64) continue
      try {
        const s = OrderStorage.fromSlice(Cell.fromBase64(acc.data_boc).beginParse())
        const address = byRaw.get(rawKey(acc.address)) || acc.address
        // Our code with made-up data is not an order (see isGenuineOrder).
        if (!isGenuineOrder(address, s)) continue
        out.push(orderFromStorage(address, s))
      } catch {
        // skip a malformed storage cell
      }
    }
  }
  return out
}

// Read many orders, dropping any that fail to load. Batched through one
// /accountStates call per 100 addresses (see readOrdersBatch).
export async function readOrders(addresses) {
  return readOrdersBatch(addresses)
}

// ---- transaction builders (consumed by sendTx) ----

// Create a new order: ONE transfer of `reward` USDT to the Marketplace, sent to
// the client's own USDT wallet (`usdtWallet`, see usdtWalletOf), with the
// order's parameters in the forward payload. Returns the bits sendTx needs plus
// the fields the caller needs to recompute the new order's address.
export async function buildCreateOrder({
  reward,
  deliveryTime, // seconds, whole days DELIVERY_DAYS_MIN..MAX
  description,
  area,
  origin = DEFAULT_ORIGIN,
  clientContact = '',
  client,
  usdtWallet,
}) {
  const nonce = randomNonce()
  const createdAt = Math.floor(Date.now() / 1000)
  // Pick the delivery secret and put only its hash on-chain. The raw secret is
  // returned below so the caller can store it locally and show it to the courier
  // (as a QR) at hand-off — it never goes to the blockchain.
  const secret = randomSecret()
  const secretHash = secretCommit(secret)
  // The user's referral, if any (see src/referral.js). The startup capture
  // reads it from Telegram CloudStorage, so wait for that (briefly) first: an
  // order created right after launch must not go out without it. It goes into
  // the order's init data, so it is returned below too: the caller MUST feed
  // the same value to computeOrderAddress or the address won't match.
  await referralReady()
  const referral = getReferral()
  const payload = createOrderPayload({
    nonce,
    createdAt,
    deliveryTime,
    description: textToCell(description),
    area: textToCell(area),
    origin: textToCell(origin),
    clientContact: textToCell(clientContact),
    secretHash,
    referral,
  })
  // The order's address, known before anything is signed: the USDT wallets send
  // their unused gas there, and the caller saves the delivery code under it.
  // Throws — before any money moves — if the Marketplace owner (part of the init
  // data) cannot be resolved.
  const orderAddress = await computeOrderAddress({
    client,
    reward,
    nonce: nonce.toString(),
    createdAt,
    deliveryTime,
    description,
    area,
    origin,
    clientContact,
    secretHash,
    referral: referral ? referral.toRawString() : null,
  })
  // The reward travels as USDT, with exactly the 0.1 create fee in native coin
  // and nothing else: it pays every hop of the create, and what the hops do not
  // use — the USDT wallets' "excesses" included — ends up on the order as its fee
  // buffer (the courier adds 0.1 on accept; the platform keeps that ~0.2 at the
  // end). No coin comes back to the client.
  const body = jettonTransferBody({
    amount: toUsdtUnits(reward),
    destination: Address.parse(MARKETPLACE),
    responseDestination: Address.parse(orderAddress),
    forwardTonAmount: toNano(String(CREATE_FORWARD_TON)),
    forwardPayload: payload,
  })
  const attachTon = CREATE_FEE_TON

  return {
    orderAddress,
    nonce: nonce.toString(),
    createdAt,
    deliveryTime,
    reward,
    description,
    area,
    origin,
    clientContact,
    // The raw delivery secret (as hex) and its hash. The caller stores the secret
    // locally (keyed by the new order's address) and shows it to the courier later.
    secret: secretToHex(secret),
    secretHash: secretHash.toString(),
    // The referral that went into the message (raw string or null), for
    // computeOrderAddress — it is part of the order's init data.
    referral: referral ? referral.toRawString() : null,
    messages: [
      {
        address: toNetworkAddress(usdtWallet),
        amount: toNano(attachTon.toFixed(9)).toString(),
        payload: body.toBoc().toString('base64'),
      },
    ],
    summary: {
      title: t('tx.titleCreate'),
      lines: [
        { label: t('tx.reward'), value: reward + ' USDT' },
        { label: t('tx.serviceFee'), value: gramLabel(CREATE_FEE_TON) },
        { label: t('tx.to'), value: area },
        { label: t('tx.from'), value: origin },
        { label: t('tx.total'), value: `${reward} USDT + ${gramLabel(roundTon(attachTon))}` },
      ],
    },
  }
}

// Drop float noise (0.1 + 0.2) from a native-coin amount shown to the user.
function roundTon(x) {
  return Number(x.toFixed(4))
}

// A Rescue's payout gas: the unused part comes back.
const payoutGas = () => ({ label: t('tx.payoutGas'), ton: PAYOUT_GAS_TON })

// The network fee of running the order's code for this message, measured by
// emulating it against the order's current state (see ton/emulateFee.js). The
// actions with no service fee attach only this.
async function networkFee(orderAddress, bodyCell, from) {
  const nano = await emulateCallFee({ from, to: orderAddress, body: bodyCell })
  return { label: t('tx.networkFee'), ton: Number(nano) / 1e9 }
}

// One small helper for the order actions. `fees` lists what the message carries
// — [{ label, ton }], e.g. a service fee (stays with the platform) and/or payout
// gas (mostly comes back) — and the message attaches their sum. `extraLines`
// go into the preview above the fees.
function buildAction(orderAddress, bodyCell, title, fees, extraLines = []) {
  const total = fees.reduce((sum, f) => sum + f.ton, 0)
  return {
    messages: [
      {
        address: toNetworkAddress(orderAddress),
        amount: toNano(total.toFixed(9)).toString(),
        payload: bodyCell.toBoc().toString('base64'),
      },
    ],
    summary: {
      title,
      lines: [
        { label: t('tx.order'), value: shortAddr(displayAddr(orderAddress, 'contract')), mono: true },
        ...extraLines,
        ...fees.map((f) => ({ label: f.label, value: gramLabel(f.ton) })),
      ],
    },
  }
}

// A preview line saying what USDT the signer gets or gets back, so the result is
// on screen before the wallet opens. No line when the amount is not known.
const usdtLine = (labelKey, reward) =>
  reward == null ? [] : [{ label: t(labelKey), value: reward + ' USDT' }]

// Accept an order. The courier pays a flat 0.1 TON service fee. It is NOT a stake
// and is NOT refunded: it stays on the contract as the platform's accept-side
// earnings. The contract enforces a minimum (MIN_ACCEPT_FEE). `order` (optional)
// adds what the courier earns and how long they have.
export const buildAccept = (a, courierContact = '', feeTon = ACCEPT_FEE_TON, order = null) =>
  buildAction(
    a,
    Order.createCellOfAcceptOrder({ courierContact: textToCell(courierContact) }),
    t('tx.titleAccept'),
    [{ label: t('tx.serviceFee'), ton: feeTon }],
    order
      ? [
          ...usdtLine('tx.youEarn', order.reward),
          {
            label: t('meta.deliveryTime'),
            value: durationWords(Math.round(order.deliveryTime / DAY_SECONDS), 'day'),
          },
        ]
      : [],
  )
// Confirm a delivery by revealing the secret behind the order's secretHash. The
// courier scans the client's QR to get the secret (hex) and sends it here; the
// contract pays the reward (USDT) only if its hash matches. `secret` is a hex
// string or a bigint. Only the courier who accepted may call it.
// `from` is the courier's wallet: the call is emulated as theirs to learn its
// network fee, the only coin it carries (the order pays the payout).
// `reward` (optional) adds the USDT the courier receives to the preview.
export const buildConfirmWithCode = async (a, secret, from, reward) => {
  const value = typeof secret === 'bigint' ? secret : secretFromHex(secret)
  if (value == null) throw new Error('invalid delivery code')
  const body = Order.createCellOfConfirmWithCode({ secret: value })
  return buildAction(
    a,
    body,
    t('tx.titleConfirm'),
    [await networkFee(a, body, from)],
    usdtLine('tx.youReceive', reward),
  )
}
// Cancel an order. On an Open order the client attaches exactly the flat 0.3 TON
// cancel fee (on top of the 0.1 TON create fee already held), which is NOT
// refunded — it goes to the platform — and nothing else: the network fees, the
// USDT payout included, come out of the order's fee pool. A Funding order (its
// USDT never showed up) is cancelled with only the network fee of running the
// order's code (emulated as `from`, the client): the contract waives the cancel
// fee there. The contract returns the reward to the client in full.
// `reward` (optional) adds the USDT that returns to the client to the preview —
// not for a Funding order, whose USDT may not have reached it yet.
export const buildCancel = async (a, funding = false, from, reward) => {
  const body = Order.createCellOfCancelOrder({})
  const fees = funding
    ? [await networkFee(a, body, from)]
    : [{ label: t('tx.serviceFee'), ton: CANCEL_FEE_TON }]
  return buildAction(a, body, t('tx.titleCancel'), fees, usdtLine('tx.returnsToYou', funding ? null : reward))
}
// Courier gives up an order they already accepted. The order does NOT close: it
// goes back to Open so another courier can take it. The courier attaches a flat
// 0.2 TON release fee, which is NOT refunded; together with the 0.1 TON accept fee
// (also not refunded) the platform earns ~0.3 TON. The reward and the
// client's create fee stay on the contract for the next courier. Only the order's
// courier may send this.
export const buildCourierRelease = (a) =>
  buildAction(
    a,
    Order.createCellOfCourierRelease({}),
    t('tx.titleRelease'),
    [{ label: t('tx.serviceFee'), ton: RELEASE_FEE_TON }],
    [{ label: t('tx.result'), value: t('tx.orderReopens') }],
  )
// Claim an expired order. Only the CLIENT may send this once the deadline has
// passed; the contract returns the reward to them and sends the remaining buffer
// to the platform (the courier gets nothing, since they did not deliver in time).
// A non-client call is rejected with NotClient (101).
// The client attaches only the network fee (emulated as `from`); the order pays
// the payout.
// `reward` (optional) adds the USDT that returns to the client to the preview.
export const buildClaimExpired = async (a, from, reward) => {
  const body = Order.createCellOfClaimExpired({})
  return buildAction(
    a,
    body,
    t('tx.titleClaim'),
    [await networkFee(a, body, from)],
    usdtLine('tx.returnsToYou', reward),
  )
}
// Pull USDT out of a CLOSED order's wallet (a payout that bounced back, or USDT
// sent there by mistake). Only the order's payee may — the courier of a
// Completed order, the client of a Cancelled / Expired one — and it goes to them.
export const buildRescue = (a, amountUsdt) =>
  buildAction(
    a,
    Order.createCellOfRescue({ amount: toUsdtUnits(amountUsdt) }),
    t('tx.titleRescue'),
    [payoutGas()],
    [{ label: t('tx.amount'), value: amountUsdt + ' USDT' }],
  )

// What the chain says about one order address. Used by the delivery-code
// cleanup, which must never delete the code of an order that is still running —
// so a failed request has to be a DIFFERENT answer from "no such account".
//
//   'live'    — the contract is there and the order is not in a terminal state
//   'closed'  — the contract is there and the order is already terminal
//   'gone'    — the account exists in the chain's records but is not active any
//               more: the order settled and the contract destroyed itself
//   'never'   — the request went through and the chain has never heard of this
//               address: no order was ever deployed there (a create that was
//               signed but never landed leaves such an address behind)
//   'unknown' — the request failed; we know nothing and must keep the code
//
// Returns Map<address, { kind, status }> keyed by the address strings passed in.
export async function classifyOrderAddresses(addresses) {
  const out = new Map()
  if (!addresses?.length) return out

  const CHUNK = 100 // same per-request address limit readOrdersBatch uses
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK)
    const qs = chunk.map((a) => 'address=' + encodeURIComponent(a)).join('&')
    const data = await fetchAccountStates(qs)
    if (!data) {
      // No answer for this chunk: every address in it stays 'unknown'.
      for (const a of chunk) out.set(a, { kind: 'unknown', status: null })
      continue
    }
    // The endpoint returns only accounts the chain knows about, so an address
    // missing from a SUCCESSFUL response is one that never existed.
    const seen = new Map()
    for (const acc of data?.accounts || []) seen.set(rawKey(acc.address), acc)
    for (const a of chunk) {
      const acc = seen.get(rawKey(a))
      if (!acc) {
        out.set(a, { kind: 'never', status: null })
      } else if (acc.status !== 'active') {
        out.set(a, { kind: 'gone', status: null })
      } else if (acc.code_hash !== ORDER_CODE_HASH_B64 || !acc.data_boc) {
        // A live contract we do not recognise (e.g. an order from a previous
        // Order version). Not ours to judge — keep whatever belongs to it.
        out.set(a, { kind: 'live', status: null })
      } else {
        try {
          const s = OrderStorage.fromSlice(Cell.fromBase64(acc.data_boc).beginParse())
          const status = statusName(s.status)
          out.set(a, { kind: isTerminalStatus(status) ? 'closed' : 'live', status })
        } catch {
          out.set(a, { kind: 'unknown', status: null })
        }
      }
    }
  }
  return out
}

// Second, independent check before a "never deployed" verdict may delete a
// delivery code: has this address EVER had a transaction? Resolves true / false
// on a clear answer and null when toncenter cannot answer. A deploy always
// leaves a transaction, so false here backs up what /accountStates said.
export async function hasAnyTransaction(address, attempt = 0) {
  const headers = API_KEY ? { 'X-API-Key': API_KEY } : {}
  try {
    const r = await fetch(
      `${TONCENTER_V3}/transactions?account=${encodeURIComponent(address)}&limit=1`,
      { headers },
    )
    if (r.status === 429 && attempt < 3) {
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt + Math.random() * 400))
      return hasAnyTransaction(address, attempt + 1)
    }
    if (!r.ok) return null
    const data = await r.json()
    if (!Array.isArray(data?.transactions)) return null
    return data.transactions.length > 0
  } catch {
    return null
  }
}
