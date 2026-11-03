// The emulator loads lazily, the first time a confirm / claim needs it. A failed
// load must not stick, or the courier cannot be paid until the app restarts.
import { describe, it, expect, vi } from 'vitest'

const { create } = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@ton/sandbox/dist/executor/Executor', () => ({ Executor: { create } }))

import { getExecutor } from './emulateFee'

describe('getExecutor', () => {
  it('loads the emulator again after a failed load', async () => {
    create.mockRejectedValueOnce(new Error('chunk failed'))
    await expect(getExecutor()).rejects.toThrow('chunk failed')

    create.mockResolvedValueOnce('executor')
    await expect(getExecutor()).resolves.toBe('executor')
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('creates the emulator only once after a good load', async () => {
    await expect(getExecutor()).resolves.toBe('executor')
    expect(create).toHaveBeenCalledTimes(2)
  })
})
