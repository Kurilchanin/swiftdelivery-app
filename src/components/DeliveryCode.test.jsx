// The delivery code pays the courier at once, so it is never on screen by
// default: "Show" opens a warning first, and only the confirmation shows the QR.
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import DeliveryCode from './DeliveryCode'
import { t } from '../i18n'

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

let root, box
async function render(props) {
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<DeliveryCode secret={'ab'.repeat(32)} {...props} />))
}
afterEach(() => {
  act(() => root.unmount())
  box.remove()
})
const button = (label) => [...box.querySelectorAll('button')].find((b) => b.textContent === label)
const click = (label) => act(async () => button(label).click())
const qrShown = () => box.querySelector('img.qr') !== null

describe('DeliveryCode', () => {
  it('hides the code until the warning is confirmed', async () => {
    await render({ expired: false })
    expect(qrShown()).toBe(false)
    expect(box.textContent).not.toContain(t('order.codeWarn'))

    await click(t('order.codeShow'))
    expect(box.textContent).toContain(t('order.codeWarn'))
    expect(box.querySelector('[role="alert"]')).not.toBeNull()
    expect(qrShown()).toBe(false)

    await click(t('order.codeWarnCancel'))
    expect(button(t('order.codeShow'))).toBeTruthy()
    expect(qrShown()).toBe(false)

    await click(t('order.codeShow'))
    await click(t('order.codeWarnConfirm'))
    await act(async () => new Promise((r) => setTimeout(r, 50))) // the QR is drawn async
    expect(qrShown()).toBe(true)

    await click(t('order.codeHide'))
    expect(qrShown()).toBe(false)
    expect(button(t('order.codeShow'))).toBeTruthy()
  })

  it('after the deadline it explains the late hand-off', async () => {
    await render({ expired: true })
    expect(box.textContent).toContain(t('order.showCodeExpired'))
  })
})
