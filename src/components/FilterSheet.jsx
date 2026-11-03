// FilterSheet: the Feed's city filter as a bottom sheet. Each side ("To" /
// "From") has a search field and a grid of city tiles, one per city that has at
// least one open order, with the count of those orders.
//
// Pure view control: it owns no city data. The Feed keeps each search text as
// the source of truth (see Feed.jsx); typing edits it, a tile fills it, and the
// "all" tile clears it.
import { useEffect, useRef, useState } from 'react'
import { cityKey } from '../contracts/orders'
import Icon from './Icon'
import { t } from '../i18n'

// One side of the filter.
// options: [{ key, label, count }]; query: the search text; onQuery(text).
function Section({ label, placeholder, allLabel, options, total, query, onQuery }) {
  const q = cityKey(query)
  const shown = q ? options.filter((c) => c.key.includes(q)) : options
  return (
    <section className="sheet-section">
      <h3 className="sheet-label">{label}</h3>
      <label className="search">
        <Icon name="search" size={20} />
        <input
          type="text"
          className="input"
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>
      <div className="city-grid">
        <button
          type="button"
          className="city-tile"
          aria-pressed={q === ''}
          onClick={() => onQuery('')}
        >
          <span className="city-tile-body">
            <span className="city-tile-name">{allLabel}</span>
            <span className="city-tile-count">{total}</span>
          </span>
          {q === '' && <Icon name="check" size={18} />}
        </button>
        {shown.map((c) => {
          const on = c.key === q
          return (
            <button
              key={c.key}
              type="button"
              className="city-tile"
              aria-pressed={on}
              onClick={() => onQuery(c.label)}
            >
              <span className="city-tile-body">
                <span className="city-tile-name">{c.label}</span>
                <span className="city-tile-count">{c.count}</span>
              </span>
              {on && <Icon name="check" size={18} />}
            </button>
          )
        })}
      </div>
    </section>
  )
}

// sections: props for each <Section>; onClose: closes the sheet.
export default function FilterSheet({ sections, onClose }) {
  const sheetRef = useRef(null)
  const drag = useRef(null) // { y0, t0 } while a finger is down on the header
  const [dy, setDy] = useState(0) // how far the sheet is dragged down
  const [dragging, setDragging] = useState(false)

  // Swipe the header (grip + title) down to close: the sheet follows the finger
  // and closes past 100px or on a quick flick; otherwise it springs back.
  function onDown(e) {
    drag.current = { y0: e.clientY, t0: e.timeStamp }
  }
  function onMove(e) {
    const d = drag.current
    if (!d) return
    const dist = e.clientY - d.y0
    // Capture only once it is a real drag, so a plain tap on the grip still clicks it.
    if (!d.moved && Math.abs(dist) > 6) {
      d.moved = true
      setDragging(true)
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    if (d.moved) setDy(Math.max(0, dist))
  }
  function onUp(e) {
    const d = drag.current
    if (!d) return
    drag.current = null
    setDragging(false)
    const dist = e.clientY - d.y0
    const fast = dist / Math.max(1, e.timeStamp - d.t0) > 0.5
    if (dist > 100 || (dist > 30 && fast)) onClose()
    else setDy(0)
  }

  // Focus moves into the sheet when it opens and back when it closes; Esc closes.
  useEffect(() => {
    const before = document.activeElement
    sheetRef.current?.focus()
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      before?.focus?.()
    }
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={sheetRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="filter-title"
        tabIndex={-1}
        style={{
          transform: dy ? `translateY(${dy}px)` : undefined,
          transition: dragging ? 'none' : undefined,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="modal-head"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <button type="button" className="modal-grip" aria-label={t('tx.back')} onClick={onClose} />
          <h2 id="filter-title" className="modal-title">
            {t('feed.filter')}
          </h2>
        </div>
        {sections.map((s) => (
          <Section key={s.label} {...s} />
        ))}
      </div>
    </div>
  )
}
