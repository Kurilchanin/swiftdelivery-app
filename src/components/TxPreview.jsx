// The transaction preview modal. Mounted once in App. It appears whenever
// sendTx() asks for confirmation, and disappears when the user chooses.
import { useEffect, useRef } from 'react'
import { usePendingTx, approveTx, cancelTx } from '../ton/txPreview'
import { sanitizeText } from '../utils/security'
import { t } from '../i18n'

export default function TxPreview() {
  const pending = usePendingTx()
  const dialogRef = useRef(null)
  const continueRef = useRef(null)

  // A real dialog for keyboard and screen-reader users: focus moves to the main
  // button when it opens and back where it was when it closes, Esc backs out,
  // and Tab stays inside the dialog.
  useEffect(() => {
    if (!pending) return
    const before = document.activeElement
    continueRef.current?.focus()
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelTx()
        return
      }
      if (e.key !== 'Tab') return
      const buttons = dialogRef.current?.querySelectorAll('button')
      if (!buttons?.length) return
      const first = buttons[0]
      const last = buttons[buttons.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      before?.focus?.()
    }
  }, [pending])

  if (!pending) return null

  const summary = pending.summary || {}
  const lines = summary.lines || []

  return (
    <div className="modal-overlay" onClick={cancelTx}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tx-title"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="modal-grip" aria-hidden="true" />
        <h2 id="tx-title" className="modal-title">
          {sanitizeText(summary.title || t('tx.confirmTitle'), 80)}
        </h2>
        <dl className="meta">
          {lines.map((l, i) => (
            <div key={i}>
              <dt>{sanitizeText(String(l.label), 60)}</dt>
              {/* bdi: "10 USDT" keeps its order in Persian and Arabic */}
              <dd>
                <bdi className={l.mono ? 'mono' : undefined}>{sanitizeText(String(l.value), 120)}</bdi>
              </dd>
            </div>
          ))}
        </dl>
        <p className="hint">{t('tx.checkDetails')}</p>
        <div className="actions">
          <button ref={continueRef} className="btn btn-primary" onClick={approveTx}>
            {t('tx.continue')}
          </button>
          <button className="btn" onClick={cancelTx}>
            {t('tx.back')}
          </button>
        </div>
      </div>
    </div>
  )
}
