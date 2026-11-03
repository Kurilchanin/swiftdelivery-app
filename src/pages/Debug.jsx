// Diagnostics: a hidden screen that asks Telegram CloudStorage what it really
// holds for this user. Reached by tapping the Profile title five times; there is
// no link to it anywhere. English only on purpose — it is a maintenance tool,
// not part of the product, so it stays out of i18n.
//
// It answers two questions the app cannot answer from localStorage alone:
//   junk — a delivery code is still in the cloud although its order is closed
//          (each one eats a slot of the 1024-key budget);
//   risk — an order is active but has no cloud copy. Each order shows both
//          copies apart: the phone one (localStorage) and the cloud one, so
//          "only on this phone" and "nowhere at all" no longer look the same.
import { useEffect, useState } from 'react'
import { useTonAddress } from '@tonconnect/ui-react'
import { cloudGetKeys, cloudRemove, inTelegram } from '../telegram'
import {
  tracked,
  getSecret,
  secretCloudKey,
  addressFromSecretCloudKey,
  removeSecret,
  reviewCloudSecrets,
  SECRET_KEY_PREFIX,
} from '../contracts/myOrders'
import { shortAddr } from '../utils/security'
import { displayAddr } from '../ton/network'
import { readCspViolations, clearCspViolations } from '../cspReport'

// Telegram's documented per-user key budget.
const KEY_BUDGET = 1024

export default function Debug() {
  const wallet = useTonAddress()
  // undefined = still asking, null = CloudStorage cannot answer, array = answer.
  const [keys, setKeys] = useState(undefined)
  // Chain verdict per cloud key, as returned by reviewCloudSecrets:
  // { key, address, verdict, label, junk }.
  const [checks, setChecks] = useState({})
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  // The one undecided key whose delete button is armed (two taps to delete).
  const [armed, setArmed] = useState(null)
  // CSP violations recorded on this device (see src/cspReport.js).
  const [csp, setCsp] = useState(readCspViolations)

  async function loadKeys() {
    setKeys(await cloudGetKeys())
  }

  useEffect(() => {
    let alive = true
    cloudGetKeys().then((k) => {
      if (alive) setKeys(k)
    })
    return () => {
      alive = false
    }
  }, [])

  const secretKeys = (keys || []).filter((k) => k.startsWith(SECRET_KEY_PREFIX))
  const activeSent = wallet ? tracked(wallet, 'sent') : []

  // Ask the chain about every stored code. reviewCloudSecrets does it in one
  // batched request and is the same call the My Orders sync runs, so this screen
  // and the automatic cleanup can never disagree about what is junk.
  async function checkChain() {
    setChecking(true)
    try {
      const rows = await reviewCloudSecrets()
      const out = {}
      for (const row of rows || []) out[row.key] = row
      setChecks(out)
    } finally {
      setChecking(false)
    }
  }

  const junkKeys = secretKeys.filter((k) => checks[k]?.junk)

  // Delete only what the chain proved is closed (junk). The My Orders sync does
  // the same thing on its own; this button is for doing it right now.
  async function cleanJunk() {
    setBusy(true)
    try {
      for (const key of junkKeys) {
        const addr = addressFromSecretCloudKey(key)
        if (addr) removeSecret(addr)
        else await cloudRemove(key)
      }
      setChecks({})
      await loadKeys()
    } finally {
      setBusy(false)
    }
  }

  // Single key, deleted against our own advice: for keys the chain would not
  // talk about, and for addresses where no order was ever deployed. Armed by a
  // first tap so it cannot happen by accident.
  async function deleteOne(key) {
    setBusy(true)
    try {
      const addr = addressFromSecretCloudKey(key)
      if (addr) removeSecret(addr)
      else await cloudRemove(key)
      setArmed(null)
      setChecks({})
      await loadKeys()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <h1 className="page-title">diagnostics</h1>

      <div className="card">
        <h2 className="card-title">Content-Security-Policy ({csp.length})</h2>
        <p className="hint">
          Violations seen on this device since the last clear. The policy is
          enforced, so each one is something the browser blocked. It should stay
          at 0.
        </p>
        {csp.length === 0 && <p>No violations.</p>}
        {csp.map((v, i) => (
          <p key={i} className="debug-row">
            {new Date(v.at).toLocaleString()} — {v.directive}: {v.blocked || '(inline)'}
          </p>
        ))}
        <div className="debug-actions">
          <button className="btn" onClick={() => setCsp(readCspViolations())}>
            re-read
          </button>
          <button
            className="btn btn-danger"
            disabled={!csp.length}
            onClick={() => {
              clearCspViolations()
              setCsp([])
            }}
          >
            clear
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Storage</h2>
        <p>In Telegram: {inTelegram ? 'yes' : 'no'}</p>
        <p>
          CloudStorage:{' '}
          {keys === undefined ? 'asking…' : keys === null ? 'no answer' : 'answered'}
        </p>
        {Array.isArray(keys) && (
          <p>
            Keys used: {keys.length} / {KEY_BUDGET} (delivery codes: {secretKeys.length})
          </p>
        )}
        {keys === null && (
          <p className="hint">
            This client has no CloudStorage, or the app runs outside Telegram. Codes are
            kept on this device only.
          </p>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">Active sent orders ({activeSent.length})</h2>
        {!wallet && <p className="hint">Connect a wallet to see them.</p>}
        {wallet && activeSent.length === 0 && <p className="hint">None tracked here.</p>}
        {/* tracked() gives plain address strings, not objects. Reading `.address`
            off them fed undefined into secretCloudKey, which threw during render
            and left the whole app on a black screen — but only for a wallet that
            actually had a tracked order, which is why it hid for so long. */}
        {activeSent.map((addr) => {
          const onPhone = Boolean(getSecret(wallet, addr))
          const inCloud = secretKeys.includes(secretCloudKey(addr))
          return (
            <p key={addr} className="debug-row">
              {shortAddr(displayAddr(addr, 'contract'))} — phone: {onPhone ? 'yes' : <span className="error">no</span>}
              {' · '}cloud: {inCloud ? 'yes' : <span className="error">no</span>}
              {!onPhone && !inCloud && <span className="error"> — code lost</span>}
            </p>
          )
        })}
      </div>

      <div className="card">
        <h2 className="card-title">Codes in cloud ({secretKeys.length})</h2>
        {keys === undefined && <p className="hint">Loading…</p>}
        {Array.isArray(keys) && secretKeys.length === 0 && (
          <p className="hint">No delivery codes stored.</p>
        )}
        {secretKeys.map((key) => {
          const c = checks[key]
          return (
            <div key={key} className="debug-row">
              <div className="debug-key">{key}</div>
              <div className="hint">{c ? c.verdict + ' — ' + c.label : 'not checked'}</div>
              {c && !c.junk && c.verdict !== 'active' && (
                <button
                  className="btn btn-danger"
                  disabled={busy}
                  onClick={() => (armed === key ? deleteOne(key) : setArmed(key))}
                >
                  {armed === key ? 'tap again to delete' : 'delete anyway'}
                </button>
              )}
            </div>
          )
        })}
        <div className="debug-actions">
          <button className="btn" disabled={checking || busy || !secretKeys.length} onClick={checkChain}>
            {checking ? 'checking…' : 'check on chain'}
          </button>
          <button
            className="btn btn-danger"
            disabled={busy || checking || junkKeys.length === 0}
            onClick={cleanJunk}
          >
            clean junk ({junkKeys.length})
          </button>
        </div>
      </div>
    </div>
  )
}
