// Profile: the TON wallet (real TON Connect) and the Telegram identity.
import { useEffect, useRef, useState } from 'react'
import {
  useTonConnectUI,
  useTonAddress,
  useTonWallet,
} from '@tonconnect/ui-react'
import { shortAddr, sanitizeText } from '../utils/security'
import { getUser, inTelegram, isInitDataFresh, openTelegramLink } from '../telegram'
import { hasTelegramUsername } from '../contact'
import { referralLink } from '../referral'
import { navigate } from '../router'
import { t, LANG } from '../i18n'
import ExtLink from '../components/ExtLink'
import Icon from '../components/Icon'

import { fetchBalance } from '../ton/balance'
import { fetchUsdtBalance } from '../ton/jetton'
import { NETWORK, displayAddr } from '../ton/network'

// Support chat. Opened via openTelegramLink (like other t.me contact links in
// this app), not a plain <a>, so Telegram handles the navigation itself.
const SUPPORT_URL = 'https://t.me/SwiftDelivery_support'

export default function Profile() {
  const user = getUser()
  const [tonConnectUI] = useTonConnectUI()
  const address = useTonAddress() // friendly address, or '' when not connected
  const wallet = useTonWallet()
  // Keep the balance tied to the address it was fetched for, so a stale value
  // never shows after the wallet changes.
  const [bal, setBal] = useState({ addr: null, value: null, usdt: null })
  const [copied, setCopied] = useState(false)
  // Taps on the page title. Five in a row open the hidden diagnostics screen —
  // inside Telegram the address bar is not reachable, so a gesture is the only
  // way in, and five taps is far past anything a normal user does by accident.
  const taps = useRef(0)

  useEffect(() => {
    if (!address) return
    let alive = true
    Promise.all([fetchBalance(address), fetchUsdtBalance({ owner: address })]).then(
      ([value, usdt]) => {
        if (alive) setBal({ addr: address, value, usdt })
      },
    )
    return () => {
      alive = false
    }
  }, [address])

  const balance = bal.addr === address ? bal.value : null
  const usdtBalance = bal.addr === address ? bal.usdt : null
  const refLink = address ? referralLink(address) : null

  // Terms/Privacy pages live next to index.html. Russian UI gets the Russian
  // copies; every other language gets English.
  const legalHref = (doc) =>
    new URL(doc + (LANG === 'ru' ? '-ru' : '') + '.html', window.location.href)
      .href

  // Telegram's built-in share screen (chat picker) with the link prefilled.
  function shareLink() {
    openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(refLink))
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(refLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable — the link is shown on screen, copy by hand
    }
  }

  return (
    <div className="page">
      <h1
        className="page-title"
        onClick={() => {
          taps.current += 1
          if (taps.current >= 5) {
            taps.current = 0
            navigate('/debug')
          }
        }}
      >
        {t('profile.title')}
      </h1>

      {/* Wallet: the USDT balance is the big number, GRAM (fees) under it. */}
      <div className="card wallet-card">
        <div className="row card-head">
          <span className="tile">
            <Icon name="wallet" />
          </span>
          <span className="row-body">
            <span className="row-title">{t('profile.tonWallet')}</span>
            {address && (
              <span className="row-sub">
                <bdi className="mono">{shortAddr(displayAddr(address, 'wallet'))}</bdi>
                {' · '}
                {wallet?.device?.appName ? wallet.device.appName + ' · ' : ''}
                {NETWORK}
              </span>
            )}
          </span>
        </div>
        {address ? (
          <>
            <p className="wallet-label">{t('profile.usdtBalance')}</p>
            <p className="wallet-amount">
              <bdi>
                {usdtBalance == null ? '…' : usdtBalance.toFixed(2)}
                <small>USDT</small>
              </bdi>
            </p>
            <p className="wallet-sub">
              {t('profile.balance')}:{' '}
              <bdi>{balance == null ? '…' : balance.toFixed(2) + ' GRAM'}</bdi>
            </p>
            <button className="btn" onClick={() => tonConnectUI.disconnect()}>
              {t('profile.disconnect')}
            </button>
          </>
        ) : (
          <>
            <p className="hint card-note">
              {t('profile.connectHint')}
            </p>
            <button className="btn btn-primary" onClick={() => tonConnectUI.openModal()}>
              <Icon name="wallet" size={20} />
              {t('profile.connect')}
            </button>
          </>
        )}
      </div>

      {/* Telegram identity, as one row with the first letter as the avatar. */}
      <div className="group">
        <div className="row">
          <span className="avatar" aria-hidden="true">
            {user ? sanitizeText(user.first_name || '?', 100).slice(0, 1).toUpperCase() : <Icon name="send" />}
          </span>
          <span className="row-body">
            {user ? (
              <>
                <span className="row-title">
                  {sanitizeText(user.first_name || '', 100)}{' '}
                  {sanitizeText(user.last_name || '', 100)}
                </span>
                {hasTelegramUsername() ? (
                  <span className="row-sub">@{sanitizeText(user.username, 100)}</span>
                ) : (
                  <span className="row-sub error">{t('profile.noUsername')}</span>
                )}
                {!isInitDataFresh() && (
                  <span className="row-sub error">{t('profile.oldSession')}</span>
                )}
              </>
            ) : (
              <>
                <span className="row-title">{t('profile.telegram')}</span>
                <span className="row-sub">
                  {inTelegram ? t('profile.noUserData') : t('profile.openInTelegram')}
                </span>
              </>
            )}
          </span>
        </div>
      </div>

      <div className="card">
        <div className="row card-head">
          <span className="tile">
            <Icon name="link" />
          </span>
          <span className="row-body">
            <span className="row-title">{t('profile.referral')}</span>
          </span>
        </div>
        {address ? (
          <>
            <p className="hint card-note">
              {t('profile.referralHint')}
            </p>
            <p className="link-field mono">{refLink}</p>
            <div className="actions-row">
              <button className="btn" onClick={shareLink}>
                <Icon name="share" size={20} />
                {t('profile.referralShare')}
              </button>
              <button className="btn" onClick={copyLink}>
                <Icon name={copied ? 'check' : 'copy'} size={20} />
                {copied ? t('profile.referralCopied') : t('profile.referralCopy')}
              </button>
            </div>
          </>
        ) : (
          <p className="hint card-note">
            {t('profile.referralConnectHint')}
          </p>
        )}
      </div>

      {/* Support: the whole row opens the chat. */}
      <div className="group">
        <button
          type="button"
          className="row"
          aria-label={t('profile.supportOpen')}
          onClick={() => openTelegramLink(SUPPORT_URL)}
        >
          <span className="tile">
            <Icon name="help" />
          </span>
          <span className="row-body">
            <span className="row-title">{t('profile.support')}</span>
            <span className="row-sub">{t('profile.supportHint')}</span>
          </span>
          <span className="row-end">
            <Icon name="external" />
          </span>
        </button>
      </div>

      <p className="hint legal-links">
        <ExtLink href={legalHref('terms')}>{t('profile.terms')}</ExtLink>
        {' · '}
        <ExtLink href={legalHref('privacy')}>{t('profile.privacy')}</ExtLink>
      </p>
    </div>
  )
}
