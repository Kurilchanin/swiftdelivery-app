// ton_proof: structural check only.
//
// Why not verify the ed25519 signature here? Full verification needs the nonce
// to be issued and stored by a trusted party (a server) so the same proof
// cannot be replayed. We have no backend, so a client-side signature check
// would add code and a crypto dependency without real replay protection.
// Instead we confirm the proof is present, fresh, made for our domain, and
// carries the exact nonce we just generated. This is the agreed Phase 2 scope.
import { useSyncExternalStore } from 'react'

const MAX_AGE = 15 * 60 // seconds

// A 32-byte random nonce as a hex string. Used as the ton_proof payload.
export function makeProofPayload() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

// Check the proof a wallet returned against the nonce we asked it to sign.
export function checkProofStructure(tonProof, expectedPayload) {
  const p = tonProof?.proof
  if (!p) return false
  if (p.payload !== expectedPayload) return false
  if (p.domain?.value && p.domain.value !== window.location.host) return false
  const age = Date.now() / 1000 - Number(p.timestamp)
  return age >= 0 && age < MAX_AGE
}

// Tiny store for the proof status shown on the Profile page.
let status = 'none' // 'none' | 'ok' | 'bad'
const listeners = new Set()

export function setProofStatus(s) {
  status = s
  listeners.forEach((l) => l())
}

export function useProofStatus() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => status,
  )
}
