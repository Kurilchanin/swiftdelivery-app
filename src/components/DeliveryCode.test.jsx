// The delivery code pays the courier at once, so it is never on screen by
// default: "Show" opens a warning first, and only the confirmation shows the QR.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import DeliveryCode from './DeliveryCode'
import { openTelegramLink } from '../telegram'

vi.mock('../telegram', async (importOriginal) => ({
  ...(await importOriginal()),
  openTelegramLink: vi.fn(),
}))
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

  it('shows the code as text, copy and send only after the warning', async () => {
    const code = 'ab'.repeat(32)
    await render({ expired: false, courierChat: 'https://t.me/courier' })
    expect(box.textContent).not.toContain(code)
    expect(button(t('order.codeCopy'))).toBeUndefined()
    expect(button(t('order.codeSendTg'))).toBeUndefined()

    await click(t('order.codeShow'))
    expect(box.textContent).not.toContain(code)
    await click(t('order.codeWarnConfirm'))
    expect(box.querySelector('.code-text').textContent).toBe(code)

    const writeText = vi.fn().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await click(t('order.codeCopy'))
    expect(writeText).toHaveBeenCalledWith(code)

    await click(t('order.codeSendTg'))
    expect(openTelegramLink).toHaveBeenLastCalledWith('https://t.me/courier?text=' + code)
  })

  it('without the courier @username it opens the share screen', async () => {
    const code = 'ab'.repeat(32)
    await render({ expired: false, courierChat: null })
    await click(t('order.codeShow'))
    await click(t('order.codeWarnConfirm'))
    await click(t('order.codeSendTg'))
    expect(openTelegramLink).toHaveBeenLastCalledWith('https://t.me/share/url?url=' + code)
  })

  it('after the deadline it explains the late hand-off', async () => {
    await render({ expired: true })
    expect(box.textContent).toContain(t('order.showCodeExpired'))
  })
})
