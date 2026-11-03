// Accept invites. A stranger must not be able to take an order (and lock it), so
// the Order accepts only a courier the client invited: the client's app signs
// AcceptInvite { order, courier, validUntil } with a one-time Ed25519 key made at
// create time, and the courier sends that signature with AcceptOrder. The order
// keeps only the public key (OrderJetton.acceptKey). See Order.tolk.
//
// The key is its own random seed, stored next to the delivery code — NOT derived
// from it: the delivery code is shown to the courier as a QR, and whoever learns
// the invite key can invite themselves.
//
// Pure functions only (no browser APIs beyond crypto.getRandomValues), so the
// invite server (functions/) checks invites with the very same code.
import { Address, beginCell } from '@ton/core'
import nacl from 'tweetnacl'
// The same global Buffer @ton/core uses (polyfills.js in the app,
// bufferPolyfill.js in the Pages function, Node in tests).
const { Buffer } = globalThis

// How long an invite lasts. It is also the most a fooled client can lose beyond
// one delivery time: after it, "release + accept" cannot renew the lock.
export const INVITE_TTL = 60 * 60
// The invite server refuses anything longer (a client app is not trusted).
export const INVITE_MAX_TTL = 2 * 60 * 60

const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'))

// base64url by hand: the browser's Buffer polyfill does not know 'base64url'.
const toB64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')

// A fresh 32-byte seed as 64 hex chars.
export function newInviteSeed() {
  const a = new Uint8Array(32)
  crypto.getRandomValues(a)
  return Buffer.from(a).toString('hex')
}

// The public key the order stores, as the uint256 the contract reads.
export function acceptKeyOf(seedHex) {
  const kp = nacl.sign.keyPair.fromSeed(hexToBytes(seedHex))
  return BigInt('0x' + Buffer.from(kp.publicKey).toString('hex'))
}

// The hash the client signs: the representation hash of the AcceptInvite cell
// (two std addresses + uint32), exactly as the contract builds it.
export function inviteHash(order, courier, validUntil) {
  const hash = beginCell()
    .storeAddress(Address.parse(String(order)))
    .storeAddress(Address.parse(String(courier)))
    .storeUint(validUntil, 32)
    .endCell()
    .hash()
  // A plain Uint8Array: tweetnacl refuses a Buffer from another JS realm.
  return Uint8Array.from(hash)
}

// The signature as the bits512 slice AcceptOrder carries.
export function signatureSlice(signature) {
  return beginCell().storeBuffer(fromB64url(signature)).endCell().beginParse()
}

// The client's signature for `courier` on `order`, base64url (86 chars).
export function signInvite(seedHex, order, courier, validUntil) {
  const kp = nacl.sign.keyPair.fromSeed(hexToBytes(seedHex))
  const sig = nacl.sign.detached(inviteHash(order, courier, validUntil), kp.secretKey)
  return toB64url(sig)
}

// True when `signature` is the order's client's invite for exactly this courier
// and validUntil. `acceptKey` is the order's stored key (bigint or decimal string).
export function verifyInvite({ order, courier, validUntil, signature }, acceptKey) {
  try {
    if (!/^[A-Za-z0-9_-]{86}$/.test(String(signature))) return false
    const sig = fromB64url(signature)
    if (sig.length !== 64) return false
    const key = Buffer.from(BigInt(acceptKey).toString(16).padStart(64, '0'), 'hex')
    return nacl.sign.detached.verify(
      inviteHash(order, courier, Number(validUntil)),
      Uint8Array.from(sig),
      Uint8Array.from(key),
    )
  } catch {
    return false
  }
}
