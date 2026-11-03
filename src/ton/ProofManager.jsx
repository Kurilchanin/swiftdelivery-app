// Wires ton_proof into the connect flow:
//   1. asks the wallet to sign a fresh nonce on connect,
//   2. checks the returned proof structurally,
//   3. rotates the nonce for the next connection.
// Renders nothing.
import { useEffect, useRef } from 'react'
import { useTonConnectUI } from '@tonconnect/ui-react'
import { makeProofPayload, checkProofStructure, setProofStatus } from './proof'
import { CONNECT_NETWORK } from './network'

export default function ProofManager() {
  const [tonConnectUI] = useTonConnectUI()
  const payloadRef = useRef(makeProofPayload())

  useEffect(() => {
    // Pin the chain the wallet connects on. Must be set before connecting.
    // This makes the connected account live on our network, so the network
    // we pin again at send time (see sendTx) always matches and the wallet
    // does not block the transaction.
    //
    // Only while nothing is connected: since SDK 4.x the call THROWS on an
    // already connected wallet ("Cannot change network while wallet is
    // connected", sdk/lib/esm/index.mjs:6486). On a reload the session restore
    // races this effect, and if the restore wins, an unguarded call throws
    // inside the effect and takes the whole app down to a blank screen. An
    // already connected wallet has nothing to pin anyway: it connected on this
    // chain, and every send pins the network again by itself (see sendTx).
    if (!tonConnectUI.connected) {
      tonConnectUI.setConnectionNetwork(CONNECT_NETWORK)
    }

    function requestProof() {
      tonConnectUI.setConnectRequestParameters({
        state: 'ready',
        value: { tonProof: payloadRef.current },
      })
    }
    requestProof()

    const unsub = tonConnectUI.onStatusChange((wallet) => {
      if (!wallet) {
        setProofStatus('none')
        // Rotate the nonce HERE — while no wallet is connected — so the next
        // connection signs a fresh one. Rotating right after a
        // successful connect breaks on Tonkeeper: the wallet can answer
        // the SAME connect request twice (it re-reads the deep link when it is
        // reopened; measured 2026-08-25, two connection-completed events for one
        // connection-started). Both answers carry the proof for the payload we
        // asked for, so rotating on the first one made the second one fail the
        // check and flip the status to 'bad' on a perfectly good connection.
        payloadRef.current = makeProofPayload()
        requestProof()
        return
      }
      const tonProof = wallet.connectItems?.tonProof
      if (tonProof && 'proof' in tonProof) {
        setProofStatus(checkProofStructure(tonProof, payloadRef.current) ? 'ok' : 'bad')
      }
    })
    return unsub
  }, [tonConnectUI])

  return null
}
