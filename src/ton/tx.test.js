// Tests for retryBridgeOnReturn: after a return to the app, the bridge is
// reopened again and again until one attempt works, and never after stop.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { retryBridgeOnReturn } from './tx'

const opts = { firstDelay: 10, retryDelay: 10, attemptLimit: 50 }

function returnToApp() {
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('retryBridgeOnReturn', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('retries after failures and stops at the first success', async () => {
    const connector = {
      unPauseConnection: vi.fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(),
    }
    const stop = retryBridgeOnReturn(connector, opts)
    returnToApp()
    await vi.advanceTimersByTimeAsync(200)
    expect(connector.unPauseConnection).toHaveBeenCalledTimes(3)
    stop()
  })

  it('treats a hung attempt as failed and tries again', async () => {
    const connector = {
      unPauseConnection: vi.fn()
        .mockReturnValueOnce(new Promise(() => {}))
        .mockResolvedValue(),
    }
    const stop = retryBridgeOnReturn(connector, opts)
    returnToApp()
    await vi.advanceTimersByTimeAsync(200)
    expect(connector.unPauseConnection).toHaveBeenCalledTimes(2)
    stop()
  })

  it('does nothing without a return, and nothing after stop', async () => {
    const connector = { unPauseConnection: vi.fn().mockRejectedValue(new Error('offline')) }
    const stop = retryBridgeOnReturn(connector, opts)
    await vi.advanceTimersByTimeAsync(200)
    expect(connector.unPauseConnection).not.toHaveBeenCalled()
    returnToApp()
    await vi.advanceTimersByTimeAsync(25)
    stop()
    const calls = connector.unPauseConnection.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    returnToApp()
    await vi.advanceTimersByTimeAsync(500)
    expect(connector.unPauseConnection.mock.calls.length).toBe(calls)
  })
})
