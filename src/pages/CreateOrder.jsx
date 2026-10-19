// Create Order: the client writes the order and locks a reward in escrow.
import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import { useTonConnectUI, useTonAddress, UserRejectsError } from '@tonconnect/ui-react'
import { navigate } from '../router'
import { sanitizeText } from '../utils/security'
import { confirmAction, inTelegram } from '../telegram'
import { sendTx } from '../ton/tx'
import { gramLabel } from '../ton/price'
import { usdtWalletOf, fetchUsdtBalance } from '../ton/jetton'
import { fetchBalance } from '../ton/balance'
import { t, durationWords } from '../i18n'
import {
  buildCreateOrder,
  getMarketplaceOwner,
  normalizeCity,
  filterCityInput,
  filterPlaceInput,
  MIN_REWARD_USD,
  DAY_SECONDS,
  DELIVERY_DAYS_MIN,
  DELIVERY_DAYS_MAX,
  CREATE_FEE_TON,
  DEFAULT_ORIGIN,
} from '../contracts/orders'
import { NETWORK } from '../ton/network'
import Icon from '../components/Icon'
import { track, saveSnapshot, saveSecret, removeSecret } from '../contracts/myOrders'
import {
  getMyContact,
  packContact,
  hasTelegramUsername,
  usernameRequirementMet,
} from '../contact'

// Input limits. The description is stored on-chain as a snake of cells (~127
// bytes each), so a short cap keeps gas and storage rent low: 250 chars is a
// few cells. This does NOT affect the storage-cell overflow fix — the
// description is a separate ref, never part of the root cell's 1023-bit budget.
const MAX_DESC = 250

// Keep only digits and one dot (a comma counts as the dot), at most 6 decimals
// like USDT itself, so letters never show up in the reward field.
function cleanAmount(v) {
  const [int, ...rest] = v.replace(',', '.').replace(/[^\d.]/g, '').split('.')
  return rest.length ? `${int}.${rest.join('').slice(0, 6)}` : int
}

// The public cities are just names, so the cap can be small. The client types any
// city freely (there is no dropdown here — that is a view-side filter). MAX_AREA
// caps both the "to" (destination city) and the "from" (origin), which can be
// any place — a city, a shop, a landmark — not only a city.
const MAX_AREA = 64

// Reward minimum, in USDT (≈ USD) — MIN comes from orders.js so the
// contract-facing layer owns the policy. Above this amount we ask "are you
// sure?" before sending.
const SOFT_CONFIRM_USD = 500

// The delivery times the client can pick, in whole days (1..14).
const DELIVERY_DAY_CHOICES = Array.from(
  { length: DELIVERY_DAYS_MAX - DELIVERY_DAYS_MIN + 1 },
  (_, i) => DELIVERY_DAYS_MIN + i,
)

// The form draft, kept for the session: leaving the tab (to connect a wallet,
// to check the feed) must not wipe what the client typed. Cleared once the
// order is sent.
const DRAFT_KEY = 'swiftparcel.createDraft'
function readDraft() {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || 'null') || {}
  } catch {
    return {}
  }
}
function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    // storage unavailable — nothing was saved
  }
}

export default function CreateOrder() {
  const [tonConnectUI] = useTonConnectUI()
  const wallet = useTonAddress()
  const [draft] = useState(readDraft)
  const [description, setDescription] = useState(draft.description || '')
  const descRef = useRef(null)

  // Grow the box with the text, so all of it is visible without scrolling.
  useLayoutEffect(() => {
    const el = descRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [description])
  const [area, setArea] = useState(draft.area || '') // "to" — destination city
  const [origin, setOrigin] = useState(draft.origin || '') // "from" — origin place (city/shop/landmark); blank = All world
  const [usdt, setUsdt] = useState(draft.usdt || '')
  // How many days the courier gets once they accept. The longest by default (as
  // before); a quick city run can pick less, so a courier who takes the order and
  // disappears locks the reward for a day, not two weeks.
  const [days, setDays] = useState(
    DELIVERY_DAY_CHOICES.includes(draft.days) ? draft.days : DELIVERY_DAYS_MAX,
  )
  const [error, setError] = useState('')
  // The field the error is about ('desc' | 'area' | 'reward'), so that field is
  // marked invalid and points screen readers at the message.
  const [errField, setErrField] = useState('')
  const [busy, setBusy] = useState(false)
  // The client's balances, tied to the wallet they were read for: USDT pays the
  // reward, GRAM the fees. null = unknown (still loading, or the read failed).
  const [bal, setBal] = useState({ addr: null, usdt: null, gram: null })

  // The reward is typed in USDT and locked as is — no price conversion. The same
  // number goes into both the transfer and the address computation (the reward
  // is part of the order's init data), both through toUsdtUnits.
  const rewardNum = Number(usdt)
  // Native coin the create transfer carries: exactly the create fee, network included.
  const attachTon = CREATE_FEE_TON
  const myBal = bal.addr === wallet ? bal : { usdt: null, gram: null }
  const rewardPlaceholder = t('create.rewardPlaceholder', { min: MIN_REWARD_USD })
  const hasUsername = hasTelegramUsername()
  const requirementMet = usernameRequirementMet()

  // Warm the marketplace-owner cache as soon as the form opens. The owner is part
  // of each order's init data, so the address computation needs it. Resolving it
  // up front makes that computation a local, no-network step at create time —
  // which is what lets us save the delivery secret reliably right after sending.
  // Fire-and-forget: the create flow re-resolves (with retries) anyway.
  useEffect(() => {
    getMarketplaceOwner()
  }, [])

  // Read the balances once per wallet, so the form can say up front that the
  // client is short of USDT, or of GRAM for the fees.
  useEffect(() => {
    if (!wallet) return
    let alive = true
    Promise.all([fetchUsdtBalance({ owner: wallet }), fetchBalance(wallet)]).then(([u, g]) => {
      if (alive) setBal({ addr: wallet, usdt: u, gram: g })
    })
    return () => {
      alive = false
    }
  }, [wallet])

  // Keep the draft as the client types (see DRAFT_KEY).
  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ description, area, origin, usdt, days }))
    } catch {
      // storage unavailable — the form still works, only the draft is not kept
    }
  }, [description, area, origin, usdt, days])

  // Show an error, marking the field it is about (if any).
  function fail(message, field = '') {
    setError(message)
    setErrField(field)
  }
  const errProps = (field) =>
    errField === field ? { 'aria-invalid': true, 'aria-describedby': 'create-error' } : {}

  async function submit(e) {
    e.preventDefault()
    fail('')

    if (!wallet) return fail(t('create.errConnectWallet'))
    if (!requirementMet) return fail(t('create.errUsername'))

    const desc = sanitizeText(description, MAX_DESC)
    // Normalize the cities (trim + collapse spaces) so the same city written
    // slightly differently still groups together in the Feed filter.
    const pubArea = normalizeCity(sanitizeText(area, MAX_AREA)) // "to"
    // "from" is optional: if the client leaves it blank, the parcel can start
    // anywhere, so we store the default "All world" on-chain.
    const pubOrigin = normalizeCity(sanitizeText(origin, MAX_AREA)) || DEFAULT_ORIGIN

    if (!desc) return fail(t('create.errDesc'), 'desc')
    if (!pubArea) return fail(t('create.errCity'), 'area')
    if (!(rewardNum >= MIN_REWARD_USD)) return fail(t('create.errMin', { min: MIN_REWARD_USD }), 'reward')
    // Short of USDT the transfer would fail in the wallet; short of GRAM the
    // wallet cannot even pay its fee. Say so here. An unknown balance does not
    // block — the wallet itself has the last word.
    if (myBal.usdt != null && myBal.usdt < rewardNum) {
      return fail(t('create.errNoUsdt', { have: myBal.usdt, need: rewardNum }), 'reward')
    }
    if (myBal.gram != null && myBal.gram < attachTon) {
      return fail(t('create.errNoGram', { need: gramLabel(attachTon) }))
    }

    if (rewardNum > SOFT_CONFIRM_USD) {
      const ok = await confirmAction(t('create.confirmLarge', { usdt: rewardNum }))
      if (!ok) return
    }

    setBusy(true)
    try {
      // The street address stays off-chain (Phase: shared with the courier
      // later). Only desc + public area go into the order. The client's Telegram
      // contact goes in too, so the courier can message them once accepted.
      const clientContact = packContact(getMyContact())
      // The transfer goes to the client's OWN USDT wallet; ask the USDT master
      // for its address before anything is signed.
      const usdtWallet = await usdtWalletOf(wallet)
      const tx = await buildCreateOrder({
        reward: rewardNum,
        deliveryTime: days * DAY_SECONDS,
        description: desc,
        area: pubArea,
        origin: pubOrigin,
        clientContact,
        client: wallet,
        usdtWallet,
      })
      // buildCreateOrder computed the order address before anything is signed
      // (the transfer needs it), so if it could not be resolved it has already
      // thrown here, before any money is locked.
      const orderAddr = tx.orderAddress

      // Save the delivery code BEFORE the wallet opens, not after it answers. The
      // courier cannot be paid without it: we show it to them as a QR at hand-off
      // (see OrderDetail). While the client signs in the wallet app, the phone can
      // kill Telegram (low memory), or the connection can drop, and the answer
      // never comes back — the order lands on chain, but a code held only in
      // memory is gone for good. So both copies are written now, and inside
      // Telegram the wallet does not open until the cloud copy is confirmed by a
      // read-back: an order whose code lives on this phone only is never sent.
      // Outside Telegram there is no cloud, and the local copy is all we have.
      //
      // It runs after the preview is confirmed (beforeSend), not before it: the
      // cloud copy carries its write time, and the cleanup trusts that time to be
      // at most a few minutes before the transaction's validUntil. A preview left
      // open for a day must not make a fresh code look a day old.
      let backupFailed = false
      const backup = async () => {
        if ((await saveSecret(wallet, orderAddr, tx.secret)) || !inTelegram) return true
        backupFailed = true
        removeSecret(orderAddr) // nothing was sent; a late cloud write is swept later
        return false
      }

      let res
      try {
        res = await sendTx(tonConnectUI, tx, backup)
      } catch (err) {
        // The wallet was opened, so from here the code is NEVER deleted on the
        // spot, whatever the error. Closing the "confirm in wallet" window, a
        // dropped connection or a lost answer do not mean nothing was sent: the
        // wallet may already have broadcast the transaction, and the order then
        // appears on chain a moment later (My Orders finds it from the chain).
        // A code of a create that truly never landed is removed by the cloud
        // cleanup a day later, once the chain proves it (sweepCloudSecrets).
        if (err instanceof UserRejectsError) throw err
        const e = err instanceof Error ? err : new Error(String(err))
        e.walletNoAnswer = true
        throw e
      }
      if (backupFailed) return fail(t('create.errBackup'))
      if (!res) return // user cancelled the preview — no code was saved yet

      // Remember the order we just created so My Orders can show it.
      track(wallet, orderAddr, 'sent')
      // Save an optimistic snapshot so the order shows in My Orders → Sent right
      // away, before its contract is deployed and readable on chain.
      saveSnapshot(
        wallet,
        {
          address: orderAddr,
          client: wallet,
          courier: null,
          description: desc,
          area: pubArea,
          origin: pubOrigin,
          clientContact,
          courierContact: '',
          reward: rewardNum,
          // Deployed Funding; it turns Open a few seconds later, when its USDT lands.
          status: 'Funding',
          nonce: tx.nonce,
          createdAt: tx.createdAt,
          deliveryTime: tx.deliveryTime,
        },
        'sent',
      )
      clearDraft()
      navigate('/my')
    } catch (err) {
      // Keep the real error in the console so we can tell apart a user reject,
      // a wrong-network wallet, and a true failure.
      console.error('Create order failed:', err)
      const text = String(err?.message || err || '')
      if (err?.walletNoAnswer && !/network|chain/i.test(text)) {
        // The wallet did not clearly say no: the order may exist after all.
        fail(t('create.errNoAnswer'))
      } else if (/network|chain/i.test(text)) {
        fail(t('create.errWrongNetwork', { network: NETWORK }))
      } else if (/reject|cancel|declined/i.test(text)) {
        fail('') // user dismissed the wallet — no error to show
      } else {
        fail(t('create.errSend'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <h1 className="page-title">{t('create.title')}</h1>
      <form className="form" onSubmit={submit}>
        {/* From | To side by side, like a swap's pair. Each input keeps its full
            field name for screen readers; the short label is what shows. */}
        <div className="route">
          <label className="route-cell">
            <span className="route-label">{t('label.from')}</span>
            <input
              type="text"
              value={origin}
              maxLength={MAX_AREA}
              placeholder={DEFAULT_ORIGIN}
              aria-label={t('create.fromField')}
              onChange={(e) => setOrigin(filterPlaceInput(e.target.value))}
            />
          </label>
          <span className="route-seam" aria-hidden="true">
            <Icon name="arrow" size={18} />
          </span>
          <label className="route-cell">
            <span className="route-label">{t('label.to')}</span>
            <input
              type="text"
              value={area}
              maxLength={MAX_AREA}
              placeholder={t('create.toPlaceholder')}
              aria-label={t('create.toField')}
              onChange={(e) => setArea(filterCityInput(e.target.value))}
              {...errProps('area')}
            />
          </label>
        </div>
        <p className="hint">
          {t('create.fromHint', { origin: DEFAULT_ORIGIN })} {t('create.fromLatinHint')}
        </p>
        <p className="hint">
          {t('create.toHint')} {t('create.cityLatinHint')}
        </p>

        <label className="field">
          <span className="field-label">{t('create.whatToDeliver')}</span>
          <textarea
            ref={descRef}
            value={description}
            maxLength={MAX_DESC}
            rows={3}
            placeholder={t('create.descPlaceholder')}
            onChange={(e) => setDescription(e.target.value)}
            {...errProps('desc')}
          />
          <span className="counter">
            {description.length}/{MAX_DESC}
          </span>
        </label>
        <p className="hint">{t('create.descHint')}</p>

        {/* The reward as one big number, like the amount on a swap screen. */}
        <label className="amount">
          <span className="amount-label">{t('create.rewardField')}</span>
          <span className="amount-line">
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={usdt}
              placeholder={rewardPlaceholder}
              // The field is as wide as its number, so "USDT" sits right after it.
              style={{ width: (usdt ? Math.max(2, usdt.length) + 0.6 : rewardPlaceholder.length * 0.6 + 0.6) + 'ch' }}
              onChange={(e) => setUsdt(cleanAmount(e.target.value))}
              {...errProps('reward')}
            />
            <span className="amount-unit">USDT</span>
          </span>
          {myBal.usdt != null && (
            <span className="hint">{t('create.usdtBalance', { bal: myBal.usdt.toFixed(2) })}</span>
          )}
        </label>

        <label className="field">
          <span className="field-label">{t('create.deliveryField')}</span>
          <span className="select-wrap">
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {DELIVERY_DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {durationWords(d, 'day')}
                </option>
              ))}
            </select>
            <Icon name="down" size={20} />
          </span>
        </label>

        {/* What the client pays and locks, in one place, right above the button. */}
        <dl className="meta summary">
          <div>
            <dt>{t('meta.reward')}</dt>
            <dd>
              <bdi>{rewardNum > 0 ? rewardNum + ' USDT' : '—'}</bdi>
            </dd>
          </div>
          <div>
            <dt>{t('tx.serviceFee')}</dt>
            <dd>
              <bdi>{gramLabel(CREATE_FEE_TON)}</bdi>
            </dd>
          </div>
          <div>
            <dt>{t('meta.deliveryTime')}</dt>
            <dd>
              <bdi>{durationWords(days, 'day')}</bdi>
            </dd>
          </div>
        </dl>
        <p className="hint">{t('create.summaryHint')}</p>

        <p className="notice">
          <Icon name="shield" size={20} />
          <span>{t('create.codeHint')}</span>
        </p>

        {/* Without a @username the red bar at the top of this page says so. */}
        {hasUsername && <p className="hint">{t('create.usernameShared')}</p>}

        {error && (
          <p id="create-error" className="error" role="alert">
            {error}
          </p>
        )}

        {/* No wallet yet: connect right here, the draft stays as it is. */}
        {wallet ? (
          <button type="submit" className="btn btn-primary" disabled={busy || !requirementMet}>
            {busy ? t('create.sending') : t('create.submit')}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => tonConnectUI.openModal()}>
            <Icon name="wallet" size={20} />
            {t('profile.connect')}
          </button>
        )}
      </form>
    </div>
  )
}
