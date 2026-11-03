import { requestTxPreview } from './txPreview'
import { CONNECT_NETWORK } from './network'

// The single chokepoint for sending TON transactions. It ALWAYS shows the
// preview modal first, then hands the messages to the wallet. Phase 3 calls
// this for every contract action.
//
//   summary:  { title, lines: [{ label, value }] }  — what the modal shows
//   messages: TON Connect message array
//
//   beforeSend: optional async step run after the preview is confirmed and
//               right before the wallet opens; resolving false stops the send.
//
// Returns the wallet result, or null if the user cancels the preview or
// beforeSend stops the send.
export async function sendTx(tonConnectUI, { summary, messages }, beforeSend) {
  const ok = await requestTxPreview(summary)
  if (!ok) return null
  if (beforeSend && !(await beforeSend())) return null
  const stopRetry = retryBridgeOnReturn(tonConnectUI.connector)
  try {
    return await tonConnectUI.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      // Pin the chain so the wallet emulates and sends on the right network.
      // The wallet was already asked to CONNECT on this same chain (see
      // ProofManager.setConnectionNetwork), so this matches and the send is
      // allowed. If the two ever differed, the wallet would block the send.
      network: CONNECT_NETWORK,
      messages,
    })
  } finally {
    stopRetry()
  }
}

// The wallet's answer comes back over the bridge (SSE). When the user leaves
// for the wallet, the SDK closes it; on return it reopens it ONCE and quietly
// gives up if the network is still asleep — then the answer never arrives and
// the "confirm in wallet" window hangs. While we wait for the answer, keep
// reopening it after each return until one attempt succeeds. Attempts run one
// after another: a new one aborts the one still opening. A reopen is safe — the
// SDK resumes from last_event_id, so no answer is lost.
export function retryBridgeOnReturn(connector, { firstDelay = 3000, retryDelay = 3000, attemptLimit = 12000 } = {}) {
  let stopped = false
  let running = false
  let timer = null
  const wait = (ms) => new Promise((r) => { timer = setTimeout(r, ms) })

  async function run() {
    if (running) return
    running = true
    // Let the SDK's own reopen go first; ours then only matters if it failed.
    await wait(firstDelay)
    // Stop if the user left again: the SDK pauses then, and the next return
    // starts a new round.
    while (!stopped && !document.hidden) {
      try {
        await Promise.race([
          connector.unPauseConnection(),
          new Promise((_, reject) => setTimeout(reject, attemptLimit)),
        ])
        break
      } catch {
        if (!stopped) await wait(retryDelay)
      }
    }
    running = false
  }

  const onVisible = () => { if (!document.hidden) run() }
  const tg = window.Telegram?.WebApp
  document.addEventListener('visibilitychange', onVisible)
  tg?.onEvent?.('activated', run)
  return () => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
    tg?.offEvent?.('activated', run)
  }
}
