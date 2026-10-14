// Welcome: a one-time intro screen for a first visit. It says in a few lines
// what the app is for and how an order goes, then steps aside for good. The
// "seen" mark lives in localStorage; if storage is blocked the screen simply
// shows again next time, which is harmless.
import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'
import { t } from '../i18n'

const KEY = 'swiftparcel.welcomed'

const STEPS = [
  { icon: 'box', title: 'welcome.step1', text: 'welcome.step1Text' },
  { icon: 'send', title: 'welcome.step2', text: 'welcome.step2Text' },
  { icon: 'scan', title: 'welcome.step3', text: 'welcome.step3Text' },
  { icon: 'shield', title: 'welcome.step4', text: 'welcome.step4Text' },
]

function seen() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export default function Welcome() {
  const [open, setOpen] = useState(() => !seen())
  const btnRef = useRef(null)

  useEffect(() => {
    if (open) btnRef.current?.focus()
  }, [open])

  if (!open) return null

  function close() {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      // private mode: the screen comes back next time, nothing else breaks
    }
    setOpen(false)
  }

  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="welcome-body">
        <img className="welcome-logo" src="/logo.svg" alt="" width="72" height="72" />
        <h1 id="welcome-title" className="welcome-title">
          SwiftDelivery
        </h1>
        <p className="welcome-lead">{t('welcome.lead')}</p>
        <ol className="welcome-steps">
          {STEPS.map((s) => (
            <li key={s.title} className="welcome-step">
              <span className="welcome-step-icon">
                <Icon name={s.icon} size={20} />
              </span>
              <span>
                <strong>{t(s.title)}</strong>
                <span className="hint">{t(s.text)}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <button ref={btnRef} type="button" className="btn btn-primary welcome-btn" onClick={close}>
        {t('welcome.start')}
      </button>
    </div>
  )
}
