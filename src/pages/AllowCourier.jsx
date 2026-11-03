// Allow a courier: the client lands here from a courier's request link
// (?startapp=rq_<courier>, see orderLink.js), picks one of their open orders and
// lets that courier accept it. The app signs an invite with the order's invite
// key (see invite.js) — no wallet, no transaction — and leaves it on the invite
// server, where the courier's app picks it up.
import { useEffect, useState } from 'react'
import { useTonAddress, useTonConnectUI } from '@tonconnect/ui-react'
import { Address } from '@ton/core'
import { readOrders, sameAddress, STATUS } from '../contracts/orders'
import { tracked, getSecret, recoverSecret, inviteSeedOf } from '../contracts/myOrders'
import { recoverActiveSent } from '../contracts/historyScanner'
import { INVITE_TTL, signInvite, verifyInvite } from '../contracts/invite'
import { putInvite } from '../contracts/inviteApi'
import { orderLink } from '../orderLink'
import { openTelegramLink } from '../telegram'
import { sanitizeText, shortAddr } from '../utils/security'
import { displayAddr } from '../ton/network'
import { t } from '../i18n'
import Icon from '../components/Icon'

const clock = (unix) =>
  new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// The client's open orders, from this device's list first, then from the chain.
async function openOrdersOf(wallet) {
  const mine = (list) =>
    list.filter((o) => o.status === STATUS.Open && sameAddress(o.client, wallet))
  const local = mine(await readOrders(tracked(wallet, 'sent')))
  if (local.length) return local
  return mine(await recoverActiveSent(wallet))
}

export default function AllowCourier({ courier }) {
  const wallet = useTonAddress()
  const [tonConnectUI] = useTonConnectUI()
  const [orders, setOrders] = useState(null) // null = loading
  const [busy, setBusy] = useState(null) // address being signed
  const [done, setDone] = useState({}) // address → validUntil
  const [error, setError] = useState('')

  useEffect(() => {
    if (!wallet) return
    let alive = true
    openOrdersOf(wallet)
      .then((list) => alive && setOrders(list))
      .catch(() => alive && setOrders([]))
    return () => {
      alive = false
    }
  }, [wallet])

  async function allow(order) {
    setError('')
    setBusy(order.address)
    try {
      const seed = inviteSeedOf(getSecret(wallet, order.address) || (await recoverSecret(wallet, order.address)))
      if (!seed) return setError(t('allow.noKey'))
      const validUntil = Math.floor(Date.now() / 1000) + INVITE_TTL
      const invite = {
        order: order.address,
        courier,
        validUntil,
        signature: signInvite(seed, order.address, courier, validUntil),
      }
      // A seed that is not this order's key (an old or mixed-up code) would only
      // make an invite the order refuses.
      if (!verifyInvite(invite, order.acceptKey)) return setError(t('allow.noKey'))
      const res = await putInvite(order.address, invite)
      if (res.ok) setDone((d) => ({ ...d, [order.address]: validUntil }))
      else setError(res.status === 429 ? t('allow.tooSoon') : t('allow.failed'))
    } finally {
      setBusy(null)
    }
  }

  function sendLink(order) {
    openTelegramLink(
      'https://t.me/share/url?url=' + encodeURIComponent(orderLink(order.address)) +
        '&text=' + encodeURIComponent(t('allow.shareText', { area: sanitizeText(order.area, 200) })),
    )
  }

  // A broken link: say so instead of failing on the address below.
  let courierOk = true
  try {
    Address.parse(courier)
  } catch {
    courierOk = false
  }
  if (!courierOk) {
    return (
      <div className="page">
        <p className="error">{t('allow.badLink')}</p>
      </div>
    )
  }
  const who = shortAddr(displayAddr(courier, 'wallet'))

  return (
    <div className="page">
      <h1 className="page-title">{t('allow.title')}</h1>
      <p className="hint">{t('allow.intro', { courier: who })}</p>
      <p className="hint">{t('allow.warn')}</p>

      {!wallet && (
        <div className="actions">
          <p className="hint">{t('allow.connect')}</p>
          <button className="btn btn-primary" onClick={() => tonConnectUI.openModal()}>
            {t('profile.connect')}
          </button>
        </div>
      )}

      {wallet && sameAddress(wallet, courier) && <p className="error">{t('allow.self')}</p>}
      {wallet && orders === null && <p className="empty">{t('allow.loading')}</p>}
      {wallet && orders?.length === 0 && <p className="empty">{t('allow.none')}</p>}

      <div role="status" aria-live="polite">
        {error && <p className="error">{error}</p>}
      </div>

      {wallet &&
        !sameAddress(wallet, courier) &&
        orders?.map((o) => (
          <div className="card" key={o.address}>
            <h2 className="card-title">
              {t('label.to')}: {sanitizeText(o.area, 200)} · <bdi>{o.reward} USDT</bdi>
            </h2>
            <p className="desc">{sanitizeText(o.description, 500)}</p>
            {done[o.address] ? (
              <>
                <p className="proof-ok">
                  <Icon name="check" size={20} />
                  {t('allow.done', { time: clock(done[o.address]) })}
                </p>
                <button className="btn" onClick={() => sendLink(o)}>
                  <Icon name="send" size={20} />
                  {t('allow.sendLink')}
                </button>
              </>
            ) : (
              <button className="btn btn-primary" disabled={busy !== null} onClick={() => allow(o)}>
                {t('allow.button')}
              </button>
            )}
          </div>
        ))}
    </div>
  )
}
