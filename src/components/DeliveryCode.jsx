// The client's delivery code (a QR) behind two taps. Whoever is the courier and
// gets this code can close the order at once and take the reward, so the code
// is never on screen by default: "Show code" first opens a warning, and only
// "I have the parcel" shows the QR. It hides again on "Hide code" or when the
// page is left. `secret` is the code (hex); `expired` switches the hint for a
// late hand-off after the deadline. When the client is not at the door, the same
// code can be copied or sent to the courier in Telegram as text — `courierChat`
// is the courier's t.me link (null when they have no @username: then Telegram's
// share screen lets the client pick the chat).
import { useState } from 'react'
import QrCode from './QrCode'
import Icon from './Icon'
import { t } from '../i18n'
import { openTelegramLink } from '../telegram'

export default function DeliveryCode({ secret, expired, courierChat }) {
  // 'hidden' → 'warn' → 'shown'
  const [view, setView] = useState('hidden')
  const [copied, setCopied] = useState(false)

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable — the code is shown on screen, copy by hand
    }
  }

  // Only the bare code goes into the message, so the courier can paste it as is.
  function sendCode() {
    openTelegramLink(
      courierChat
        ? courierChat + '?text=' + encodeURIComponent(secret)
        : 'https://t.me/share/url?url=' + encodeURIComponent(secret),
    )
  }

  if (view === 'warn') {
    return (
      <>
        <p className="code-warn" role="alert">
          <Icon name="shield" size={20} />
          <span>{t('order.codeWarn')}</span>
        </p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => setView('shown')}>
            {t('order.codeWarnConfirm')}
          </button>
          <button type="button" className="btn" onClick={() => setView('hidden')}>
            {t('order.codeWarnCancel')}
          </button>
        </div>
      </>
    )
  }

  if (view === 'shown') {
    return (
      <>
        <QrCode text={secret} />
        {expired ? (
          <p className="hint">{t('order.showCodeExpired')}</p>
        ) : (
          <p className="hint">{t('order.showCodeHint')}</p>
        )}
        <p className="code-text">{secret}</p>
        <div className="actions">
          <button type="button" className="btn" onClick={copyCode}>
            <Icon name={copied ? 'check' : 'copy'} size={20} />
            {copied ? t('order.codeCopied') : t('order.codeCopy')}
          </button>
          <button type="button" className="btn" onClick={sendCode}>
            <Icon name="send" size={20} />
            {t('order.codeSendTg')}
          </button>
          <button type="button" className="btn" onClick={() => setView('hidden')}>
            {t('order.codeHide')}
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <p className="hint">{expired ? t('order.showCodeExpired') : t('order.handoffHint')}</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={() => setView('warn')}>
          <Icon name="scan" size={20} />
          {t('order.codeShow')}
        </button>
      </div>
    </>
  )
}
