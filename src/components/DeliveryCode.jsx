// The client's delivery code (a QR) behind two taps. Whoever is the courier and
// gets this code can close the order at once and take the reward, so the code
// is never on screen by default: "Show code" first opens a warning, and only
// "I have the parcel" shows the QR. It hides again on "Hide code" or when the
// page is left. `secret` is the code (hex); `expired` switches the hint for a
// late hand-off after the deadline.
import { useState } from 'react'
import QrCode from './QrCode'
import Icon from './Icon'
import { t } from '../i18n'

export default function DeliveryCode({ secret, expired }) {
  // 'hidden' → 'warn' → 'shown'
  const [view, setView] = useState('hidden')

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
        <div className="actions">
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
